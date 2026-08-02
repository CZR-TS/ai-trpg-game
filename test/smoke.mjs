import { io } from 'socket.io-client';

const BASE = process.env.TRPG_BASE_URL || 'http://127.0.0.1:38571';
const ADMIN_PASSWORD = process.env.TRPG_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('运行集成测试前请设置 TRPG_ADMIN_PASSWORD');
const ADMIN = { username: process.env.TRPG_ADMIN_USERNAME || 'admin', password: ADMIN_PASSWORD };

let pass = 0;
let fail = 0;
function check(name, condition, extra = '') {
  if (condition) { pass++; console.log(`  ✔ ${name} ${extra}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
}

function post(route, body, cookie) {
  return fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
}

function emitAck(client, event, payload = {}) {
  return new Promise((resolve) => client.emit(event, payload, resolve));
}

function waitFor(client, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件 ${event} 超时`)), timeout);
    client.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

function waitForWhere(client, event, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`等待事件 ${event} 条件超时`)), timeout);
    const handler = (data) => { if (predicate(data)) done(null, data); };
    function done(error, value) {
      clearTimeout(timer);
      client.off(event, handler);
      error ? reject(error) : resolve(value);
    }
    client.on(event, handler);
  });
}

function waitForOutcome(client, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('等待回合反馈超时')), timeout);
    const onSummary = (data) => done(null, { type: 'summary', data });
    const onEnded = (data) => done(null, { type: 'ended', data });
    function done(error, value) {
      clearTimeout(timer);
      client.off('game:summary', onSummary);
      client.off('game:ended', onEnded);
      error ? reject(error) : resolve(value);
    }
    client.once('game:summary', onSummary);
    client.once('game:ended', onEnded);
  });
}

async function connectClient() {
  const client = io(BASE, { reconnection: false });
  if (!client.connected) await waitFor(client, 'connect');
  return client;
}

const main = async () => {
  console.log('== 1. 登录与后台边界 ==');
  let response = await post('/api/auth/login', { username: 'admin', password: '错误密码' });
  check('错误密码被拒绝', response.status === 401, `→ ${response.status}`);
  response = await post('/api/auth/login', ADMIN);
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  check('环境变量密码登录成功', response.status === 200 && cookie.startsWith('at='), `→ ${response.status}`);
  response = await fetch(BASE + '/api/admin/worldbooks');
  check('无 cookie 访问后台被拒绝', response.status === 401, `→ ${response.status}`);
  response = await post('/api/admin/worldbooks', {
    id: '../../config/config', name: '越界', content: { entries: {} },
  }, cookie);
  check('世界书路径穿越被拒绝', response.status === 400, `→ ${response.status}`);
  response = await fetch(BASE + '/api/admin/worldbooks', { headers: { Cookie: cookie } });
  const worldbooks = await response.json();
  check('世界书列表可读取', response.status === 200 && worldbooks.worldbooks.some((item) => item.id === 'fantasy-example'));
  response = await post('/api/admin/rooms', { code: 'SAFE2222' }, cookie);
  const room = await response.json();
  check('创建唯一房间码', response.status === 200 && room.code === 'SAFE2222', `→ ${room.code}`);
  const duplicate = await post('/api/admin/rooms', { code: 'SAFE2222' }, cookie);
  check('重复房间码被拒绝', duplicate.status === 400, `→ ${duplicate.status}`);
  const unauthorizedExport = await fetch(BASE + '/api/admin/rooms/' + encodeURIComponent(room.roomId) + '/export');
  check('未登录不能导出当前房间', unauthorizedExport.status === 401, `→ ${unauthorizedExport.status}`);

  console.log('== 2. 双人身份、重连与阶段状态机 ==');
  const playerA = await connectClient();
  let playerB = await connectClient();
  const generationEvents = [];
  playerA.on('game:generation_progress', (progress) => generationEvents.push(progress));
  const joinA = await emitAck(playerA, 'room:join', { roomCode: room.code, name: '阿甲' });
  const openingReadyPromise = waitForWhere(playerA, 'room:state', ({ room: state }) => state.openingStatus === 'ready');
  const joinB = await emitAck(playerB, 'room:join', { roomCode: room.code, name: '阿乙' });
  check('加入响应直接携带房间状态', joinA.room?.code === room.code && joinA.room?.players?.A?.name === '阿甲');
  const openingReady = await openingReadyPromise;
  check('玩家 A/B 通过房间码和昵称加入', joinA.role === 'A' && joinB.role === 'B');
  const duplicateNameClient = await connectClient();
  const duplicateName = await emitAck(duplicateNameClient, 'room:join', { roomCode: room.code, name: '阿乙' });
  check('在线昵称不能被其他连接顶号', duplicateName.ok === false);
  duplicateNameClient.close();
  check('两名玩家到齐后自动预加载开场', openingReady.room.openingStatus === 'ready');
  check('固定世界背景无需重复调用 AI 生成',
    !generationEvents.some((item) => item.kind === 'opening'));
  const secondJoin = await emitAck(playerA, 'room:join', { roomCode: room.code, name: '重复' });
  check('同一连接不能重复加入', secondJoin.ok === false);
  const leftPromise = waitFor(playerA, 'player:left');
  playerB.close();
  await leftPromise;
  playerB = await connectClient();
  const rejoinB = await emitAck(playerB, 'room:join', { roomCode: room.code, name: '阿乙' });
  check('等待阶段退出后可用同名重新加入', rejoinB.ok && rejoinB.role === 'B');

  await emitAck(playerA, 'room:ready');
  await emitAck(playerB, 'room:ready');
  const guestStart = await emitAck(playerB, 'game:start');
  check('非房主不能开始游戏', guestStart.ok === false);
  const introPromise = waitFor(playerA, 'game:intro');
  const startResult = await emitAck(playerA, 'game:start');
  const intro = await introPromise;
  check('房主开始并收到开场介绍', startResult.ok && intro.round === 1 && typeof intro.intro?.world === 'string');

  const chatForA = waitFor(playerA, 'chat:message');
  const chatForB = waitFor(playerB, 'chat:message');
  const sentChat = await emitAck(playerA, 'chat:send', { text: '这条消息在断线重连后也要保留' });
  const [receivedByA, receivedByB] = await Promise.all([chatForA, chatForB]);
  check('房间聊天实时广播给双方',
    sentChat.ok && receivedByA.message?.id === receivedByB.message?.id
      && receivedByB.message?.text === '这条消息在断线重连后也要保留');
  const tooLongChat = await emitAck(playerA, 'chat:send', { text: '字'.repeat(301) });
  check('超长聊天消息被服务端拒绝', tooLongChat.ok === false);

  const disconnectedPromise = waitFor(playerA, 'player:disconnected');
  playerB.close();
  await disconnectedPromise;
  playerB = await connectClient();
  const resumedIntroPromise = waitFor(playerB, 'game:intro');
  const resumedChatHistoryPromise = waitFor(playerB, 'chat:history');
  const sameNameReconnect = await emitAck(playerB, 'room:join', { roomCode: room.code, name: '阿乙' });
  await resumedIntroPromise;
  const resumedChatHistory = await resumedChatHistoryPromise;
  check('游戏开始后也可用同名认领离线席位', sameNameReconnect.ok && sameNameReconnect.role === 'B' && sameNameReconnect.reconnected === true);
  check('玩家断线重连后恢复完整聊天记录',
    sameNameReconnect.chatMessages?.some((message) => message.text === '这条消息在断线重连后也要保留')
      && resumedChatHistory.messages?.some((message) => message.text === '这条消息在断线重连后也要保留'));

  const premature = await emitAck(playerA, 'game:choice', { choiceId: '继续前行' });
  check('开场确认前不能提前提交', premature.ok === false);

  const profileGate = await emitAck(playerA, 'game:next');
  check('双方完成角色资料前不能开始冒险', profileGate.ok === false);
  const invalidProfile = await emitAck(playerA, 'game:profile', {
    displayName: 'x'.repeat(33),
  });
  check('超长剧情昵称被拒绝', invalidProfile.ok === false);
  const profileA = await emitAck(playerA, 'game:profile', {
    displayName: '星岚', gender: '女', personality: '沉着果断', details: '擅长辨认古老文字',
  });
  const profileStatePromise = waitForWhere(playerA, 'room:state', ({ room: state }) =>
    state.players.A?.name === '星岚' && state.players.B?.name === '烬川'
  );
  const profileB = await emitAck(playerB, 'game:profile', {
    displayName: '烬川', gender: '男', personality: '谨慎敏锐', details: '随身携带破损罗盘',
  });
  const profileState = await profileStatePromise;
  check('双方可保存剧情昵称与角色资料',
    profileA.ok && profileB.ok
      && profileState.room.players.A.profile?.personality === '沉着果断'
      && profileState.room.players.B.profileReady === true);

  const profileDisconnectPromise = waitFor(playerA, 'player:disconnected');
  playerB.close();
  await profileDisconnectPromise;
  playerB = await connectClient();
  const profileResumeIntro = waitFor(playerB, 'game:intro');
  const profileResumeState = waitForWhere(playerB, 'room:state', ({ room: state }) => state.players.B?.name === '烬川');
  const profileReconnect = await emitAck(playerB, 'room:join', { roomCode: room.code, name: '阿乙' });
  await profileResumeIntro;
  const resumedProfileState = await profileResumeState;
  check('改剧情昵称后仍用原入场昵称重连且资料不丢失',
    profileReconnect.ok && profileReconnect.reconnected === true
      && resumedProfileState.room.players.B.profile?.details === '随身携带破损罗盘');

  const nextA = await emitAck(playerA, 'game:next');
  const firstRoundPromise = waitFor(playerA, 'game:round');
  const nextB = await emitAck(playerB, 'game:next');
  let current = await firstRoundPromise;
  check('双方确认后进入首轮', nextA.ok && nextB.ok && current.round === 1);
  check('首轮叙事包含自然分段和安全粗体标记',
    current.narrative.includes('\n\n') && current.narrative.includes('**前方岔路**'));
  const activeExportResponse = await fetch(BASE + '/api/admin/rooms/' + encodeURIComponent(room.roomId) + '/export', {
    headers: { Cookie: cookie },
  });
  const activeExportText = await activeExportResponse.text();
  check('后台可导出进行中房间的 Markdown 故事',
    activeExportResponse.status === 200
      && activeExportResponse.headers.get('content-type')?.startsWith('text/markdown')
      && activeExportResponse.headers.get('content-disposition')?.includes('attachment')
      && activeExportText.includes('# 共叙故事：SAFE2222')
      && activeExportText.includes('## 世界背景')
      && activeExportText.includes('### 第 1 回合（当前）'));
  const invalidChoice = await emitAck(playerA, 'game:choice', { choiceId: 'x'.repeat(201) });
  check('超长自由行动被拒绝', invalidChoice.ok === false);

  let ending = null;
  for (let guard = 0; guard < 8 && !ending; guard++) {
    const actionA = guard === 7 ? '结束这场冒险，进入最终结局' : current.choices_A[0];
    const choiceA = await emitAck(playerA, 'game:choice', { choiceId: actionA });
    const repeated = await emitAck(playerA, 'game:choice', { choiceId: actionA });
    const choiceB = await emitAck(playerB, 'game:choice', { choiceId: current.choices_B[0] });
    check(`第${current.round}回合合法提交且禁止重复`, choiceA.ok && choiceB.ok && repeated.ok === false);
    const outcomePromise = waitForOutcome(playerA);
    const preloadStatusPromise = guard === 0 ? waitFor(playerA, 'game:preload_status') : null;
    const advanceStartedPromise = guard === 0 ? waitFor(playerB, 'game:advance_started') : null;
    const advance = await emitAck(playerA, 'game:advance');
    check(`第${current.round}回合推进`, advance.ok);
    if (advanceStartedPromise) {
      await advanceStartedPromise;
      check('任意一方开始结算后双方立即同步正在推进状态', true);
    }
    const outcome = await outcomePromise;
    if (outcome.type === 'ended') {
      ending = outcome.data;
      break;
    }
    check(`第${current.round}回合收到结果反馈`, typeof outcome.data.summary === 'string');
    if (preloadStatusPromise) {
      const preloadStatus = await preloadStatusPromise;
      check('无人点击下一步时后台已完成下一回合预加载', preloadStatus.status === 'ready');
    }
    await emitAck(playerA, 'game:next');
    const roundPromise = waitFor(playerA, 'game:round');
    const proceed = await emitAck(playerB, 'game:next');
    check(`第${current.round}回合双方确认下一步`, proceed.ok);
    current = await roundPromise;
  }
  check('游戏最终到达结局', !!ending?.ending?.title, ending ? `→ ${ending.ending.title}` : '');
  check('真实结局事件包含本局回顾', Array.isArray(ending?.ending?.history) && ending.ending.history.length > 0);
  const historyResponse = await fetch(BASE + '/api/admin/rooms/history', { headers: { Cookie: cookie } });
  const historyBody = await historyResponse.json();
  const saved = historyBody.history?.find((item) => item.code === room.code);
  check('后台历史接口返回已结束房间', historyResponse.status === 200 && saved?.history?.length > 0);
  check('房间结束后聊天不进入永久历史记录', saved && !('chatMessages' in saved));
  check('历史存储上限固定为 200MB', historyBody.storage?.limitBytes === 200 * 1024 * 1024);
  check('历史存储用量和单条文件大小可统计', saved?.fileBytes > 0 && historyBody.storage?.usedBytes >= saved.fileBytes);
  const activeResponse = await fetch(BASE + '/api/admin/rooms', { headers: { Cookie: cookie } });
  const historyExportResponse = await fetch(BASE + '/api/admin/rooms/history/' + encodeURIComponent(saved.id) + '/export', {
    headers: { Cookie: cookie },
  });
  const historyExportText = await historyExportResponse.text();
  check('后台可导出历史记录的完整 Markdown 故事',
    historyExportResponse.status === 200
      && historyExportText.includes('## 角色资料')
      && historyExportText.includes('## 故事正文')
      && historyExportText.includes('## 世界背景')
      && historyExportText.includes('## 结局')
      && !historyExportText.includes('_private'));
  const activeBody = await activeResponse.json();
  check('已结束房间不再混入当前房间列表', !activeBody.rooms?.some((item) => item.code === room.code));

  const deleteResponse = await fetch(BASE + '/api/admin/rooms/history/' + encodeURIComponent(saved.id), {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  const deleteBody = await deleteResponse.json();
  check('管理员可手动删除指定历史记录', deleteResponse.status === 200 && deleteBody.ok === true);
  const afterDeleteResponse = await fetch(BASE + '/api/admin/rooms/history', { headers: { Cookie: cookie } });
  const afterDeleteBody = await afterDeleteResponse.json();
  check('只删除本次测试记录并更新存储用量',
    !afterDeleteBody.history?.some((item) => item.id === saved.id)
      && afterDeleteBody.storage?.usedBytes <= historyBody.storage?.usedBytes);
  playerA.close();
  playerB.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch((error) => {
  console.error('测试异常：', error);
  process.exit(1);
});
