import express from 'express';
import {
  listWorldbooks, importWorldbook, createRoom, rooms, getWorldbook,
  listRoomHistory, saveRoomHistory,
} from './game.js';
import { config, saveConfig } from './config.js';

/** 管理员后台 API（全部挂在 requireAdmin 中间件之后） */
export function createAdminRouter() {
  const router = express.Router();

  router.get('/worldbooks', (req, res) => {
    res.json({ worldbooks: listWorldbooks(), current: config.game.currentWorldbookId });
  });

  router.post('/worldbooks', (req, res) => {
    try {
      const { id, name, content } = req.body || {};
      if (!content) return res.status(400).json({ error: '需要 content' });
      const wb = importWorldbook({ id, name: name || id, content });
      res.json(wb);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/worldbooks/:id/select', (req, res) => {
    if (!getWorldbook(req.params.id)) return res.status(404).json({ error: '世界书不存在' });
    config.game.currentWorldbookId = req.params.id;
    saveConfig(config);
    res.json({ ok: true, current: req.params.id });
  });

  router.post('/rooms', (req, res) => {
    try {
      const { worldbookId, code } = req.body || {};
      const room = createRoom({
        worldbookId: worldbookId || config.game.currentWorldbookId,
        code,
        roomCodeLen: config.game.roomCodeLen,
      });
      res.json({ roomId: room.id, code: room.code });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/rooms', (req, res) => {
    const list = [...rooms.values()].filter((r) => r.status !== 'ended').map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      round: r.round,
      progress: r.progress,
      worldbookId: r.worldbookId,
      players: {
        A: r.players.A ? { name: r.players.A.name, ready: r.players.A.ready } : null,
        B: r.players.B ? { name: r.players.B.name, ready: r.players.B.ready } : null,
      },
      createdAt: r.createdAt,
    }));
    res.json({ rooms: list });
  });

  // 历史记录（磁盘持久化，服务重启不丢失）
  router.get('/rooms/history', (req, res) => {
    res.json({ history: listRoomHistory() });
  });

  router.get('/rooms/:id', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    res.json({
      id: room.id,
      code: room.code,
      status: room.status,
      round: room.round,
      progress: room.progress,
      worldbookId: room.worldbookId,
      processing: room.processing,
      openingStatus: room.openingStatus,
      storyState: room.storyState,
      currentNode: room.currentNode,
      players: {
        A: room.players.A ? { name: room.players.A.name, ready: room.players.A.ready } : null,
        B: room.players.B ? { name: room.players.B.name, ready: room.players.B.ready } : null,
      },
      history: room.history,
      ending: room.ending,
    });
  });

  router.post('/rooms/:id/close', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    room.status = 'ended';
    saveRoomHistory(room);
    res.json({ ok: true });
  });

  return router;
}
