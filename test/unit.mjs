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
