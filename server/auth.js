import express from 'express';
import jwt from 'jsonwebtoken';
import { scryptVerify, scryptHash } from './config.js';

/** 登录失败记录：ip -> { fails, windowStart, banUntil } */
const failLog = new Map();

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

export function createAuthRouter(config) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const ip = req.ip || 'unknown';
    const rec = failLog.get(ip);
    if (rec?.banUntil && rec.banUntil > Date.now()) {
      return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
    }

    const { username, password } = req.body || {};
    const ok =
      username === config.auth.username &&
      typeof password === 'string' &&
      scryptVerify(password, config.auth.password);

    if (!ok) {
      // 统一错误消息，不泄露账号是否存在
      const now = Date.now();
      const cur = failLog.get(ip) || { fails: 0, windowStart: now, banUntil: 0 };
      if (now - cur.windowStart > config.auth.loginWindowMs) {
        cur.fails = 0;
        cur.windowStart = now;
      }
      cur.fails += 1;
      if (cur.fails >= config.auth.loginMaxFails) {
        cur.banUntil = now + config.auth.banMs;
        cur.fails = 0;
      }
      failLog.set(ip, cur);
      return res.status(401).json({ error: '账号或密码错误' });
    }

    failLog.delete(ip);
    const token = jwt.sign({ sub: username }, config.auth.jwtSecret, {
      expiresIn: `${config.auth.jwtExpiresDays}d`
    });
    res.setHeader(
      'Set-Cookie',
      `at=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.auth.jwtExpiresDays * 86400}`
    );
    res.json({ ok: true, username });
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'at=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  // 登录状态校验（前端加载时自动检测，用于"记住登录"）
  router.get('/me', requireAdmin(config), (req, res) => {
    res.json({ ok: true, username: config.auth.username });
  });

  return router;
}

export function requireAdmin(config) {
  return (req, res, next) => {
    const token = parseCookies(req).at;
    if (!token) return res.status(401).json({ error: '未登录' });
    try {
      jwt.verify(token, config.auth.jwtSecret);
      next();
    } catch {
      res.status(401).json({ error: '登录已过期' });
    }
  };
}

export { scryptHash };
