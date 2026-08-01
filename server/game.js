import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorldbookFile, activateEntries, buildLoreText } from './lorebook.js';
import {
  buildSystemPrompt,
  buildHistoryText,
  callAI,
  parseGameReply,
  normalizeNode,
  mockNarrative,
} from './llm.js';

/** 房间表与世界书表（内存态，一期不做持久化） */
export const rooms = new Map();
export const worldbooks = new Map();

const WB_DIR = path.join(process.cwd(), 'data', 'worldbooks');
const HISTORY_DIR = path.join(process.cwd(), 'data', 'room-history');
const ACTIVE_DIR = path.join(process.cwd(), 'data', 'room-active');
export const ROOM_HISTORY_LIMIT_BYTES = 200 * 1024 * 1024;
const VALID_WORLDBOOK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VALID_ROOM_CODE = /^[A-Z2-9]{4,16}$/;

/** 扫描内置世界书 + data/worldbooks 导入的世界书 */
export function initWorldbookStore() {
  worldbooks.clear();
  const examplesDir = path.join(process.cwd(), 'worldbook', 'examples');
  if (fs.existsSync(examplesDir)) {
    for (const dir of fs.readdirSync(examplesDir)) {
      if (!VALID_WORLDBOOK_ID.test(dir)) continue;
      const f = path.join(examplesDir, dir, 'worldbook.json');
      if (fs.existsSync(f)) {
        const characterPath = path.join(examplesDir, dir, 'dm_character.json');
        worldbooks.set(dir, {
          id: dir,
          name: dir,
          builtin: true,
          filePath: f,
          characterPath: fs.existsSync(characterPath) ? characterPath : null,
        });
      }
    }
  }
  if (fs.existsSync(WB_DIR)) {
    for (const f of fs.readdirSync(WB_DIR).filter((x) => x.endsWith('.json'))) {
      const id = path.basename(f, '.json');
      if (!VALID_WORLDBOOK_ID.test(id)) continue;
      worldbooks.set(id, { id, name: id, builtin: false, filePath: path.join(WB_DIR, f) });
    }
  }
}

export function getWorldbook(id) {
  const meta = worldbooks.get(id);
  if (!meta) return null;
  if (!meta.worldbook) meta.worldbook = loadWorldbookFile(meta.filePath);
  return meta.worldbook;
}

export function getCharacterCard(worldbookId, fallbackCard) {
  const meta = worldbooks.get(worldbookId);
  if (!meta?.characterPath) return fallbackCard;
  if (!meta.characterCard) meta.characterCard = loadCharacterCard(meta.characterPath);
  return meta.characterCard;
}

export function listWorldbooks() {
  return [...worldbooks.values()].map((w) => ({
    id: w.id,
    name: w.name,
    builtin: w.builtin,
    entryCount: getWorldbook(w.id).entries.length,
  }));
}

export function importWorldbook({ id, name, content }) {
  const generatedId = 'wb-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const safeId = String(id || generatedId).trim();
  if (!VALID_WORLDBOOK_ID.test(safeId)) {
    throw new Error('世界书 id 只能包含字母、数字、下划线和连字符，长度 1-64');
  }
  const safeName = String(name || safeId).trim();
  if (!safeName || safeName.length > 100) throw new Error('世界书名称长度必须为 1-100');
  const data = typeof content === 'string' ? JSON.parse(content) : content;
  if (!data || Array.isArray(data) || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
    throw new Error('世界书格式无效：缺少 entries 对象');
  }
  fs.mkdirSync(WB_DIR, { recursive: true });
  const filePath = path.resolve(WB_DIR, `${safeId}.json`);
  if (path.dirname(filePath) !== path.resolve(WB_DIR)) throw new Error('世界书 id 无效');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  worldbooks.set(safeId, { id: safeId, name: safeName, builtin: false, filePath });
  return { id: safeId, name: safeName };
}

export function loadCharacterCard(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return raw.data || raw;
}

export function makeRoomCode(len = 8) {
  const size = Number.isInteger(Number(len)) ? Math.min(16, Math.max(4, Number(len))) : 8;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < size; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

function roomCodeExists(code) {
  return [...rooms.values()].some((room) => room.code === code && room.status !== 'ended');
}

export function createRoom({ worldbookId, code, roomCodeLen = 8 }) {
  const worldbook = getWorldbook(worldbookId);
  if (!worldbook) throw new Error('世界书不存在');

  let roomCode;
  if (code !== undefined && code !== null && String(code).trim()) {
    roomCode = String(code).trim().toUpperCase();
    if (!VALID_ROOM_CODE.test(roomCode)) throw new Error('房间码必须为 4-16 位大写字母或数字');
    if (roomCodeExists(roomCode)) throw new Error('房间码已存在');
  } else {
    for (let i = 0; i < 32; i++) {
      const candidate = makeRoomCode(roomCodeLen);
      if (!roomCodeExists(candidate)) {
        roomCode = candidate;
        break;
      }
    }
    if (!roomCode) throw new Error('无法生成唯一房间码，请重试');
  }

  const room = {
    id: crypto.randomUUID(),
    code: roomCode,
    worldbookId,
    worldbook,
    hostRole: 'A',
    status: 'waiting',
    phase: 'waiting', // waiting | intro | round | summary | ended
    players: { A: null, B: null },
    round: 0,
    progress: 0,
    storyState: {},
    intro: null,
    currentNode: null,
    currentSummary: null,
    nextConfirm: { A: false, B: false },
    submitted: { A: false, B: false },
    chosen: { A: null, B: null },
    openingNode: null,
    openingPromise: null,
    openingStatus: 'idle',
    nextRoundNode: null,
    nextRoundPromise: null,
    nextRoundStatus: 'idle',
    history: [],
    processing: false,
    ending: null,
    offSince: { A: null, B: null },
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}


export function playerDisplayName(player) {
  return player?.displayName || player?.name || null;
}

export function updatePlayerProfile(room, role, input = {}) {
  if (!room || room.status !== 'playing' || room.phase !== 'intro') throw new Error('当前不能修改角色资料');
  const player = room.players[role];
  if (!player) throw new Error('玩家不存在');
  if (room.nextConfirm?.[role]) throw new Error('已经确认开始，不能再修改角色资料');
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  const gender = typeof input.gender === 'string' ? input.gender.trim() : '';
  const personality = typeof input.personality === 'string' ? input.personality.trim() : '';
  const details = typeof input.details === 'string' ? input.details.trim() : '';
  if (!displayName || displayName.length > 32) throw new Error('剧情昵称长度必须为 1-32');
  if (gender.length > 20) throw new Error('性别描述不能超过 20 字');
  if (personality.length > 120) throw new Error('性格描述不能超过 120 字');
  if (details.length > 300) throw new Error('补充设定不能超过 300 字');
  const otherRole = role === 'A' ? 'B' : 'A';
  if (playerDisplayName(room.players[otherRole]) === displayName) throw new Error('剧情昵称不能与对方相同');
  player.displayName = displayName;
  player.profile = { gender, personality, details };
  player.profileReady = true;
  const current = room.storyState?.[role] && typeof room.storyState[role] === 'object' ? { ...room.storyState[role] } : {};
  delete current['性别'];
  delete current['性格'];
  delete current['个人设定'];
  current.name = displayName;
  if (gender) current['性别'] = gender;
  if (personality) current['性格'] = personality;
  if (details) current['个人设定'] = details;
  room.storyState = { ...(room.storyState || {}), [role]: current };
  room.nextConfirm[role] = false;
  saveActiveRoom(room);
  return { displayName, profile: player.profile, profileReady: true };
}
export function findRoomByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return [...rooms.values()].find((r) => r.code === c && r.status !== 'ended');
}

export function joinRoom(code, name) {
  const room = findRoomByCode(code);
  if (!room) throw new Error('房间不存在或已结束');

  const safeName = typeof name === 'string' ? name.trim() : '';
  if (!safeName || safeName.length > 32) throw new Error('昵称长度必须为 1-32');

  // 小规模双人房：房间码 + 完全相同的昵称就是身份；只有离线席位可被认领。
  const sameNameRole = ['A', 'B'].find((role) => room.players[role]?.name === safeName);
  if (sameNameRole) {
    if (room.players[sameNameRole].sockId) throw new Error('该昵称当前在线，不能重复进入');
    return { room, role: sameNameRole, reconnected: true };
  }

  if (room.status !== 'waiting') throw new Error('游戏已开始，请使用原玩家昵称重连');
  const role = !room.players.A ? 'A' : !room.players.B ? 'B' : null;
  if (!role) throw new Error('房间已满');
  room.players[role] = {
    name: safeName,
    displayName: safeName,
    profile: { gender: '', personality: '', details: '' },
    profileReady: false,
    ready: false,
    sockId: null,
  };
  return { room, role, reconnected: false };
}

/** 保存房间历史到磁盘（结束/关闭时调用，服务重启不丢失） */
export function saveRoomHistory(room) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const record = {
      id: room.id,
      code: room.code,
      worldbookId: room.worldbookId,
      players: { A: playerDisplayName(room.players.A), B: playerDisplayName(room.players.B) },
      playerProfiles: {
        A: room.players.A?.profile || null,
        B: room.players.B?.profile || null,
      },
      round: room.round,
      progress: room.progress,
      intro: room.intro || null,
      history: room.history.map((item) => ({
        round: item.round,
        narrative: String(item.narrative || '').slice(0, 12000),
        choiceA: item.choiceA,
        choiceB: item.choiceB,
        reveal: item.reveal,
        storyState: item.storyState,
      })),
      ending: room.ending,
      status: room.status,
      createdAt: room.createdAt,
      endedAt: Date.now(),
    };
    fs.writeFileSync(path.join(HISTORY_DIR, room.id + '.json'), JSON.stringify(record, null, 2), 'utf8');
  } catch (e) {
    console.warn('[存档] 历史保存失败：', e.message);
  }
}

/** 将尚未进入 history 的当前叙事补入归档，供中途结束/超时结束使用。 */
export function archiveCurrentRound(room) {
  if (!room?.currentNode || room.history.at(-1)?.round === room.round) return;
  room.history.push({
    round: room.round,
    narrative: room.currentNode.narrative,
    choiceA: room.chosen.A,
    choiceB: room.chosen.B,
    reveal: room.currentNode.reveal,
    storyState: room.currentNode.story_state,
  });
}

/** 进行中房间落盘（服务器重启后自动恢复；不含世界书对象与预生成节点） */
export function saveActiveRoom(room) {
  if (!room || room.status !== 'playing') return;
  try {
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
    const snapshot = {
      id: room.id,
      code: room.code,
      worldbookId: room.worldbookId,
      hostRole: room.hostRole,
      status: room.status,
      phase: room.phase,
      players: {
        A: room.players.A ? {
          name: room.players.A.name, displayName: playerDisplayName(room.players.A), profile: room.players.A.profile,
          profileReady: !!room.players.A.profileReady, ready: room.players.A.ready,
        } : null,
        B: room.players.B ? {
          name: room.players.B.name, displayName: playerDisplayName(room.players.B), profile: room.players.B.profile,
          profileReady: !!room.players.B.profileReady, ready: room.players.B.ready,
        } : null,
      },
      round: room.round,
      progress: room.progress,
      storyState: room.storyState,
      intro: room.intro || null,
      currentNode: room.currentNode,
      currentSummary: room.currentSummary,
      nextConfirm: room.nextConfirm,
      submitted: room.submitted,
      chosen: room.chosen,
      openingStatus: room.openingStatus,
      nextRoundStatus: room.nextRoundStatus,
      history: room.history,
      ending: room.ending,
      offSince: room.offSince,
      createdAt: room.createdAt,
    };
    fs.writeFileSync(path.join(ACTIVE_DIR, room.id + '.json'), JSON.stringify(snapshot), 'utf8');
  } catch (e) {
    console.warn('[存档] 进行中房间保存失败：', e.message);
  }
}

/** 删除进行中房间存档 */
export function removeActiveRoom(id) {
  try {
    fs.rmSync(path.join(ACTIVE_DIR, String(id) + '.json'), { force: true });
  } catch {}
}

/** 启动时恢复进行中的房间；返回恢复数量 */
export function loadActiveRooms() {
  if (!fs.existsSync(ACTIVE_DIR)) return 0;
  let restored = 0;
  for (const file of fs.readdirSync(ACTIVE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, file), 'utf8'));
      if (!data || typeof data !== 'object' || !data.id || data.status !== 'playing') {
        removeActiveRoom(file.replace(/\.json$/, ''));
        continue;
      }
      const worldbook = getWorldbook(data.worldbookId);
      if (!worldbook) {
        console.warn('[存档] 世界书不存在，跳过恢复：', data.worldbookId);
        removeActiveRoom(data.id);
        continue;
      }
      const room = {
        ...data,
        worldbook,
        players: {
          A: data.players?.A ? {
            ...data.players.A, displayName: data.players.A.displayName || data.players.A.name,
            profile: data.players.A.profile || { gender: '', personality: '', details: '' },
            profileReady: !!data.players.A.profileReady, sockId: null,
          } : null,
          B: data.players?.B ? {
            ...data.players.B, displayName: data.players.B.displayName || data.players.B.name,
            profile: data.players.B.profile || { gender: '', personality: '', details: '' },
            profileReady: !!data.players.B.profileReady, sockId: null,
          } : null,
        },
        openingNode: null,
        openingPromise: null,
        nextRoundNode: null,
        nextRoundPromise: null,
        processing: false,
        // 进程重启后所有 Socket 都已断开，应从本次启动重新计算离线超时。
        offSince: {
          A: data.players?.A ? Date.now() : null,
          B: data.players?.B ? Date.now() : null,
        },
      };
      rooms.set(room.id, room);
      restored += 1;
    } catch (e) {
      console.warn('[存档] 恢复房间失败：', file, e.message);
    }
  }
  return restored;
}

/** 读取全部历史记录（按结束时间倒序） */
export function listRoomHistory() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const filePath = path.join(HISTORY_DIR, f);
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { ...record, fileBytes: fs.statSync(filePath).size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
}

export function roomHistoryStorage() {
  let usedBytes = 0;
  let fileCount = 0;
  if (fs.existsSync(HISTORY_DIR)) {
    for (const file of fs.readdirSync(HISTORY_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        usedBytes += fs.statSync(path.join(HISTORY_DIR, file)).size;
        fileCount += 1;
      } catch {}
    }
  }
  return { usedBytes, limitBytes: ROOM_HISTORY_LIMIT_BYTES, fileCount };
}

/** 只按记录内部 id 定位并删除历史 JSON，绝不拼接用户输入为文件路径。 */
export function deleteRoomHistory(id) {
  const safeId = typeof id === 'string' ? id.trim() : '';
  if (!safeId || !fs.existsSync(HISTORY_DIR)) return false;
  for (const file of fs.readdirSync(HISTORY_DIR)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(HISTORY_DIR, file);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (record.id !== safeId) continue;
      fs.unlinkSync(filePath);
      return true;
    } catch {}
  }
  return false;
}

export function organizeStoryState(storyState, players = {}) {
  const source = storyState && !Array.isArray(storyState) && typeof storyState === 'object' ? storyState : {};
  const a = source.A && !Array.isArray(source.A) && typeof source.A === 'object' ? { ...source.A } : {};
  const b = source.B && !Array.isArray(source.B) && typeof source.B === 'object' ? { ...source.B } : {};
  const sharedSource = source.shared || source.共同 || source.公共;
  const shared = sharedSource && !Array.isArray(sharedSource) && typeof sharedSource === 'object' ? { ...sharedSource } : {};
  const sharedKeys = new Set(['位置', 'location', '场景', 'scene', '时间', 'time', '天气', 'weather', '共同目标', '队伍目标', 'team_goal', '共享物品', 'shared_inventory']);
  for (const key of sharedKeys) {
    if (key in a && key in b && JSON.stringify(a[key]) === JSON.stringify(b[key])) {
      if (!(key in shared)) shared[key] = a[key];
      delete a[key];
      delete b[key];
    }
  }
  a.name = playerDisplayName(players.A) || a.name || '玩家 A';
  b.name = playerDisplayName(players.B) || b.name || '玩家 B';
  return { ...source, A: a, B: b, shared };
}

const OPPONENT_PUBLIC_STATE_KEYS = new Set([
  'name', 'hp', 'health', 'status', 'condition', 'location', 'position', 'alignment', 'level', 'class',
  '生命', '生命值', '状态', '位置', '阵营', '等级', '职业', '境界', '外观',
]);

function visiblePlayerState(player, own) {
  if (!player || Array.isArray(player) || typeof player !== 'object') return {};
  const result = {};
  const publicPart = player._public || player.public || player.公开;
  const privatePart = player._private || player.private || player.私密;
  for (const [key, value] of Object.entries(player)) {
    if (key === '_public' || key === 'public' || key === '公开' || key === '_private' || key === 'private' || key === '私密') continue;
    if (/^_?flags?(?:_|$)/i.test(key)) continue;
    if (own || OPPONENT_PUBLIC_STATE_KEYS.has(key)) result[key] = value;
  }
  if (publicPart && !Array.isArray(publicPart) && typeof publicPart === 'object') Object.assign(result, publicPart);
  if (own && privatePart && !Array.isArray(privatePart) && typeof privatePart === 'object') Object.assign(result, privatePart);
  return result;
}

export function playerStoryStateView(storyState, viewerRole) {
  const source = storyState && !Array.isArray(storyState) && typeof storyState === 'object' ? storyState : {};
  const shared = source.shared && !Array.isArray(source.shared) && typeof source.shared === 'object' ? source.shared : {};
  return {
    A: visiblePlayerState(source.A, viewerRole === 'A'),
    B: visiblePlayerState(source.B, viewerRole === 'B'),
    shared,
  };
}

/** 推送给玩家的房间视图 */
export function publicRoomView(room) {
  return {
    code: room.code,
    status: room.status,
    round: room.round,
    progress: room.progress,
    players: {
      A: room.players.A ? {
        name: playerDisplayName(room.players.A), ready: room.players.A.ready, online: !!room.players.A.sockId,
        profile: room.players.A.profile || { gender: '', personality: '', details: '' },
        profileReady: !!room.players.A.profileReady,
      } : null,
      B: room.players.B ? {
        name: playerDisplayName(room.players.B), ready: room.players.B.ready, online: !!room.players.B.sockId,
        profile: room.players.B.profile || { gender: '', personality: '', details: '' },
        profileReady: !!room.players.B.profileReady,
      } : null,
    },
    worldbookId: room.worldbookId,
    openingStatus: room.openingStatus,
    currentNode: room.currentNode ? {
      round: room.round,
      narrative: room.currentNode.narrative,
      choices_A: room.currentNode.choices_A,
      choices_B: room.currentNode.choices_B,
      reveal: room.currentNode.reveal,
      story_state: room.currentNode.story_state,
      progress: room.progress,
    } : null,
    ending: room.ending,
  };
}

/** 两名玩家到齐后后台生成开场；开始按钮复用同一个 Promise，避免重复调用 AI。 */
export function preloadOpening(room, config, charCard) {
  if (room.status !== 'waiting') return Promise.resolve(room.openingNode);
  if (room.openingNode) return Promise.resolve(room.openingNode);
  if (room.openingPromise) return room.openingPromise;
  room.openingStatus = 'loading';
  room.openingPromise = generateNode(room, config, charCard, { kind: 'intro', history: room.history })
    .then((node) => {
      if (room.status === 'waiting') {
        room.openingNode = node;
        room.openingStatus = 'ready';
      }
      return node;
    })
    .catch((error) => {
      room.openingStatus = 'failed';
      throw error;
    })
    .finally(() => { room.openingPromise = null; });
  return room.openingPromise;
}

/** 房主开始：生成开场节点（含 intro 信息），进入 intro 阶段 */
export async function startRoom(room, config, charCard) {
  if (room.status !== 'waiting' || room.processing) return null;
  room.processing = true;
  try {
    const node = room.openingNode || await preloadOpening(room, config, charCard);
    if (room.status !== 'waiting' || !node) return null;
    room.openingNode = null;
    room.openingStatus = 'used';
    room.currentNode = node;
    room.intro = node.intro || null;
    room.round = 1;
    room.progress = 0;
    room.storyState = organizeStoryState(node.story_state, room.players);
    room.phase = 'intro';
    room.nextConfirm = { A: false, B: false };
    room.status = 'playing';
    saveActiveRoom(room);
    return node;
  } finally {
    room.processing = false;
  }
}

/** 双方提交后：生成本回合反馈（summary），进入 summary 阶段（或直接结束） */
export async function advanceRoom(room, config, charCard) {
  if (room.status !== 'playing' || room.processing) return null;
  if (!room.submitted.A || !room.submitted.B) return null;
  room.processing = true;
  const completed = room.currentNode
    ? {
        round: room.round,
        narrative: room.currentNode.narrative,
        choiceA: room.chosen.A,
        choiceB: room.chosen.B,
        reveal: room.currentNode.reveal,
        storyState: room.currentNode.story_state,
      }
    : null;
  const historyMaxRounds = Math.max(1, Number(config.game.historyMaxRounds) || 100);
  const nextHistory = (completed ? [...room.history, completed] : [...room.history])
    .slice(-historyMaxRounds);
  try {
    const node = await generateNode(room, config, charCard, {
      kind: 'summary',
      history: nextHistory,
      choiceA: room.chosen.A,
      choiceB: room.chosen.B,
    });
    room.history = nextHistory;
    room.progress = Math.max(room.progress, node.progress);
    room.storyState = node.story_state;
    room.currentSummary = {
      summary: node.summary || '（本回合没有新的变化）',
      storyState: node.story_state,
      progress: room.progress,
      round: room.round,
      choiceA: completed?.choiceA ?? null, // 反馈页揭晓双方选择
      choiceB: completed?.choiceB ?? null,
      ending: node.ending?.title ? node.ending : null,
    };
    room.chosen = { A: null, B: null };
    room.submitted = { A: false, B: false };
    room.nextConfirm = { A: false, B: false };
    if (room.currentSummary.ending || room.progress >= 1) {
      room.status = 'ended';
      room.phase = 'ended';
      room.ending =
        room.currentSummary.ending ||
        { title: '结局', text: node.summary || node.narrative || '故事走向了终点。' };
      saveRoomHistory(room);
      removeActiveRoom(room.id);
      return {
        type: 'ended',
        ending: room.ending,
        summary: node.summary,
        storyState: node.story_state,
        progress: room.progress,
        round: room.round,
      };
    }
    room.phase = 'summary';
    saveActiveRoom(room);
    preloadNextRound(room, config, charCard);
    return {
      type: 'summary',
      summary: node.summary,
      storyState: node.story_state,
      progress: room.progress,
      round: room.round,
    };
  } finally {
    room.processing = false;
  }
}

/** 记录一名玩家的「下一步/开始冒险」确认；双方都确认时返回 true */
export function confirmNext(room, role) {
  if (!room.players[role]) return false;
  room.nextConfirm[role] = true;
  saveActiveRoom(room);
  return !!(room.nextConfirm.A && room.nextConfirm.B);
}

/** 反馈页出现后立即后台生成下一轮；玩家是否点击“下一步”不影响预加载。 */
export function preloadNextRound(room, config, charCard) {
  if (room.status !== 'playing' || room.phase !== 'summary') return Promise.resolve(room.nextRoundNode);
  if (room.nextRoundNode) return Promise.resolve(room.nextRoundNode);
  if (room.nextRoundPromise) return room.nextRoundPromise;
  const sourceRound = room.round;
  room.nextRoundStatus = 'loading';
  room.nextRoundPromise = generateNode(room, config, charCard, {
    kind: 'round',
    history: [...room.history],
    summary: room.currentSummary?.summary,
  }).then((node) => {
    if (room.status === 'playing' && room.phase === 'summary' && room.round === sourceRound) {
      room.nextRoundNode = node;
      room.nextRoundStatus = 'ready';
    }
    return node;
  }).catch((error) => {
    room.nextRoundStatus = 'failed';
    console.warn('[GAME] 下一回合预加载失败：', error instanceof Error ? error.message : error);
    return null;
  }).finally(() => { room.nextRoundPromise = null; });
  return room.nextRoundPromise;
}

/** 双方确认后推进：intro → 首轮 round；summary → 生成下一轮 round */
export async function proceedNext(room, config, charCard) {
  if (room.status !== 'playing' || room.processing) return null;
  room.processing = true;
  try {
    if (room.phase === 'intro') {
      if (!room.players.A?.profileReady || !room.players.B?.profileReady) return null;
      const node = await generateNode(room, config, charCard, {
        kind: 'round', history: [], summary: '两位玩家已完成角色塑造，故事现在正式开始。',
      });
      if (!node) return null;
      room.currentNode = node;
      room.storyState = node.story_state;
      room.progress = node.progress;
      room.phase = 'round';
      room.nextConfirm = { A: false, B: false };
      saveActiveRoom(room);
      return { type: 'round', node };
    }
    if (room.phase === 'summary') {
      const node = room.nextRoundNode || await preloadNextRound(room, config, charCard);
      if (!node) return null;
      room.nextRoundNode = null;
      room.nextRoundStatus = 'used';
      room.round += 1;
      room.progress = Math.max(room.progress, node.progress);
      room.currentNode = node;
      room.storyState = node.story_state;
      room.phase = 'round';
      room.nextConfirm = { A: false, B: false };
      saveActiveRoom(room);
      return { type: 'round', node };
    }
    return null;
  } finally {
    room.processing = false;
  }
}

async function generateNode(room, config, charCard, { kind, history, choiceA, choiceB, summary }) {
  const scanDepth = Number.isInteger(room.worldbook.scan_depth)
    ? Math.max(0, room.worldbook.scan_depth)
    : Math.max(0, Number(config.game.scanDepth) || 0);
  const scanText =
    (summary ? `上轮总结:${summary} ` : '') +
    history
      .slice(-scanDepth)
      .map((h) => `${h.narrative} 玩家A:${h.choiceA || ''} 玩家B:${h.choiceB || ''}`)
      .join(' ') +
    (kind === 'intro' ? '' : ` 玩家A:${choiceA} 玩家B:${choiceB}`);
  const budget = Number.isFinite(room.worldbook.token_budget)
    ? room.worldbook.token_budget
    : config.game.worldbookTokenBudget;
  const activated = activateEntries(room.worldbook, scanText, { budget });
  const loreText = buildLoreText(room.worldbook, activated);

  let instruction;
  if (kind === 'intro') {
    instruction =
      '【指令】这是故事的开场，请一次性完成：1) intro.world 填写自然分段的世界观背景，intro.roleA/roleB 填写角色介绍；2) narrative 写出 2-4 个自然段的开场叙事，并用 **文字** 少量强调关键名词或变化；3) 给出双方第一轮选择；4) 初始化双方状态。';
  } else if (kind === 'summary') {
    instruction = `【本回合双方选择】\n玩家A：${choiceA}\n玩家B：${choiceB}\n【指令】总结本回合两位玩家行动的后果：summary 字段用 2-3 个自然段分别写清行动后果与状态变化，并用 **文字** 少量强调关键结果；更新 story_state（字段可自由增减）与 progress。若故事已到结局，ending.text 也必须自然分段。`;
  } else {
    instruction = `【上一回合结果】${summary || '（无）'}\n【指令】基于当前局势继续剧情：narrative 给出 2-4 个自然段，按场景与动作节奏换段，并用 **文字** 少量强调关键名词或变化；给出双方下一轮选择（choices_A / choices_B），更新 story_state 与 progress。`;
  }

  const system = buildSystemPrompt(charCard);
  const user = [
    loreText,
    `【玩家角色资料】\n玩家A：${JSON.stringify({ name: playerDisplayName(room.players.A) || '玩家A', ...(room.players.A?.profile || {}) })}\n玩家B：${JSON.stringify({ name: playerDisplayName(room.players.B) || '玩家B', ...(room.players.B?.profile || {}) })}\n叙事、选项和状态栏必须使用剧情昵称，并结合性别、性格与补充设定塑造角色。`,
    '【剧情历史】\n' + buildHistoryText(history, config.game.historyRounds),
    '【当前结构化状态】\n' + JSON.stringify(room.storyState || {}),
    `【当前进度】${Math.round(room.progress * 100)}%`,
    instruction,
  ]
    .filter(Boolean)
    .join('\n\n');

  // 调用 + 容错：解析失败或疑似截断时以更大 token 上限重试一次
  let raw = null;
  let parsed = null;
  const generationBudgetMs = Math.max(5000, Number(config.ai.timeoutMs) || 60000);
  const generationDeadline = Date.now() + generationBudgetMs;
  const initialMaxTokens = Math.min(4096, Math.max(1024, Number(config.ai.maxTokens) || 2048));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await callAI(
        config,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          maxTokens: attempt > 0 ? 8192 : initialMaxTokens,
          timeoutMs: Math.max(1000, generationDeadline - Date.now()),
        }
      );
    } catch (e) {
      console.warn('[LLM] 调用失败：', e.message);
      raw = null;
      break;
    }
    parsed = raw ? parseGameReply(raw) : null;
    if (parsed) break;
    if (attempt === 0 && raw) {
      console.warn('[LLM] 解析失败（可能输出被截断），以更大上限重试一次，RAW前200字：', raw.slice(0, 200));
    }
  }
  if (raw && !parsed) console.warn('[LLM] 重试后仍解析失败，降级为演示叙事');
  if (!raw) console.warn('[LLM] 无返回（可能超时或接口异常），kind=' + kind);
  const node = normalizeNode(parsed, {
    intro: kind === 'intro' ? {
      world: `${room.worldbook.description || room.worldbook.name || '一个等待书写的世界。'}\n\n命运的齿轮已经转动，两位冒险者即将在这里共同写下故事。`,
      roleA: `**${playerDisplayName(room.players.A) || '玩家 A'}**，你的旅程从此刻开始。`,
      roleB: `**${playerDisplayName(room.players.B) || '玩家 B'}**，你的选择将改变故事。`,
    } : null,
    narrative: mockNarrative(room.worldbook),
    choicesA: ['继续前行', '停留观察'],
    choicesB: ['继续前行', '停留观察'],
    storyState: room.storyState,
    summary: kind === 'summary' ? '（演示模式）本回合尘埃落定，两位玩家的选择各自产生了结果。\n\n新的线索浮现，**局势**也随之发生变化。' : null,
  });
  node.story_state = organizeStoryState(node.story_state, room.players);
  if (!parsed) node.progress = Math.min(1, room.progress + 0.25);
  else node.progress = Math.max(room.progress, node.progress);
  return node;
}
