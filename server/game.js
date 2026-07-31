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
    currentNode: null,
    currentSummary: null,
    nextConfirm: { A: false, B: false },
    submitted: { A: false, B: false },
    chosen: { A: null, B: null },
    openingNode: null,
    openingPromise: null,
    openingStatus: 'idle',
    history: [],
    processing: false,
    ending: null,
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

export function findRoomByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return [...rooms.values()].find((r) => r.code === c && r.status !== 'ended');
}

export function joinRoom(code, name, playerToken) {
  const room = findRoomByCode(code);
  if (!room) throw new Error('房间不存在或已结束');

  const safeName = typeof name === 'string' ? name.trim() : '';
  if (!safeName || safeName.length > 32) throw new Error('昵称长度必须为 1-32');

  if (playerToken) {
    const role = ['A', 'B'].find((r) => room.players[r]?.token === playerToken);
    if (role) {
      const nextToken = crypto.randomBytes(24).toString('base64url');
      room.players[role].token = nextToken;
      return { room, role, playerToken: nextToken, reconnected: true };
    }
  }

  // 页面刷新或更换浏览器后令牌可能丢失；允许用房间码 + 原昵称认领离线席位。
  const sameNameRole = ['A', 'B'].find((role) => {
    const player = room.players[role];
    return player && !player.sockId && player.name === safeName;
  });
  if (sameNameRole) {
    const nextToken = crypto.randomBytes(24).toString('base64url');
    room.players[sameNameRole].token = nextToken;
    return {
      room,
      role: sameNameRole,
      playerToken: nextToken,
      reconnected: true,
    };
  }

  if (room.status !== 'waiting') throw new Error('游戏已开始，仅原玩家可重连');
  if (['A', 'B'].some((role) => room.players[role]?.name === safeName)) {
    throw new Error('该昵称已在房间中');
  }
  // 空位优先；游戏未开始时，被离线玩家（无 socket 连接）占用的座位可被重新加入
  const role = !room.players.A || !room.players.A.sockId ? 'A' : !room.players.B || !room.players.B.sockId ? 'B' : null;
  if (!role) throw new Error('房间已满');
  const token = crypto.randomBytes(24).toString('base64url');
  room.players[role] = { name: safeName, ready: false, sockId: null, token };
  return { room, role, playerToken: token, reconnected: false };
}

/** 保存房间历史到磁盘（结束/关闭时调用，服务重启不丢失） */
export function saveRoomHistory(room) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const record = {
      id: room.id,
      code: room.code,
      worldbookId: room.worldbookId,
      players: { A: room.players.A?.name ?? null, B: room.players.B?.name ?? null },
      round: room.round,
      progress: room.progress,
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

/** 读取全部历史记录（按结束时间倒序） */
export function listRoomHistory() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
}

/** 推送给玩家的房间视图 */
export function publicRoomView(room) {
  return {
    code: room.code,
    status: room.status,
    round: room.round,
    progress: room.progress,
    players: {
      A: room.players.A ? { name: room.players.A.name, ready: room.players.A.ready, online: !!room.players.A.sockId } : null,
      B: room.players.B ? { name: room.players.B.name, ready: room.players.B.ready, online: !!room.players.B.sockId } : null,
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
    room.round = 1;
    room.progress = node.progress;
    room.storyState = node.story_state;
    room.phase = 'intro';
    room.nextConfirm = { A: false, B: false };
    room.status = 'playing';
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
  return !!(room.nextConfirm.A && room.nextConfirm.B);
}

/** 双方确认后推进：intro → 首轮 round；summary → 生成下一轮 round */
export async function proceedNext(room, config, charCard) {
  if (room.status !== 'playing' || room.processing) return null;
  room.processing = true;
  try {
    if (room.phase === 'intro') {
      room.phase = 'round';
      return { type: 'round', node: room.currentNode };
    }
    if (room.phase === 'summary') {
      const node = await generateNode(room, config, charCard, {
        kind: 'round',
        history: room.history,
        summary: room.currentSummary?.summary,
      });
      room.round += 1;
      room.progress = Math.max(room.progress, node.progress);
      room.currentNode = node;
      room.storyState = node.story_state;
      room.phase = 'round';
      room.nextConfirm = { A: false, B: false };
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
      '【指令】这是故事的开场，请一次性完成：1) intro 字段填写世界观背景简介与玩家A、玩家B各自的角色介绍；2) narrative 写出开场叙事（2-4段）；3) 给出双方第一轮选择；4) 初始化双方状态。';
  } else if (kind === 'summary') {
    instruction = `【本回合双方选择】\n玩家A：${choiceA}\n玩家B：${choiceB}\n【指令】总结本回合两位玩家行动的后果：summary 字段给出结果反馈（2-4句，面向双方），更新 story_state（字段可自由增减）与 progress。若故事已到结局则填 ending。`;
  } else {
    instruction = `【上一回合结果】${summary || '（无）'}\n【指令】基于当前局势继续剧情：narrative 给出下一段叙事（2-4段），给出双方下一轮选择（choices_A / choices_B），更新 story_state 与 progress。`;
  }

  const system = buildSystemPrompt(charCard);
  const user = [
    loreText,
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
    narrative: mockNarrative(room.worldbook),
    choicesA: ['继续前行', '停留观察'],
    choicesB: ['继续前行', '停留观察'],
    storyState: room.storyState,
    summary: kind === 'summary' ? '（演示模式）本回合尘埃落定，两位玩家的选择带来了新的变数。' : null,
  });
  if (!parsed) node.progress = Math.min(1, room.progress + 0.25);
  else node.progress = Math.max(room.progress, node.progress);
  return node;
}
