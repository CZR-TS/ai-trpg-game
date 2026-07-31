import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rootDir = process.cwd();
const configPath = path.join(rootDir, 'config', 'config.json');

const defaults = {
  ai: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash',
    temperature: 0.9,
    maxTokens: 2048,
    timeoutMs: 60000
  },
  server: { port: 38571, host: '0.0.0.0' },
  auth: {
    username: 'admin',
    password: '',
    jwtSecret: '',
    jwtExpiresDays: 7,
    loginMaxFails: 5,
    loginWindowMs: 60000,
    banMs: 900000
  },
  game: {
    roomCodeLen: 8,
    scanDepth: 4,
    worldbookTokenBudget: 1500,
    historyRounds: 6,
    historyMaxRounds: 100,
    currentWorldbookId: 'fantasy-example'
  }
};

function merge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = target[k] && typeof target[k] === 'object' ? merge(target[k], v) : { ...v };
    } else {
      target[k] = v;
    }
  }
  return target;
}

function load() {
  let cfg = structuredClone(defaults);
  if (fs.existsSync(configPath)) {
    try {
      const user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg = merge(cfg, user);
    } catch (e) {
      console.error('配置读取失败（config/config.json 格式错误？）', e.message);
    }
  }
  const envPort = Number(process.env.TRPG_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) cfg.server.port = envPort;
  if (process.env.TRPG_HOST) cfg.server.host = process.env.TRPG_HOST;
  if (process.env.TRPG_DISABLE_AI === '1') cfg.ai.apiKey = '';
  else if (process.env.TRPG_AI_API_KEY) cfg.ai.apiKey = process.env.TRPG_AI_API_KEY;
  if (process.env.TRPG_ADMIN_USERNAME) cfg.auth.username = process.env.TRPG_ADMIN_USERNAME;
  if (process.env.TRPG_ADMIN_PASSWORD) {
    // 环境变量仅覆盖本次进程配置，避免把明文密码写回 config.json。
    cfg.auth.password = scryptHash(process.env.TRPG_ADMIN_PASSWORD).hash;
  }
  if (!cfg.auth.jwtSecret) {
    cfg.auth.jwtSecret = crypto.randomBytes(32).toString('hex');
    saveConfig(cfg);
  }
  return cfg;
}

export function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('配置写回失败：', e.message);
  }
}

/** 若配置里是明文密码，启动时自动升级为 scrypt 哈希并写回文件 */
export function ensureHashedPassword(cfg) {
  if (!cfg.auth.password) return;
  if (cfg.auth.password.startsWith('$scrypt$')) return;
  const { hash } = scryptHash(cfg.auth.password);
  cfg.auth.password = hash;
  saveConfig(cfg);
  console.log('已自动将管理员密码转换为哈希存储（config/config.json）');
}

export function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash: `$scrypt$${salt}$${hash}` };
}

export function scryptVerify(password, stored) {
  if (!stored || !stored.startsWith('$scrypt$')) return false;
  const parts = stored.split('$'); // ['', 'scrypt', salt, hash]
  const salt = parts[2];
  const hash = parts[3];
  const calc = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

export const config = load();
ensureHashedPassword(config);
