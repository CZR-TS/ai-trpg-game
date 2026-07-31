import path from 'node:path';
import { config } from '../server/config.js';
import { callAI, buildSystemPrompt, parseGameReply } from '../server/llm.js';
import { initWorldbookStore, loadCharacterCard } from '../server/game.js';

initWorldbookStore();
const charCard = loadCharacterCard(
  path.join(process.cwd(), 'worldbook', 'examples', 'fantasy-example', 'dm_character.json')
);
const system = buildSystemPrompt(charCard);
const user = `【本回合双方选择】\n玩家A：谨慎后退一步举起盾牌交涉\n玩家B：默念咒术消失在阴影中\n【指令】总结本回合两位玩家行动的后果：summary 字段给出结果反馈（2-4句），更新 story_state 与 progress。若故事已到结局则填 ending。`;

console.log('--- 请求中（summary 生成）---');
const raw = await callAI(config, [{ role: 'system', content: system }, { role: 'user', content: user }]);
console.log('RAW 返回长度:', raw ? raw.length : 0);
if (raw) console.log('RAW 前 600 字:\n', raw.slice(0, 600));
const parsed = parseGameReply(raw);
console.log('\n解析结果:', parsed ? '成功' : '失败(将降级为mock)');
if (parsed) console.log('summary:', JSON.stringify(parsed.summary || null).slice(0, 200));
process.exit(0);
