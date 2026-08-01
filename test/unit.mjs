import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import * as game from '../server/game.js';
import { activateEntries, loadWorldbookFile } from '../server/lorebook.js';
import { buildHistoryText, buildSystemPrompt, callAI, completedJsonFields, normalizeNarrativeText, normalizeNode } from '../server/llm.js';
import { buildStoryMarkdown, storyExportFilename } from '../server/story-export.js';

const config = {
  ai: { baseURL: '', apiKey: '', model: '', temperature: 0, maxTokens: 100 },
  game: { scanDepth: 4, worldbookTokenBudget: 1500, historyRounds: 6 },
};
const character = game.loadCharacterCard(path.resolve('worldbook/examples/fantasy-example/dm_character.json'));

game.initWorldbookStore();
const room = game.createRoom({ worldbookId: 'fantasy-example', roomCodeLen: 10 });
assert.ok(room.worldbook?.entries?.length, '房间必须持有已加载世界书');
assert.equal(room.code.length, 10, '房间码长度配置应生效');
assert.throws(() => game.createRoom({ worldbookId: 'fantasy-example', code: room.code }), /已存在/);
assert.throws(() => game.importWorldbook({ id: '..\/..\/config\/config', content: { entries: {} } }), /id/);
assert.throws(
  () => game.importWorldbook({ id: 'missing-opening-test', content: { entries: {} } }),
  /opening_background/,
  '所有导入世界书都必须提供固定开场背景'
);
assert.equal(game.isEndingRequested('继续调查遗迹', '守住入口'), false, '普通行动不得触发结局');
assert.equal(game.isEndingRequested('我不想结束故事', '继续前进'), false, '否定结束意图不得触发结局');
assert.equal(game.isEndingRequested('结束这场冒险，进入最终结局', '向同伴告别'), true, '玩家明确提出结束时才允许结局');

room.players.A = { name: 'A', ready: true, token: 'a', sockId: null };
room.players.B = { name: 'B', ready: true, token: 'b', sockId: null };
const opening = await game.startRoom(room, config, character);
assert.equal(room.status, 'playing');
assert.equal(room.progress, 0, '角色塑造阶段不应提前增加故事进度');
assert.equal(opening.intro.world, room.worldbook.opening_background, '开场必须直接使用世界书固定背景');
assert.equal(opening.choices_A.length, 0, '角色创建前不应调用 AI 生成选项');
const chatMessage = game.appendRoomChat(room, 'A', '先检查门后的脚印');
assert.equal(chatMessage.role, 'A', '聊天消息必须记录发送者角色');
assert.equal(game.roomChatHistory(room)[0].text, '先检查门后的脚印', '进行中房间必须保留聊天记录');
assert.equal('chatMessages' in game.publicRoomView(room), false, '聊天记录不得混入 room:state 公开快照');
assert.throws(() => game.appendRoomChat(room, 'A', '字'.repeat(301)), /300 字/, '聊天消息必须限制长度');
const chatSnapshot = JSON.parse(await readFile(path.resolve('data/room-active', room.id + '.json'), 'utf8'));
assert.equal(chatSnapshot.chatMessages[0].id, chatMessage.id, '聊天记录必须写入进行中房间磁盘快照');
game.clearRoomChat(room);
assert.deepEqual(game.roomChatHistory(room), [], '房间结束清理必须能移除全部聊天记录');
game.updatePlayerProfile(room, 'A', { displayName: 'A' });
game.updatePlayerProfile(room, 'B', { displayName: 'B' });
const firstRound = (await game.proceedNext(room, config, character)).node;
assert.ok(firstRound.choices_A.length && firstRound.choices_B.length);

room.chosen = { A: firstRound.choices_A[0], B: firstRound.choices_B[0] };
room.submitted = { A: true, B: true };
const previousHistoryLength = room.history.length;
const savedWorldbook = room.worldbook;
room.worldbook = null;
await assert.rejects(() => game.advanceRoom(room, config, character));
assert.equal(room.history.length, previousHistoryLength, '推进失败不能提前归档');
assert.equal(room.processing, false, '推进失败必须释放处理锁');
room.worldbook = savedWorldbook;

const preloadRoom = game.createRoom({ worldbookId: 'fantasy-example' });
preloadRoom.players.A = { name: '预载甲', ready: true, sockId: null };
preloadRoom.players.B = { name: '预载乙', ready: true, sockId: null };
const preloadOpening = await game.startRoom(preloadRoom, config, character);
assert.equal(preloadOpening.intro.world, preloadRoom.worldbook.opening_background);
game.updatePlayerProfile(preloadRoom, 'A', { displayName: '预载甲' });
game.updatePlayerProfile(preloadRoom, 'B', { displayName: '预载乙' });
const preloadFirstRound = (await game.proceedNext(preloadRoom, config, character)).node;
preloadRoom.chosen = { A: preloadFirstRound.choices_A[0], B: preloadFirstRound.choices_B[0] };
preloadRoom.submitted = { A: true, B: true };
preloadRoom.progress = 1;
const preloadSummary = await game.advanceRoom(preloadRoom, config, character);
assert.equal(preloadSummary.type, 'summary');
assert.equal(preloadRoom.status, 'playing', '故事进度达到 100% 不能自动结束游戏');
assert.equal(preloadRoom.phase, 'summary');
assert.deepEqual(preloadRoom.nextConfirm, { A: false, B: false }, '无人点击下一步时也应开始预加载');
assert.ok(preloadRoom.nextRoundPromise || preloadRoom.nextRoundNode, '反馈生成后必须立即存在下一回合预加载任务');
const prefetchedNode = preloadRoom.nextRoundNode || await preloadRoom.nextRoundPromise;
assert.ok(prefetchedNode?.narrative, '下一回合应在反馈阅读期间完成生成');
assert.equal(prefetchedNode.story_state.A.name, '预载甲', '预加载节点必须使用真实昵称');
preloadRoom.worldbook = null;
const reusedNext = await game.proceedNext(preloadRoom, config, character);
assert.equal(reusedNext.node, prefetchedNode, '双方确认时必须复用预加载结果，不能再次请求 AI');

const introRoom = game.createRoom({ worldbookId: 'fantasy-example' });
introRoom.players.A = { name: '确认甲', ready: true, sockId: null };
introRoom.players.B = { name: '确认乙', ready: true, sockId: null };
await game.startRoom(introRoom, config, character);
const profileA = game.updatePlayerProfile(introRoom, 'A', {
  displayName: '星岚', gender: '女', personality: '沉着果断', details: '擅长辨认古老文字',
});
game.updatePlayerProfile(introRoom, 'B', {
  displayName: '烬川', gender: '男', personality: '谨慎敏锐', details: '随身携带破损罗盘',
});
assert.equal(profileA.displayName, '星岚', '角色塑造应允许设置剧情昵称');
assert.equal(introRoom.players.A.name, '确认甲', '修改剧情昵称不能覆盖用于重连的身份昵称');
assert.equal(game.publicRoomView(introRoom).players.A.name, '星岚', '玩家视图应展示剧情昵称');
const reclaimed = game.joinRoom(introRoom.code, '确认甲');
assert.equal(reclaimed.role, 'A', '改名后仍应使用原入场昵称认领离线席位');
assert.equal(reclaimed.reconnected, true, '原身份昵称必须保持可重连');
assert.throws(() => game.joinRoom(introRoom.code, '星岚'), /原玩家昵称/, '剧情昵称不能替代身份昵称重连');
assert.throws(() => game.updatePlayerProfile(introRoom, 'B', { displayName: '星岚' }), /不能与对方相同/);

assert.equal(game.confirmNext(introRoom, 'A'), false);
let activeSnapshot = JSON.parse(await readFile(
  path.resolve('data/room-active', introRoom.id + '.json'), 'utf8'
));
assert.equal(activeSnapshot.nextConfirm.A, true, '单方确认必须立即写入进行中存档');
assert.equal(activeSnapshot.players.A.name, '确认甲', '进行中存档必须保留身份昵称');
assert.equal(activeSnapshot.players.A.displayName, '星岚', '进行中存档必须保留剧情昵称');
assert.equal(activeSnapshot.players.A.profile.personality, '沉着果断', '进行中存档必须保留角色资料');
assert.equal(activeSnapshot.players.A.profileReady, true, '进行中存档必须记录角色资料完成状态');
game.confirmNext(introRoom, 'B');
await game.proceedNext(introRoom, config, character);
activeSnapshot = JSON.parse(await readFile(
  path.resolve('data/room-active', introRoom.id + '.json'), 'utf8'
));
assert.equal(activeSnapshot.phase, 'round', '开场进入首轮后必须保存新阶段');
assert.deepEqual(activeSnapshot.nextConfirm, { A: false, B: false }, '进入首轮后确认状态必须重置');

const historyBeforeArchive = introRoom.history.length;
game.archiveCurrentRound(introRoom);
assert.equal(introRoom.history.length, historyBeforeArchive + 1, '中途结束必须归档当前叙事');
game.archiveCurrentRound(introRoom);
assert.equal(introRoom.history.length, historyBeforeArchive + 1, '重复归档不能复制当前叙事');

const brokenRoom = game.createRoom({ worldbookId: 'fantasy-example' });
brokenRoom.worldbook = null;
await assert.rejects(() => game.startRoom(brokenRoom, config, character));
assert.equal(brokenRoom.status, 'waiting', '开局失败必须保持可重试状态');

const normalized = normalizeNode({
  narrative: '测试', choices_A: [{ bad: true }, ' 有效 '], choices_B: [42], story_state: null,
}, { choicesA: ['后备A'], choicesB: ['后备B'], storyState: { flag: true } });
assert.deepEqual(normalized.choices_A, ['有效']);
assert.deepEqual(normalized.choices_B, ['（自由行动）']);

const partialReply = '{"narrative":"第一段","choices_A":["前进"],"choices_B":["等待"],"story_state":{"A":{"hp":9}}}';
assert.deepEqual(
  completedJsonFields(partialReply, ['narrative', 'choices_A', 'choices_B', 'story_state']),
  ['narrative', 'choices_A', 'choices_B', 'story_state'],
  '流式 JSON 必须按实际闭合字段报告完成项'
);

const originalFetch = globalThis.fetch;
let streamedRequestBody = null;
const streamProgress = [];
try {
  globalThis.fetch = async (url, options) => {
    streamedRequestBody = JSON.parse(options.body);
    const events = [
      { choices: [{ delta: { reasoning_content: '推演' }, finish_reason: null }] },
      { choices: [{ delta: { content: '{"narrative":"故事",' }, finish_reason: null }] },
      { choices: [{ delta: { content: '"choices_A":["前进"],"choices_B":["等待"],"story_state":{}}' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40 } },
    ].map((item) => 'data: ' + JSON.stringify(item)).concat('data: [DONE]').join('\n\n') + '\n\n';
    return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const streamed = await callAI(
    { ai: { baseURL: 'https://api.deepseek.com', apiKey: 'test-only', model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 1024, timeoutMs: 5000 } },
    [{ role: 'user', content: '输出 JSON' }],
    {
      jsonMode: true,
      sectionKeys: ['narrative', 'choices_A', 'choices_B', 'story_state'],
      onProgress: (progress) => streamProgress.push(progress),
    }
  );
  assert.equal(streamed, '{"narrative":"故事","choices_A":["前进"],"choices_B":["等待"],"story_state":{}}');
  assert.equal(streamedRequestBody.stream, true, 'DeepSeek 请求必须启用 SSE 流式返回');
  assert.deepEqual(streamedRequestBody.stream_options, { include_usage: true }, '流式请求必须要求最终 usage');
  assert.deepEqual(streamedRequestBody.response_format, { type: 'json_object' }, '游戏生成必须启用 JSON 输出模式');
  assert.ok(streamProgress.some((item) => item.phase === 'thinking' && item.reasoningChars > 0), '必须真实报告模型推演状态');
  assert.ok(streamProgress.some((item) => item.phase === 'receiving' && item.contentChars > 0), '必须真实报告已接收字符数');
  assert.ok(streamProgress.some((item) => item.completedFields?.length === 4), '必须真实报告完整结构项数量');
  assert.equal(streamProgress.findLast((item) => item.usage)?.usage.prompt_cache_hit_tokens, 80, '必须读取 DeepSeek 缓存命中 Token');
} finally {
  globalThis.fetch = originalFetch;
}

const aiFailureRoom = game.createRoom({ worldbookId: 'fantasy-example' });
aiFailureRoom.players.A = { name: '失败甲', ready: true, sockId: null };
aiFailureRoom.players.B = { name: '失败乙', ready: true, sockId: null };
await game.startRoom(aiFailureRoom, config, character);
game.updatePlayerProfile(aiFailureRoom, 'A', { displayName: '失败甲' });
game.updatePlayerProfile(aiFailureRoom, 'B', { displayName: '失败乙' });
let failedFetches = 0;
try {
  globalThis.fetch = async () => {
    failedFetches += 1;
    throw new Error('模拟接口超时');
  };
  await assert.rejects(
    () => game.proceedNext(aiFailureRoom, {
      ...config,
      ai: { baseURL: 'https://example.invalid', apiKey: 'test-only', model: 'test', temperature: 0, maxTokens: 1024, timeoutMs: 5000 },
    }, character),
    /AI 请求失败，请重试/
  );
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(failedFetches, 3, '真实 AI 调用失败时应自动尝试三次');
assert.equal(aiFailureRoom.phase, 'intro', '重试失败后必须停留在原阶段，不能写入演示回合');
assert.equal(aiFailureRoom.progress, 0, '重试失败后不得增加故事进度');
assert.equal(aiFailureRoom.generationProgress, null, '失败任务不得残留为房间当前生成状态');
assert.deepEqual(normalized.story_state, { flag: true });
assert.match(buildHistoryText([{ round: 1, narrative: 'n', choiceA: 'a', choiceB: 'b', storyState: { hp: 9 } }], 6), /"hp":9/);
assert.equal(
  normalizeNarrativeText('第一段。\\n\\n第二段包含 **关键线索**。'),
  '第一段。\n\n第二段包含 **关键线索**。',
  '转义换行必须统一为自然段'
);
const longNarrative = Array.from({ length: 70 }, (_, index) => `第${index + 1}句。`).join('');
assert.match(normalizeNarrativeText(longNarrative), /\n\n/, '旧的超长单段叙事必须按完整句子补充分段');
assert.equal(
  normalizeNarrativeText('<script>alert(1)</script>\n\n**遗迹**苏醒。'),
  '<script>alert(1)</script>\n\n**遗迹**苏醒。',
  '文本规范化不能执行或吞掉 HTML 字样'
);
assert.match(buildSystemPrompt(character), /仅用 \*\*重点文字\*\*/, 'AI 提示词必须要求少量 Markdown 粗体');
assert.match(buildSystemPrompt(character), /转义换行符 \\n\\n 分段/, 'AI 提示词必须要求自然分段');
assert.match(buildSystemPrompt(character), /玩家正文与内部状态边界/, '提示词必须明确隔离玩家正文与系统内部状态');
assert.match(buildSystemPrompt(character), /禁止在正文中使用系统总结口吻宣布/, '玩家正文不得直接展示关系、目标或进度等系统结论');
assert.match(buildSystemPrompt(character), /narrative 通常写 3-5 个自然段、约 450-800 个中文字符/, '每回合叙事必须提供更充分的信息量');
assert.match(buildSystemPrompt(character), /summary 通常写 3-4 个自然段、约 300-550 个中文字符/, '回合反馈必须提供更充分的结果信息');
const concisePrompt = buildSystemPrompt(character);
assert.match(concisePrompt, /全局文风·中度简洁/, 'AI 提示词必须固定使用中度简洁文风');
assert.match(concisePrompt, /动作与事实优先/, '中度简洁文风必须要求优先描写动作与结果');
assert.match(concisePrompt, /禁止连续堆叠同义或近义形容词/, '中度简洁文风必须禁止形容词堆叠');
assert.match(concisePrompt, /summary 必须直接写清双方行动、成败、代价、新信息和局面变化/, '回合反馈必须直接陈述有效信息');
const exportedStory = buildStoryMarkdown({
  code: 'SAFE2222',
  worldbookId: 'fantasy-example',
  status: 'ended',
  progress: 1,
  createdAt: 1767225600000,
  intro: {
    world: '大陆被 **迷雾** 笼罩。',
    roleA: '来自北境的调查者。',
    roleB: '守护古塔的旅人。',
  },
  endedAt: 1767229200000,
  players: { A: '星*岚', B: '烬川' },
  playerProfiles: { A: { gender: '女', personality: '沉着', details: '识字' } },
  history: [{
    round: 1,
    narrative: '<script>alert(1)</script>\n\n发现 **王冠**。',
    choiceA: '调查[王冠]',
    choiceB: '守住入口',
    storyState: { _private: { secret: true }, flags: { hidden: true } },
  }],
  ending: { title: '归来', text: '秘密被揭开。' },
}, { worldbookName: '测试世界' });
assert.match(exportedStory, /^# 共叙故事：SAFE2222/m, '导出文件必须包含房间标题');
assert.match(exportedStory, /## 角色资料[\s\S]*性格.*沉着/, '导出文件必须包含角色资料');
assert.match(exportedStory, /## 世界背景[\s\S]*\*\*迷雾\*\*/, '导出文件必须包含世界背景');
assert.match(exportedStory, /开场介绍[\s\S]*来自北境的调查者/, '导出文件必须包含开场角色介绍');
assert.match(exportedStory, /### 第 1 回合[\s\S]*发现 \*\*王冠\*\*/, '导出文件必须保留故事段落与粗体');
assert.match(exportedStory, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, '导出文件必须将叙事 HTML 转为普通文字');
assert.match(exportedStory, /## 结局[\s\S]*归来/, '导出文件必须包含结局');
assert.doesNotMatch(exportedStory, /_private|hidden|storyState/, '导出文件不得包含内部状态');
assert.equal(storyExportFilename('A/B?C'), '共叙-ABC.md', '导出文件名必须移除不安全字符');


const organizedState = game.organizeStoryState({
  A: { name: '玩家A', hp: 100, 位置: '城门', 背包: ['弓'], flag_awareness: 1 },
  B: { name: '玩家B', hp: 90, 位置: '城门', 背包: ['书'], flag_faith: 48 },
  flags: { 门已开启: true },
}, { A: { name: '阿甲' }, B: { name: '阿乙' } });
assert.equal(organizedState.A.name, '阿甲', '后端必须覆盖 AI 生成的占位姓名');
assert.equal(organizedState.B.name, '阿乙', '后端必须保留真实玩家昵称');
assert.equal(organizedState.shared.位置, '城门', '双方相同的公共位置应提升到 shared');
assert.equal('位置' in organizedState.A, false, '公共字段不应在个人状态重复');
const viewA = game.playerStoryStateView({
  A: { ...organizedState.A, _private: { 秘密线索: ['暗门'] } },
  B: { ...organizedState.B, 魔能: 40, _public: { 外观: '负伤' } },
  shared: organizedState.shared,
  flags: organizedState.flags,
}, 'A');
assert.deepEqual(viewA.A.背包, ['弓'], '本人应看到自己的完整背包');
assert.deepEqual(viewA.A.秘密线索, ['暗门'], '本人应看到自己的私密字段');
assert.equal(viewA.A.flag_awareness, undefined, '内部 flag 不应展示给玩家');
assert.equal(viewA.B.背包, undefined, '对方背包必须隐藏');
assert.equal(viewA.B.魔能, undefined, '未声明公开的对方数值必须隐藏');
assert.equal(viewA.B.外观, '负伤', 'AI 明确声明的公开字段应展示');
assert.equal(viewA.flags, undefined, '全局剧情 flags 不应发送到玩家状态视图');

const grouped = {
  recursive_scanning: true,
  entries: [
    { uid: 1, key: ['start'], content: 'next', probability: 100, group: '', groupWeight: 100, order: 1 },
    { uid: 2, key: ['next'], content: 'one', probability: 100, group: 'g', groupWeight: 100, order: 2 },
    { uid: 3, key: ['next'], content: 'two', probability: 100, group: 'g', groupWeight: 100, order: 3 },
  ].map((entry) => ({
    ...entry, constant: false, disable: false, selective: false, keysecondary: [], caseSensitive: false,
    matchWholeWords: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
  })),
};
const activated = activateEntries(grouped, 'start', { budget: 1000, maxRecursion: 3 });
assert.equal(activated.filter((entry) => entry.group === 'g').length, 1, '递归期间同组仍只能激活一条');

const loaded = loadWorldbookFile(path.resolve('worldbook/examples/fantasy-example/worldbook.json'));
assert.equal(loaded.scan_depth, 4);
assert.equal(loaded.token_budget, 2000);
assert.match(loaded.opening_background, /艾尔登大陆/, '世界书必须加载固定开场背景');
const xuanhuanWorldbook = loadWorldbookFile(path.resolve('worldbook/examples/xuanhuan-example/worldbook.json'));
assert.ok(xuanhuanWorldbook.opening_background.length > 600, '玄幻世界书固定开场必须提供足够完整的世界信息');
assert.match(xuanhuanWorldbook.opening_background, /五域[\s\S]*修行者[\s\S]*魔渊[\s\S]*先天至宝/, '玄幻开场必须覆盖地理、修炼体系与核心危机');
const worldbookSchema = JSON.parse(await readFile(path.resolve('worldbook/schema.json'), 'utf8'));
assert.ok(worldbookSchema.required.includes('opening_background'), '世界书 Schema 必须强制固定开场背景字段');
assert.equal(worldbookSchema.properties.opening_background.minLength, 1, '固定开场背景不得为空字符串');
assert.match(worldbookSchema.properties.opening_background.description, /地理\/社会[\s\S]*力量体系[\s\S]*当前危机/, 'Schema 必须说明固定开场的最低信息范围');
const worldbookTemplate = JSON.parse(await readFile(path.resolve('worldbook/template.json'), 'utf8'));
assert.match(worldbookTemplate.opening_background, /4-6 个自然段[\s\S]*普通人[\s\S]*隐藏真相/, '世界书模板必须明确开场完整度与公开信息边界');
const dmCharacterTemplate = JSON.parse(await readFile(path.resolve('worldbook/dm_character.template.json'), 'utf8'));
assert.match(dmCharacterTemplate.system_prompt, /narrative通常写3-5个自然段[\s\S]*summary通常写3-4个自然段/, 'DM模板必须继承统一的回合信息量要求');
assert.match(dmCharacterTemplate.system_prompt, /只写角色能够看到[\s\S]*story_state\/shared\/flags/, 'DM模板必须继承玩家正文与后台状态边界');

const pageHtml = await readFile(path.resolve('public/index.html'), 'utf8');
const pageCss = await readFile(path.resolve('public/css/style.css'), 'utf8');
const pageUi = await readFile(path.resolve('public/js/ui.js'), 'utf8');
const pageClient = await readFile(path.resolve('public/js/client.js'), 'utf8');
const pageApp = await readFile(path.resolve('public/js/app.js'), 'utf8');
const gameServer = await readFile(path.resolve('server/game.js'), 'utf8');
const socketServer = await readFile(path.resolve('server/index.js'), 'utf8');
const deployUpdate = await readFile(path.resolve('deploy/update.sh'), 'utf8');
assert.match(pageHtml, /id="theme-toggle"[^>]+data-action="theme-toggle"/, '顶部必须提供主题切换按钮');
assert.match(pageHtml, /<button class="brand"[\s\S]*?<span>共叙<\/span>/, '顶部品牌必须包含“共叙”文字');
assert.doesNotMatch(pageCss, /\.brand\s+span\s*\{[^}]*display\s*:\s*none/, '移动端不能再隐藏品牌文字');
assert.match(pageCss, /:root\[data-theme='dark'\]/, '样式表必须包含暗色主题变量');
assert.match(pageCss, /\.topbar-actions\s*\{/, '顶部操作区必须为品牌和主题按钮预留布局');
assert.match(pageApp, /localStorage\.setItem\(THEME_KEY, next\)/, '主题选择必须写入本地存储');
assert.match(pageApp, /dark \? 'sun' : 'moon'/, '主题按钮必须使用 Lucide 的太阳/月亮图标');
assert.match(pageHtml, /style\.css\?v=20260801-24/, '本轮界面更新后必须刷新静态资源版本');
assert.match(pageHtml, /入场昵称尽量独特[\s\S]*重连时仍用此昵称[\s\S]*剧情昵称不同/, '玩家入口必须用两行短句解释身份昵称');
assert.match(pageCss, /\.offline-banner\[hidden\]\s*\{\s*display:\s*none/, '未离线时不得显示空的警告横幅');
assert.match(pageApp, /async \(event\)[\s\S]*client\.saveProfile/, '开场页必须提供角色资料保存交互');
assert.doesNotMatch(pageApp, /入场昵称只用于身份重连/, '角色塑造卡片不应重复显示身份昵称说明');
assert.match(pageCss, /\.profile-form\s*\{/, '角色塑造表单必须有独立布局');
assert.match(pageUi, /renderRichText\(node, value\)/, '前端必须提供统一的安全叙事渲染器');
assert.match(pageUi, /document\.createTextNode/, '叙事内容必须通过文本节点渲染，不能直接信任 AI HTML');
assert.match(pageUi, /UI\.el\('strong', \{ text: match\[1\] \}\)/, '安全渲染器必须支持 Markdown 粗体');
assert.match(pageApp, /UI\.renderRichText\(worldText/, '世界背景必须使用统一叙事渲染器');
assert.match(pageApp, /UI\.renderRichText\(endingText/, '结局必须使用统一叙事渲染器');
assert.doesNotMatch(pageApp, /action === 'goto-(?:admin|player)'[\s\S]{0,120}leaveCurrentRoom/, '顶部工作区切换不能离开玩家房间');
assert.match(pageApp, /WORKSPACE_KEY = 'trpg_workspace_v1'/, '当前工作区必须本地记忆');
assert.match(pageApp, /管理员登录态与玩家房间态分别恢复/, '刷新时必须分别恢复两个工作区');
assert.match(pageApp, /if \(isAdminView\(state\.view\)\) return/, '后台收到玩家事件时不能被强制切回游戏页');

assert.match(pageApp, /downloadStory\(room, false\)/, '当前房间必须提供故事导出按钮');
assert.match(pageApp, /downloadStory\(record, true\)/, '历史记录必须提供故事导出按钮');
assert.match(pageApp, /URL\.createObjectURL\(result\.blob\)/, '前端必须通过 Blob 下载 Markdown 文件');
assert.match(pageApp, /GENERATION_PHASES/, '前端必须统一定义 DM 生成阶段');
assert.match(pageApp, /game:generation_progress/, '前端必须订阅真实生成进度事件');
assert.match(pageApp, /正在接收剧情内容/, '前端必须展示真实流式接收状态');
assert.match(pageApp, /completed \/ total \* 100/, '加载状态条必须只按真实完成字段计算长度');
assert.doesNotMatch(pageApp, /估算进度|Math\.min\(93,/, '前端不得保留时间估算百分比');
assert.match(pageApp, /UI\.icon\('layers-3'\)[\s\S]*UI\.icon\('coins'\)[\s\S]*UI\.icon\('database'\)/, 'Token 栏必须依次展示上下文窗口、本次 Token 与缓存数据');
assert.match(pageApp, /contextWindowTokens[\s\S]*lastContextTokens[\s\S]*lastRequestTokens[\s\S]*lastCacheHitTokens/, 'Token 栏必须使用约定的本次与上下文字段');
assert.match(gameServer, /MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000/, '上下文窗口总长度必须固定为 1M');
assert.match(pageApp, /cacheHitTokens \/ current\.promptTokens \* 100/, '第三项必须计算本局累计缓存率');
assert.doesNotMatch(pageApp, /缓存命中|缓存率/, '三项数据旁不得增加缓存文字标签');
assert.match(pageApp, /function tokenUsageNode[\s\S]*?\r?\n  \}\r?\n\r?\n  function legacyCopy/, 'Token 统计组件必须位于可被各玩家视图调用的作用域');
assert.match(pageApp, /if \(res\.room\) state\.room = res\.room/, '加入成功后必须立即采用响应中的房间状态');
assert.match(pageClient, /game:generation_progress/, 'Socket 客户端必须转发真实生成事件');
assert.match(pageApp, /generationLoader\('summary'\)/, '回合结算必须显示生成进度');
assert.match(pageCss, /\.dm-generation-glow\s*\{[\s\S]*dm-soft-glow/, 'DM 生成组件必须使用柔和且不旋转的动效');
assert.match(pageCss, /prefers-reduced-motion:\s*reduce/, '加载动画必须尊重减少动态效果设置');
assert.match(pageApp, /refreshGenerationCards\(progress\.kind\)/, '流式更新必须原位刷新加载卡，不能反复重建动画');
assert.match(pageApp, /data-generation-current[\s\S]*data-generation-progress/, '生成状态条必须只突出当前项目和真实完成进度');
assert.match(pageApp, /GENERATION_HINTS[\s\S]*检查下一幕与前文是否连贯/, '生成卡必须提供丰富且与当前任务相关的提示');
assert.doesNotMatch(pageApp, /下一回合已就绪[\s\S]*正在为双方切换到新场景/, '反馈页与操作栏不能再生成重复的下一回合状态框');
assert.match(pageApp, /g\.phase !== 'summary'\) bar\.appendChild\(generationLoader\('round'/, '反馈页双方确认后不得追加第二张生成卡');
assert.match(pageHtml, /id="player-chat"[\s\S]*id="player-chat-form"/, '正式玩家页必须包含聊天胶囊与输入框');
assert.match(pageClient, /sendChat\(text\).*chat:send/s, '客户端必须通过独立 chat:send 事件发送聊天');
const chatMessageHandler = pageApp.slice(pageApp.indexOf("client.on('chat:message'"), pageApp.indexOf("client.on('player:joined'"));
assert.match(chatMessageHandler, /appendChatMessage\(message\)/, '聊天到达时必须只追加聊天消息');
assert.doesNotMatch(chatMessageHandler, /render\(\)/, '聊天到达时不得触发游戏页面整体重绘');
assert.match(pageApp, /player-chat-input[\s\S]*client\.sendChat\(text\)/, '聊天输入必须独立调用聊天发送接口');
assert.match(socketServer, /chat:send[\s\S]*appendRoomChat[\s\S]*chat:message/, '服务端必须通过独立事件校验、保存并广播聊天');
assert.match(pageApp, /state\.me\?\.role === 'A'[\s\S]*client\.advance\(\)/, '双方提交后只允许一个客户端发起推进');
assert.match(pageApp, /value: state\.turn\.customText \|\| ''[\s\S]*oninput: \(e\) => \{ state\.turn\.customText = e\.target\.value; \}/, '输入草稿必须保存在回合状态中，不能因对方更新或自己提交被清空');
assert.doesNotMatch(gameServer, /room\.progress\s*>=\s*1/, '后端不得按故事进度自动结束');
assert.doesNotMatch(pageClient, /room\.progress\s*>=\s*1/, 'Mock 流程也不得按故事进度自动结束');
assert.match(socketServer, /viewerSubmitted[\s\S]*opponentChoiceText/, '服务端必须按查看者是否已经提交来发送对方选择');
assert.match(gameServer, /const demoMode = !config\.ai\.apiKey[\s\S]*if \(!parsed && !demoMode\)[\s\S]*throw new Error/, '配置真实 AI 后生成失败必须报错，不能切换演示内容');
assert.match(pageApp, /advanceFailed[\s\S]*text: '重新结算'/, '结算失败后必须显示明确的重新结算按钮');
assert.match(gameServer, /const allowEnding = isEndingRequested[\s\S]*if \(!allowEnding\) node\.ending = null/, '玩家未明确要求时后端必须丢弃 AI 结局');
assert.match(pageCss, /\.dm-generation\.is-compact\s*\{[\s\S]*grid-template-columns:\s*22px/, '后台预加载状态条必须进一步缩小');
assert.match(pageCss, /\.dm-generation-track\s*\{/, '加载状态条必须用细进度线展示真实字段完成情况');
assert.doesNotMatch(pageApp, /data-generation-sections/, '加载状态条不得再平铺三至五个固定字段标签');
assert.match(pageCss, /\.token-usage\s*\{/, '玩家页面必须提供低干扰 Token 统计样式');
assert.match(pageCss, /\.info-page > \.dm-generation\s*\{\s*margin-top:\s*10px/, '反馈正文与后台预加载状态条之间必须保留小段间距');
assert.match(deployUpdate, /SOURCE_ARCHIVE=\$\{1:-\/tmp\/ai-trpg-game\.tar\.gz\}/, '服务器更新脚本必须读取本地上传的发布包');
assert.match(deployUpdate, /cp -- "\$SOURCE_ARCHIVE"/, '服务器更新脚本必须复制本地发布包后再解压');
assert.doesNotMatch(deployUpdate, /github\.com|ARCHIVE_URL/, '服务器更新脚本不得访问 GitHub');
console.log('后端单元测试通过');

for (const testRoom of [room, preloadRoom, introRoom, brokenRoom, aiFailureRoom]) game.removeActiveRoom(testRoom.id);
