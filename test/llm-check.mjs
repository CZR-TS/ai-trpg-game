import { config } from '../server/config.js';
import { callAI } from '../server/llm.js';

const r = await callAI(config, [{ role: 'user', content: '只回复四个字：连接成功' }]);
console.log('AI 原始返回:', r ? JSON.stringify(r).slice(0, 200) : '(null)');
process.exit(r ? 0 : 1);
