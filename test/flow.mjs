import path from 'node:path';
import { config } from '../server/config.js';
import {
  initWorldbookStore, createRoom, joinRoom, startRoom, advanceRoom,
  proceedNext, confirmNext, loadCharacterCard,
} from '../server/game.js';

initWorldbookStore();
const charCard = loadCharacterCard(
  path.join(process.cwd(), 'worldbook', 'examples', 'fantasy-example', 'dm_character.json')
);
const room = createRoom({ worldbookId: 'fantasy-example' });
console.log('房间码:', room.code);
joinRoom(room.code, '阿甲');
joinRoom(room.code, '阿乙');
room.players.A.ready = true;
room.players.B.ready = true;

console.log('\n=== [1/5] 开场信息（真实 AI） ===');
const intro = await startRoom(room, config, charCard);
console.log('世界观:', (intro.intro?.world || '').slice(0, 120));
console.log('角色A:', (intro.intro?.roleA || '').slice(0, 80));
console.log('角色B:', (intro.intro?.roleB || '').slice(0, 80));

console.log('\n=== [2/5] 双方确认 → 首轮 ===');
confirmNext(room, 'A'); confirmNext(room, 'B');
const r1 = await proceedNext(room, config, charCard);
console.log('叙事:', r1.node.narrative.slice(0, 150));
console.log('A选项:', r1.node.choices_A.join(' | '));

console.log('\n=== [3/5] 双方选择 → 回合反馈（真实 AI） ===');
room.chosen.A = r1.node.choices_A[0];
room.chosen.B = r1.node.choices_B[0];
room.submitted.A = true;
room.submitted.B = true;
const s1 = await advanceRoom(room, config, charCard);
console.log('反馈:', (s1.summary || '').slice(0, 150));
console.log('A选择:', s1.type === 'summary' ? '' : '', room.currentSummary?.choiceA);
console.log('B选择:', room.currentSummary?.choiceB);

console.log('\n=== [4/5] 双方确认下一步 → 下一轮 ===');
confirmNext(room, 'A'); confirmNext(room, 'B');
const r2 = await proceedNext(room, config, charCard);
console.log('叙事:', r2.node.narrative.slice(0, 150));
console.log('进度:', Math.round(room.progress * 100) + '%');

console.log('\n=== [5/5] 继续推进直到结局（最多 8 轮） ===');
let ended = null;
for (let i = 0; i < 8 && !ended; i++) {
  room.chosen.A = room.currentNode.choices_A[0];
  room.chosen.B = room.currentNode.choices_B[0];
  room.submitted.A = true;
  room.submitted.B = true;
  const res = await advanceRoom(room, config, charCard);
  if (res.type === 'ended') { ended = res; break; }
  confirmNext(room, 'A'); confirmNext(room, 'B');
  await proceedNext(room, config, charCard);
  console.log(`第${room.round}回合 · 进度 ${Math.round(room.progress * 100)}% · 叙事: ${room.currentNode.narrative.slice(0, 80)}`);
}
if (ended) {
  console.log('结局标题:', ended.ending.title);
  console.log('结局:', ended.ending.text.slice(0, 200));
  console.log('\n🎉 真实 AI 全流程跑通，共', room.round, '回合');
} else {
  console.log('8 轮内未到结局（进度', Math.round(room.progress * 100) + '%），但流程正常');
}
process.exit(0);
