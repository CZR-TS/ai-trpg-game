import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import helmet from 'helmet';

import { config } from './config.js';
import { createAuthRouter, requireAdmin } from './auth.js';
import { createAdminRouter } from './admin.js';
import * as game from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

game.initWorldbookStore();
const fallbackCharacter = game.loadCharacterCard(
  path.join(process.cwd(), 'worldbook', 'examples', 'fantasy-example', 'dm_character.json')
);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use('/api/auth', createAuthRouter(config));
app.use('/api/admin', requireAdmin(config), createAdminRouter());
app.use(express.static(publicDir));
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 64 * 1024,
});

function roomSocket(socket) {
  const room = socket.data.roomId ? game.rooms.get(socket.data.roomId) : null;
  const role = socket.data.role;
  if (!room || !role || room.players[role]?.sockId !== socket.id) return null;
  return room;
}

function characterFor(room) {
  return game.getCharacterCard(room.worldbookId, fallbackCharacter);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '服务器内部错误';
}

function recapHistory(room) {
  return room.history.map((item) => ({
    round: item.round,
    reveal: item.reveal !== false,
    narrative: item.narrative,
    choices: {
      A: item.choiceA ? { text: item.choiceA } : null,
      B: item.choiceB ? { text: item.choiceB } : null,
    },
  }));
}

function endingPayload(room, summary) {
  return {
    ending: { ...room.ending, history: recapHistory(room) },
    progress: 1,
    summary,
  };
}

function playerRoomView(room, viewerRole) {
  const view = game.publicRoomView(room);
  if (view.currentNode) view.currentNode.story_state = game.playerStoryStateView(view.currentNode.story_state, viewerRole);
  return view;
}

function emitPlayerEvent(room, event, payloadForRole) {
  for (const role of ['A', 'B']) {
    const socketId = room.players[role]?.sockId;
    if (socketId) io.to(socketId).emit(event, payloadForRole(role));
  }
}

function emitRoomState(room) {
  emitPlayerEvent(room, 'room:state', (role) => ({ room: playerRoomView(room, role) }));
}

function maybePreloadOpening(room) {
  if (room.status !== 'waiting' || !room.players.A || !room.players.B) return;
  if (room.openingStatus !== 'idle' && room.openingStatus !== 'failed') return;
  const pending = game.preloadOpening(room, config, characterFor(room));
  emitRoomState(room);
  pending.then(() => {
    emitRoomState(room);
  }).catch((error) => {
    console.warn('[GAME] 开场预加载失败：', errorMessage(error));
    emitRoomState(room);
  });
}

io.on('connection', (socket) => {
  socket.on('room:join', (payload, ack) => {
    try {
      if (socket.data.roomId) throw new Error('当前连接已经加入房间');
      const { roomCode, name } = payload || {};
      if (!roomCode) throw new Error('缺少房间码');
      const joined = game.joinRoom(roomCode, name);
      const { room, role } = joined;
      const previousSocketId = room.players[role].sockId;
      if (previousSocketId && previousSocketId !== socket.id) {
        io.sockets.sockets.get(previousSocketId)?.disconnect(true);
      }
      room.players[role].sockId = socket.id;
      socket.join(room.id);
      socket.data.roomId = room.id;
      socket.data.role = role;
      maybePreloadOpening(room);
      ack?.({
        ok: true,
        roomId: room.id,
        role,
        reconnected: joined.reconnected,
      });
      io.to(room.id).emit(joined.reconnected ? 'player:reconnected' : 'player:joined', {
        role,
        name: room.players[role].name,
      });
      emitRoomState(room);
      if (joined.reconnected && room.status === 'playing') {
        if (room.phase === 'intro') socket.emit('game:intro', introView(room, room.currentNode));
        else if (room.phase === 'summary') socket.emit('game:summary', summaryView(room, role));
        else if (room.phase === 'round') socket.emit('game:round', nodeView(room, room.currentNode, role));
      }
      if (joined.reconnected && room.status === 'ended') {
        socket.emit('game:ended', endingPayload(room));
      }
    } catch (error) {
      ack?.({ ok: false, error: errorMessage(error) });
    }
  });

  socket.on('room:ready', (payload, ack) => {
    const room = roomSocket(socket);
    const role = socket.data.role;
    if (!room || !room.players[role]) return ack?.({ ok: false, error: '未加入房间' });
    if (room.status !== 'waiting' || room.processing) return ack?.({ ok: false, error: '当前不能更改准备状态' });
    room.players[role].ready = !room.players[role].ready;
    io.to(room.id).emit('player:ready', { role, ready: room.players[role].ready });
    emitRoomState(room);
    ack?.({ ok: true, ready: room.players[role].ready });
  });

  socket.on('room:leave', (payload, ack) => {
    const room = roomSocket(socket);
    const role = socket.data.role;
    if (!room || !role) return ack?.({ ok: false, error: '未加入房间' });

    const reconnectable = room.status !== 'waiting';
    socket.leave(room.id);
    if (reconnectable) {
      room.players[role].sockId = null;
      io.to(room.id).emit('player:disconnected', { role });
    } else {
      room.players[role] = null;
      io.to(room.id).emit('player:left', { role });
    }
    socket.data.roomId = null;
    socket.data.role = null;
    emitRoomState(room);
    ack?.({ ok: true, reconnectable });
  });
  socket.on('game:start', async (payload, ack) => {
    const room = roomSocket(socket);
    if (!room) return ack?.({ ok: false, error: '未加入房间' });
    if (socket.data.role !== room.hostRole) return ack?.({ ok: false, error: '只有房主可以开始' });
    if (!room.players.A?.ready || !room.players.B?.ready) {
      return ack?.({ ok: false, error: '双方都准备后才能开始' });
    }
    try {
      // 立即通知双方“开场生成中”，避免房主点开始后对方界面毫无反馈
      io.to(room.id).emit('game:starting', { code: room.code });
      const node = await game.startRoom(room, config, characterFor(room));
      if (!node) return ack?.({ ok: false, error: '游戏正在处理或已经开始' });
      ack?.({ ok: true });
      io.to(room.id).emit('game:started', { code: room.code });
      io.to(room.id).emit('game:intro', introView(room, node));
    } catch (error) {
      console.error('[GAME] 开局失败：', error);
      ack?.({ ok: false, error: '开局失败，请重试' });
      emitRoomState(room);
    }
  });

  socket.on('game:choice', (payload, ack) => {
    const room = roomSocket(socket);
    const role = socket.data.role;
    if (!room || room.status !== 'playing' || !room.currentNode) {
      return ack?.({ ok: false, error: '游戏未进行中' });
    }
    if (room.phase !== 'round') return ack?.({ ok: false, error: '当前阶段不能提交选择' });
    if (room.processing) return ack?.({ ok: false, error: 'DM 正在推进剧情' });
    if (room.submitted[role]) return ack?.({ ok: false, error: '本回合已经提交' });
    const choice = typeof payload?.choiceId === 'string' ? payload.choiceId.trim() : '';
    // 开放输入：可选手选项，也可自定义任意行动（长度上限 200）
    if (!choice || choice.length > 200) return ack?.({ ok: false, error: '无效的选择' });
    room.chosen[role] = choice;
    room.submitted[role] = true;
    const reveal = room.currentNode.reveal !== false;
    io.to(room.id).emit('game:choice_update', {
      role,
      chosen: true,
      choiceText: reveal ? choice : undefined,
    });
    ack?.({ ok: true });
  });

  socket.on('game:advance', async (payload, ack) => {
    const room = roomSocket(socket);
    if (!room || room.status !== 'playing') return ack?.({ ok: false, error: '游戏未进行中' });
    if (room.phase !== 'round') return ack?.({ ok: false, error: '当前阶段不能推进' });
    try {
      const result = await game.advanceRoom(room, config, characterFor(room));
      if (!result) {
        return ack?.({ ok: false, error: room.processing ? 'DM 正在推进剧情' : '双方都提交选择后才能推进' });
      }
      ack?.({ ok: true });
      if (result.type === 'ended') {
        io.to(room.id).emit('game:ended', endingPayload(room, result.summary));
      } else {
        emitPlayerEvent(room, 'game:summary', (role) => summaryView(room, role));
        game.preloadNextRound(room, config, characterFor(room)).then((node) => {
          if (node && room.status === 'playing' && room.phase === 'summary') {
            emitPlayerEvent(room, 'game:preload_status', () => ({ status: room.nextRoundStatus }));
          }
        });
      }
    } catch (error) {
      console.error('[GAME] 推进失败：', error);
      ack?.({ ok: false, error: '推进失败，请重试' });
    }
  });

  // 双方确认「下一步 / 开始冒险」：都确认后推进到下一阶段
  socket.on('game:next', async (payload, ack) => {
    const room = roomSocket(socket);
    const role = socket.data.role;
    if (!room || room.status !== 'playing') return ack?.({ ok: false, error: '游戏未进行中' });
    if (room.phase !== 'intro' && room.phase !== 'summary') {
      return ack?.({ ok: false, error: '当前阶段不能确认' });
    }
    if (room.nextConfirm[role]) return ack?.({ ok: false, error: '已确认，等待对方' });
    const bothReady = game.confirmNext(room, role);
    io.to(room.id).emit('game:next_update', { role, confirmed: true });
    if (!bothReady) return ack?.({ ok: true, waiting: true });
    try {
      const result = await game.proceedNext(room, config, characterFor(room));
      if (!result) return ack?.({ ok: false, error: '推进失败，请重试' });
      if (result.type === 'round') {
        emitPlayerEvent(room, 'game:round', (role) => nodeView(room, result.node, role));
      }
      ack?.({ ok: true });
    } catch (error) {
      room.nextConfirm = { A: false, B: false };
      console.error('[GAME] 阶段推进失败：', error);
      ack?.({ ok: false, error: '推进失败，请重试' });
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    const room = roomId ? game.rooms.get(roomId) : null;
    if (room?.players[role]?.sockId === socket.id) {
      if (room.status === 'waiting') {
        // 游戏未开始：直接释放座位，其他人可重新加入
        room.players[role] = null;
        io.to(room.id).emit('player:left', { role });
        emitRoomState(room);
        return;
      }
      room.players[role].sockId = null;
      io.to(room.id).emit('player:disconnected', { role });
      emitRoomState(room);
    }
  });
});

function nodeView(room, node, viewerRole) {
  return {
    round: room.round,
    narrative: node.narrative,
    choices_A: node.choices_A,
    choices_B: node.choices_B,
    reveal: node.reveal,
    story_state: game.playerStoryStateView(node.story_state, viewerRole),
    progress: room.progress,
  };
}

function introView(room, node) {
  const intro = node.intro || {};
  return {
    code: room.code,
    worldbookId: room.worldbookId,
    intro: {
      world: intro.world || '（开场信息生成中）',
      roleA: intro.roleA || '玩家A',
      roleB: intro.roleB || '玩家B',
    },
    round: room.round,
  };
}

function summaryView(room, viewerRole) {
  const s = room.currentSummary || {};
  return {
    round: s.round ?? room.round,
    summary: s.summary || '（本回合没有新的变化）',
    storyState: game.playerStoryStateView(s.storyState || {}, viewerRole),
    progress: room.progress,
    choiceA: s.choiceA ?? null,
    choiceB: s.choiceB ?? null,
    playerNames: { A: room.players.A?.name || '玩家 A', B: room.players.B?.name || '玩家 B' },
    preloadStatus: room.nextRoundStatus,
  };
}

server.listen(config.server.port, config.server.host, () => {
  console.log('──────────────────────────────────────────────');
  console.log('AI 双人跑团服务已启动');
  console.log(`  本机访问:   http://127.0.0.1:${config.server.port}`);
  console.log(`  局域网访问: http://<本机IP>:${config.server.port}`);
  console.log(`  管理员账号: ${config.auth.username}`);
  console.log('  密码: 见本地安全配置');
  console.log('──────────────────────────────────────────────');
});
