import assert from 'node:assert/strict';
import path from 'node:path';
import * as game from '../server/game.js';
import { activateEntries, loadWorldbookFile } from '../server/lorebook.js';
import { buildHistoryText, normalizeNode } from '../server/llm.js';

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

room.players.A = { name: 'A', ready: true, token: 'a', sockId: null };
room.players.B = { name: 'B', ready: true, token: 'b', sockId: null };
const opening = await game.startRoom(room, config, character);
assert.equal(room.status, 'playing');
assert.equal(opening.progress, 0.25);
assert.ok(opening.choices_A.length && opening.choices_B.length);

room.chosen = { A: opening.choices_A[0], B: opening.choices_B[0] };
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
preloadRoom.chosen = { A: preloadOpening.choices_A[0], B: preloadOpening.choices_B[0] };
preloadRoom.submitted = { A: true, B: true };
const preloadSummary = await game.advanceRoom(preloadRoom, config, character);
assert.equal(preloadSummary.type, 'summary');
assert.equal(preloadRoom.phase, 'summary');
assert.deepEqual(preloadRoom.nextConfirm, { A: false, B: false }, '无人点击下一步时也应开始预加载');
assert.ok(preloadRoom.nextRoundPromise || preloadRoom.nextRoundNode, '反馈生成后必须立即存在下一回合预加载任务');
const prefetchedNode = preloadRoom.nextRoundNode || await preloadRoom.nextRoundPromise;
assert.ok(prefetchedNode?.narrative, '下一回合应在反馈阅读期间完成生成');
assert.equal(prefetchedNode.story_state.A.name, '预载甲', '预加载节点必须使用真实昵称');
preloadRoom.worldbook = null;
const reusedNext = await game.proceedNext(preloadRoom, config, character);
assert.equal(reusedNext.node, prefetchedNode, '双方确认时必须复用预加载结果，不能再次请求 AI');

const brokenRoom = game.createRoom({ worldbookId: 'fantasy-example' });
brokenRoom.worldbook = null;
await assert.rejects(() => game.startRoom(brokenRoom, config, character));
assert.equal(brokenRoom.status, 'waiting', '开局失败必须保持可重试状态');

const normalized = normalizeNode({
  narrative: '测试', choices_A: [{ bad: true }, ' 有效 '], choices_B: [42], story_state: null,
}, { choicesA: ['后备A'], choicesB: ['后备B'], storyState: { flag: true } });
assert.deepEqual(normalized.choices_A, ['有效']);
assert.deepEqual(normalized.choices_B, ['（自由行动）']);
assert.deepEqual(normalized.story_state, { flag: true });
assert.match(buildHistoryText([{ round: 1, narrative: 'n', choiceA: 'a', choiceB: 'b', storyState: { hp: 9 } }], 6), /"hp":9/);

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
console.log('后端单元测试通过');
