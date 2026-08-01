import express from 'express';
import {
  listWorldbooks, importWorldbook, createRoom, rooms, getWorldbook,
  archiveCurrentRound, listRoomHistory, saveRoomHistory, removeActiveRoom, roomHistoryStorage, deleteRoomHistory, playerDisplayName,
  clearRoomChat,
} from './game.js';
import { config, saveConfig } from './config.js';
import { buildStoryMarkdown, storyExportFilename } from './story-export.js';

function sendStoryExport(res, record) {
  const worldbookName = getWorldbook(record.worldbookId)?.name || record.worldbookName || record.worldbookId;
  const filename = storyExportFilename(record.code);
  const fallbackName = `story-${String(record.code || 'export').replace(/[^A-Za-z0-9_-]/g, '') || 'export'}.md`;
  res.set({
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.send(buildStoryMarkdown(record, { worldbookName }));
}

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
        A: r.players.A ? { name: playerDisplayName(r.players.A), ready: r.players.A.ready } : null,
        B: r.players.B ? { name: playerDisplayName(r.players.B), ready: r.players.B.ready } : null,
      },
      createdAt: r.createdAt,
    }));
    res.json({ rooms: list });
  });

  // 实时在线玩家：按房间成对返回（sockId 非空即在线）
  router.get('/online', (req, res) => {
    const roomsList = [...rooms.values()]
      .filter((r) => r.status !== 'ended')
      .map((r) => ({
        code: r.code,
        status: r.status,
        worldbookId: r.worldbookId,
        players: ['A', 'B']
          .map((role) => (r.players[role] && r.players[role].sockId ? { role, name: playerDisplayName(r.players[role]) } : null))
          .filter(Boolean),
      }))
      .filter((r) => r.players.length > 0);
    const count = roomsList.reduce((sum, r) => sum + r.players.length, 0);
    res.json({ count, rooms: roomsList, updatedAt: Date.now() });
  });

  // 历史记录（磁盘持久化，服务重启不丢失）
  router.get('/rooms/history', (req, res) => {
    res.json({ history: listRoomHistory(), storage: roomHistoryStorage() });
  });

  router.get('/rooms/history/:id/export', (req, res) => {
    const record = listRoomHistory().find((item) => item.id === req.params.id);
    if (!record) return res.status(404).json({ error: '历史记录不存在' });
    sendStoryExport(res, record);
  });
  router.delete('/rooms/history/:id', (req, res) => {
    if (!deleteRoomHistory(req.params.id)) return res.status(404).json({ error: '历史记录不存在' });
    res.json({ ok: true, storage: roomHistoryStorage() });
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
        A: room.players.A ? { name: playerDisplayName(room.players.A), ready: room.players.A.ready } : null,
        B: room.players.B ? { name: playerDisplayName(room.players.B), ready: room.players.B.ready } : null,
      },
      history: room.history,
      ending: room.ending,
    });
  });

  router.get('/rooms/:id/export', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room || room.status === 'ended') return res.status(404).json({ error: '房间不存在' });
    sendStoryExport(res, room);
  });

  router.post('/rooms/:id/close', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    archiveCurrentRound(room);
    room.status = 'ended';
    room.phase = 'ended';
    clearRoomChat(room);
    saveRoomHistory(room);
    removeActiveRoom(room.id);
    res.json({ ok: true });
  });

  return router;
}
