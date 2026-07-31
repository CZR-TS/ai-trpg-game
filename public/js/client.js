// ============================================================
// 客户端抽象层：GameClient（基类，定义契约）+ MockClient + SocketClient
// 业务层只调 window.client，方法签名与事件名对齐后端契约。
// USE_MOCK = true  → MockClient（内存模拟，无需后端，file:// 可直接跑通全流程）
// USE_MOCK = false → SocketClient（fetch + socket.io 连真实后端，契约零改动）
// ============================================================

const USE_MOCK = false;

// ---- 工具 ----
class EventBus {
  constructor() { this._h = {}; }
  on(e, cb) { (this._h[e] ||= []).push(cb); return this; }
  off(e, cb) { this._h[e] = (this._h[e] || []).filter(f => f !== cb); return this; }
  emit(e, p) { (this._h[e] || []).forEach(cb => cb(p)); }
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pickN = (arr, n) => {
  const pool = arr.slice(), out = [];
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) out.push(pool.splice(rand(0, pool.length - 1), 1)[0]);
  return out;
};
// 8 位房间码（大小写数字，去掉易混淆字符）
const genRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[rand(0, chars.length - 1)];
  return s;
};

// ============================================================
// GameClient：契约基类（各方法见注释；MockClient / SocketClient 各自实现）
// ============================================================
class GameClient {
  // ---- REST（管理员；未登录返回 { ok:false, error, status:401 }）----
  async login(payload) {}                // POST /api/auth/login            {username,password} → {ok,username}
  async me() {}                          // GET  /api/auth/me               → {ok,username} | {ok:false,status:401}
  async logout() {}                      // POST /api/auth/logout           → {ok}
  async listWorldbooks() {}              // GET  /api/admin/worldbooks      → {worldbooks:[{id,name,builtin,entryCount}], current}
  async importWorldbook(payload) {}      // POST /api/admin/worldbooks      {id?,name,content} → {id,name}
  async selectWorldbook(id) {}           // POST /api/admin/worldbooks/:id/select → {ok,current}
  async createRoom(payload) {}           // POST /api/admin/rooms           {worldbookId?} → {roomId,code}
  async listRooms() {}                   // GET  /api/admin/rooms           → {rooms:[{id,code,status,round,progress,worldbookId,players}]}
  async listRoomHistory() {}             // GET  /api/admin/rooms/history   → {history:[...]}
  async getRoom(id) {}                   // GET  /api/admin/rooms/:id       → {room}（含 history/ending）
  async closeRoom(id) {}                 // POST /api/admin/rooms/:id/close → {ok}
  // ---- Socket（玩家）----
  on(e, cb) {}
  off(e, cb) {}
  async join(payload) {}                 // emit room:join {roomCode,name} → ack {ok,roomId,role} | {ok:false,error}
  async setReady() {}                    // emit room:ready
  async startGame() {}                   // emit game:start
  async submitChoice(choiceId) {}        // emit game:choice {choiceId}
  async advance() {}                     // emit game:advance
  async next() {}                        // emit game:next（双方确认「开始冒险 / 下一步」）
  async leave() {}                       // emit room:leave，主动离开当前房间
}

// ============================================================
// MockClient：内存态模拟完整链路，模拟网络/AI 延迟
// 无预设剧情链、无结局判定规则：
//  - 每次"AI 推进"从场景池随机取材，即兴拼单段叙事 + 双方 2-3 个选项（每回合不同）
//  - reveal 随机 true/false，纯数据驱动
//  - story_state 随机小幅漂移模拟 AI 维护，不绑定选项
//  - 进度到顶 → "AI 判定中…"（game:judging，mock 附加事件）→ 即兴取一段结局文本
// ============================================================
class MockClient extends GameClient {
  constructor() {
    super();
    this.bus = new EventBus();
    this.worldbooks = JSON.parse(JSON.stringify(window.WORLDBOOKS));
    this.currentWorldbookId = this.worldbooks[0].id;
    this.rooms = {};           // roomId -> room
    this.adminLoggedIn = false;
    this.me = null;            // { role, name }（当前浏览器会话的玩家身份）
    this.currentRoomId = null;
  }

  on(e, cb) { this.bus.on(e, cb); return this; }
  off(e, cb) { this.bus.off(e, cb); return this; }

  // ============ REST：管理员 ============
  // mock 门禁：任意非空账号密码通过（无后端，仅演示门禁流程）
  async login({ username, password }) {
    await delay(450);
    if (!username || !password) return { ok: false, error: '账号或密码错误', status: 401 };
    this.adminLoggedIn = true;
    return { ok: true, username };
  }
  async logout() { await delay(150); this.adminLoggedIn = false; return { ok: true }; }
  async me() { await delay(80); return this.adminLoggedIn ? { ok: true, username: 'admin' } : { ok: false, error: '未登录', status: 401 }; }

  // 会话校验（模拟 HttpOnly cookie）：未登录返回 401
  _guardAdmin() { return this.adminLoggedIn ? null : { ok: false, error: '未登录', status: 401 }; }

  async listWorldbooks() {
    await delay(120);
    const g = this._guardAdmin(); if (g) return g;
    const worldbooks = this.worldbooks.map(w => ({ id: w.id, name: w.name, builtin: !!w.builtin, entryCount: w.entryCount, description: w.description }));
    return { worldbooks, current: this.currentWorldbookId };
  }
  // 导入世界书：content 为已解析的世界书 JSON 对象（SillyTavern 兼容格式）
  async importWorldbook({ name, content }) {
    await delay(300);
    const g = this._guardAdmin(); if (g) return g;
    const entries = content && content.entries ? Object.entries(content.entries) : [];
    const wb = {
      id: 'imported-' + Date.now(),
      name: name || (content && content.name) || '未命名世界书',
      builtin: false,
      description: (content && content.description) || '',
      entryCount: entries.length,
      content,
    };
    this.worldbooks.push(wb);
    return { id: wb.id, name: wb.name };
  }
  async selectWorldbook(id) {
    await delay(120);
    const g = this._guardAdmin(); if (g) return g;
    if (!this.worldbooks.some(w => w.id === id)) return { ok: false, error: '世界书不存在', status: 404 };
    this.currentWorldbookId = id;
    return { ok: true, current: id };
  }
  async createRoom({ worldbookId } = {}) {
    await delay(500);
    const g = this._guardAdmin(); if (g) return g;
    const wbId = worldbookId || this.currentWorldbookId;
    const room = {
      id: 'room-' + Date.now(),
      code: genRoomCode(),
      status: 'lobby',       // lobby → playing → judging → ended
      worldbookId: wbId,
      worldbookName: (this.worldbooks.find(w => w.id === wbId) || {}).name || '未知世界书',
      round: 0,
      progress: 0,
      players: { A: null, B: null },
      storyState: null,
      currentNode: null,
      submitted: { A: false, B: false },
      choices: { A: null, B: null },
      history: [],
      ending: null,
      createdAt: Date.now(),
    };
    this.rooms[room.id] = room;
    return { roomId: room.id, code: room.code };
  }
  async listRooms() {
    await delay(150);
    const g = this._guardAdmin(); if (g) return g;
    return { rooms: Object.values(this.rooms).sort((a, b) => b.createdAt - a.createdAt).map(r => this._publicRoom(r)) };
  }
  async listRoomHistory() {
    await delay(120);
    const g = this._guardAdmin(); if (g) return g;
    const history = Object.values(this.rooms)
      .filter((room) => room.status === 'ended')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => ({ ...this._publicRoom(room), endedAt: room.endedAt || room.createdAt }));
    return { history };
  }
  async getRoom(id) {
    await delay(120);
    const g = this._guardAdmin(); if (g) return g;
    const room = this.rooms[id];
    return room ? { room: this._publicRoom(room) } : { ok: false, error: '房间不存在', status: 404 };
  }
  async closeRoom(id) {
    await delay(200);
    const g = this._guardAdmin(); if (g) return g;
    const room = this.rooms[id];
    if (!room) return { ok: false, error: '房间不存在', status: 404 };
    room.status = 'ended';
    return { ok: true };
  }

  // ============ Socket：玩家 ============
  // 凭房间码 + 昵称加入（无需账号）。组织者不占玩家位。
  async join({ roomCode, name }) {
    await delay(450);
    const room = Object.values(this.rooms).find(r => r.code === roomCode);
    if (!room) return { ok: false, error: '房间码无效' };
    if (room.status !== 'lobby') return { ok: false, error: '游戏已开始，无法加入' };
    let role = null;
    if (!room.players.A) role = 'A';
    else if (!room.players.B) role = 'B';
    else return { ok: false, error: '房间已满' };
    room.players[role] = { name, ready: false };
    this.me = { role, name };
    this.currentRoomId = room.id;
    this.bus.emit('room:state', { room: this._publicRoom(room) });
    this.bus.emit('player:joined', { role, name });
    // mock：若我是 A，则延时自动让 B（AI 扮演的另一名玩家）加入并准备
    if (role === 'A') this._scheduleBotJoin(room);
    return { ok: true, roomId: room.id, role };
  }

  async setReady() {
    await delay(200);
    const room = this._myRoom();
    if (!room || !this.me || room.status !== 'lobby') return { ok: false };
    const ready = !room.players[this.me.role].ready;
    room.players[this.me.role].ready = ready;
    this.bus.emit('player:ready', { role: this.me.role, ready });
    this.bus.emit('room:state', { room: this._publicRoom(room) });
    return { ok: true };
  }

  async startGame() {
    await delay(400);
    const room = this._myRoom();
    if (!room) return { ok: false };
    const { A, B } = room.players;
    if (!(A && B && A.ready && B.ready)) return { ok: false, error: '双方尚未准备' };
    room.status = 'playing';
    room.phase = 'intro';
    room.round = 1;
    room.progress = 0;
    room.storyState = {
      A: { name: A.name, hp: 100, resources: 3, alignment: 0 },
      B: { name: B.name, hp: 100, resources: 3, alignment: 0 },
    };
    room.history = [];
    room.nextConfirm = { A: false, B: false };
    room.currentSummary = null;
    // 开场：AI 生成开场节点（含 intro 背景信息），进入 intro 阶段
    const node = this._buildNode(room, 'intro');
    room.currentNode = node;
    this.bus.emit('room:state', { room: this._publicRoom(room) });
    this.bus.emit('game:started', { code: room.code });
    this.bus.emit('game:intro', this._introPayload(room, node));
    return { ok: true };
  }

  async submitChoice(choiceId) {
    await delay(250);
    const room = this._myRoom();
    if (!room || !this.me || !room.currentNode) return { ok: false };
    room.choices[this.me.role] = choiceId;
    room.submitted[this.me.role] = true;
    // 通知对方「我已选择」：reveal=true 时附选择文本，reveal=false 时不附（封缄）
    // 自定义行动时也把文本带过去（公开回合）
    const node = room.currentNode;
    this.bus.emit('game:choice_update', {
      role: this.me.role, chosen: true,
      ...(node.reveal ? { choiceText: String(choiceId) } : {}),
    });
    // mock：若是 A，则延时让 B（bot）自动选择
    if (this.me.role === 'A') this._scheduleBotChoice(room);
    return { ok: true };
  }

  // 双方都提交后由前端「AI 推进」触发：生成本回合反馈，进入 summary 阶段
  async advance() {
    const room = this._myRoom();
    if (!room || room._advancing) return { ok: false };
    if (room.status !== 'playing' || room.phase !== 'round') return { ok: false, error: '游戏未在进行中' };
    if (!(room.submitted.A && room.submitted.B)) return { ok: false, error: '等待双方提交' };
    room._advancing = true;

    // 归档本回合（含双方选择，结局回顾 / 封缄事后揭秘用）
    room.history.push({
      round: room.round, node: room.currentNode,
      choices: this._resolveChoices(room, room.currentNode),
    });

    await delay(1300); // 模拟「AI 编织本回合结果中」
    const summary = this._buildSummary(room);
    room.storyState = this._nextStoryState(room);
    room.progress = Math.min(1, room.progress + rand(16, 26) / 100);
    room.currentSummary = {
      summary,
      storyState: JSON.parse(JSON.stringify(room.storyState)),
      progress: room.progress,
      round: room.round,
      choiceA: room.choices.A,
      choiceB: room.choices.B,
    };
    room.choices = { A: null, B: null };
    room.submitted = { A: false, B: false };
    room.nextConfirm = { A: false, B: false };
    room._advancing = false;

    if (room.progress >= 1) {
      // 结局：AI 判定中 → 即兴取一段结局文本
      room.status = 'judging';
      this.bus.emit('game:judging', {});
      this.bus.emit('room:state', { room: this._publicRoom(room) });
      await delay(2000);
      const ending = this._buildEnding(room);
      room.ending = ending;
      room.status = 'ended';
      this.bus.emit('room:state', { room: this._publicRoom(room) });
      this.bus.emit('game:ended', { ending, summary, progress: 1 });
      return { ok: true };
    }

    room.phase = 'summary';
    this.bus.emit('room:state', { room: this._publicRoom(room) });
    this.bus.emit('game:summary', this._summaryPayload(room));
    return { ok: true };
  }

  async leave() {
    const room = this._myRoom();
    if (!room || !this.me) return { ok: true, reconnectable: false };
    room.players[this.me.role] = null;
    this.me = null;
    this.currentRoomId = null;
    this.bus.emit('room:state', { room: this._publicRoom(room) });
    return { ok: true, reconnectable: false };
  }

  // 双方确认「开始冒险 / 下一步」：都确认后推进（intro→首轮；summary→下一轮）
  async next() {
    const room = this._myRoom();
    if (!room || !this.me) return { ok: false };
    if (room.phase !== 'intro' && room.phase !== 'summary') return { ok: false, error: '当前阶段不能确认' };
    if (room.nextConfirm[this.me.role]) return { ok: false, error: '已确认，等待对方' };
    room.nextConfirm[this.me.role] = true;
    this.bus.emit('game:next_update', { role: this.me.role, confirmed: true });
    this._tryProceed(room);
    // mock：bot 自动确认
    if (this.me.role === 'A' && !room.nextConfirm.B) this._scheduleBotNext(room);
    return { ok: true };
  }

  _scheduleBotNext(room) {
    setTimeout(() => {
      if (room.nextConfirm.B || room.status !== 'playing') return;
      room.nextConfirm.B = true;
      this.bus.emit('game:next_update', { role: 'B', confirmed: true });
      this._tryProceed(room);
    }, 1000);
  }

  async _tryProceed(room) {
    if (!(room.nextConfirm.A && room.nextConfirm.B)) return;
    if (room.phase === 'intro') {
      room.phase = 'round';
      this.bus.emit('room:state', { room: this._publicRoom(room) });
      this.bus.emit('game:round', this._nodePayload(room.currentNode));
      return;
    }
    if (room.phase === 'summary') {
      await this._buildNextRound(room);
    }
  }

  async _buildNextRound(room) {
    await delay(1300); // 模拟「AI 编织下一段剧情中」
    const node = this._buildNode(room, 'round');
    room.round += 1;
    room.currentNode = node;
    room.phase = 'round';
    room.nextConfirm = { A: false, B: false };
    this.bus.emit('room:state', { room: this._publicRoom(room) });
    this.bus.emit('game:round', this._nodePayload(node));
  }

  // ============ mock 内部辅助 ============
  _myRoom() { return this.currentRoomId ? this.rooms[this.currentRoomId] : null; }

  // 对外房间快照（封缄回合不暴露对方具体选择 id）
  _publicRoom(room) {
    const r = JSON.parse(JSON.stringify(room));
    if (r.currentNode && r.currentNode.reveal === false) r.choices = { A: null, B: null };
    return r;
  }

  // game:intro 载荷
  _introPayload(room, node) {
    return {
      code: room.code,
      worldbookId: room.worldbookId,
      intro: node.intro || {},
      round: room.round,
    };
  }

  // game:summary 载荷
  _summaryPayload(room) {
    const s = room.currentSummary || {};
    return {
      round: s.round, summary: s.summary || '',
      storyState: s.storyState || {}, progress: room.progress,
      choiceA: s.choiceA ?? null, choiceB: s.choiceB ?? null,
    };
  }

  // game:round 载荷（契约字段，扁平结构）
  _nodePayload(node) {
    return {
      round: node.round, narrative: node.narrative,
      choices_A: node.choices_A, choices_B: node.choices_B,
      reveal: node.reveal, story_state: node.story_state, progress: node.progress,
    };
  }

  // 对方（bot）自动加入并准备
  _scheduleBotJoin(room) {
    setTimeout(() => {
      if (room.players.B || room.status !== 'lobby') return;
      const botNames = ['灰袍旅人', '影行者', '无名客', '夜枭'];
      room.players.B = { name: pick(botNames), ready: false };
      this.bus.emit('player:joined', { role: 'B', name: room.players.B.name });
      setTimeout(() => {
        if (!room.players.B || room.status !== 'lobby') return;
        room.players.B.ready = true;
        this.bus.emit('player:ready', { role: 'B', ready: true });
        this.bus.emit('room:state', { room: this._publicRoom(room) });
      }, 900);
    }, 1400);
  }

  // 对方（bot）自动选择（仅在我为 A、本回合已提交后调度）
  _scheduleBotChoice(room) {
    setTimeout(() => {
      if (room.submitted.B || room.status !== 'playing') return;
      const opts = room.currentNode ? room.currentNode.choices_B : [];
      if (!opts.length) return;
      const c = pick(opts);
      room.choices.B = c.id;
      room.submitted.B = true;
      const node = room.currentNode;
      this.bus.emit('game:choice_update', {
        role: 'B', chosen: true,
        ...(node.reveal && c ? { choiceText: c.text } : {}),
      });
    }, 1200);
  }

  // 即兴拼一段叙事（非固定剧情链）：随机抽场景 → 随机叙事变体 → 随机给双方 2-3 个选项
  // kind='intro' 时额外生成 intro 背景信息（世界观 + 双方角色介绍）
  _buildNode(room, kind) {
    const used = room.history.map(h => h.node && h.node._sceneId);
    let pool = window.MOCK_SCENES.filter(s => !used.includes(s.id));
    if (!pool.length) pool = window.MOCK_SCENES.slice();
    const scene = pick(pool);
    const narrative = pick(scene.narratives);
    const mk = (list, role) => pickN(list, rand(2, 3)).map((text, i) => ({ id: scene.id + '-' + role + '-' + i, text }));
    const choices_A = mk(scene.optionsA, 'a');
    const choices_B = mk(scene.optionsB, 'b');
    // reveal：由"AI"数据驱动随机生成 true/false
    let reveal = Math.random() < 0.5;
    const lastTwo = room.history.slice(-2).map(h => h.node && h.node.reveal);
    if (lastTwo.length >= 2 && lastTwo[0] === lastTwo[1] && lastTwo[1] === reveal) reveal = !reveal;
    return {
      round: room.round, _sceneId: scene.id,
      intro: kind === 'intro' ? this._buildIntro(room) : null,
      narrative, choices_A, choices_B, reveal,
      story_state: JSON.parse(JSON.stringify(room.storyState)),
      progress: room.progress,
    };
  }

  // intro 背景信息：世界观简介 + 双方角色介绍（模拟 AI 开场生成）
  _buildIntro(room) {
    const wb = this.worldbooks.find(w => w.id === room.worldbookId) || this.worldbooks[0];
    const aName = room.players.A ? room.players.A.name : '玩家A';
    const bName = room.players.B ? room.players.B.name : '玩家B';
    return {
      world: '《' + (wb.name || '命运之书') + '》：' +
        (wb.description || '这片大陆被遗忘的传说重新苏醒，黑暗的阴影正缓缓蔓延。两位被命运选中的旅人，将在未知的旅途中写下自己的故事——他们的每一个选择，都将成为历史的一页。'),
      roleA: '玩家A · ' + aName + '：来自远方的旅人，身负不为人知的使命。勇气与犹疑并存，命运尚未揭示他的答案。',
      roleB: '玩家B · ' + bName + '：与' + aName + '同行的旅人，观察敏锐，心中自有盘算。两人的选择将彼此牵动，共享同一个结局。',
    };
  }

  // 本回合结果反馈（模拟 AI 总结，无预设规则）
  _buildSummary(room) {
    const aName = (room.players.A && room.players.A.name) || '玩家A';
    const bName = (room.players.B && room.players.B.name) || '玩家B';
    const ca = room.choices.A || '静观其变';
    const cb = room.choices.B || '静观其变';
    return '（演示模式）本回合落幕：' + aName + '的「' + ca + '」与' + bName + '的「' + cb + '」交织出新的涟漪，局势悄然生变，命运的丝线随之颤动。';
  }

  // 本回合双方选择（id → 文本），结局回顾用
  _resolveChoices(room, node) {
    const res = {};
    ['A', 'B'].forEach(role => {
      const cid = room.choices[role];
      const list = role === 'A' ? node.choices_A : node.choices_B;
      const opt = list.find(o => o.id === cid);
      res[role] = { text: opt ? opt.text : '（未选择）' };
    });
    return res;
  }

  // 模拟 AI 维护双方状态：随机小幅漂移，无预设规则
  _nextStoryState(room) {
    const s = JSON.parse(JSON.stringify(room.storyState));
    ['A', 'B'].forEach(role => {
      const p = s[role];
      p.hp = Math.max(5, Math.min(100, p.hp + rand(-12, 6)));
      p.resources = Math.max(0, Math.min(10, p.resources + (Math.random() < 0.35 ? rand(-1, 1) : 0)));
      p.alignment = Math.max(-100, Math.min(100, p.alignment + rand(-10, 12)));
    });
    return s;
  }

  // 即兴结局：随机取一段结局文本（无判定规则，模拟 AI 综合全程选择生成）
  _buildEnding(room) {
    const tpl = pick(window.MOCK_ENDINGS);
    return {
      title: tpl.title,
      text: tpl.text,
      history: room.history.map(h => ({
        round: h.round,
        reveal: h.node.reveal,
        narrative: h.node.narrative,
        choices: h.choices || null,
      })),
    };
  }
}

// ============================================================
// SocketClient：连真实后端（fetch + socket.io）
// 方法签名与事件名与 MockClient 完全一致，业务零改动
// ============================================================
class SocketClient extends GameClient {
  constructor(opts = {}) {
    super();
    this.baseUrl = opts.baseUrl || '';
    this.bus = new EventBus();
    this.socket = null;
    this.storageKey = 'trpg-player-session-v1';
    const saved = this._loadSession();
    this.lastJoin = saved ? { roomCode: saved.roomCode, name: saved.name } : null;
    this.playerToken = saved?.playerToken || null;
    this.needsReconnect = false;
  }

  _loadSession() {
    try {
      const value = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
      return value?.roomCode && value?.name && value?.playerToken ? value : null;
    } catch { return null; }
  }

  _saveSession() {
    if (!this.lastJoin || !this.playerToken) return;
    try { localStorage.setItem(this.storageKey, JSON.stringify({ ...this.lastJoin, playerToken: this.playerToken })); } catch {}
  }

  _clearSession() {
    this.lastJoin = null;
    this.playerToken = null;
    try { localStorage.removeItem(this.storageKey); } catch {}
  }

  on(e, cb) { this._connect(); this.bus.on(e, cb); return this; }
  off(e, cb) { this.bus.off(e, cb); return this; }

  _connect() {
    if (this.socket) return;
    if (!window.io) throw new Error('未加载 socket.io 客户端库，请检查网络或引入脚本');
    this.socket = window.io(this.baseUrl, { withCredentials: true });
    const events = [
      'room:state', 'player:joined', 'player:reconnected', 'player:disconnected',
      'player:ready', 'game:started', 'game:intro', 'game:round', 'game:choice_update',
      'game:summary', 'game:next_update', 'game:judging', 'game:ended',
    ];
    events.forEach((event) => this.socket.on(event, (payload) => {
      if (event === 'game:ended') this._clearSession();
      this.bus.emit(event, payload);
    }));
    this.socket.on('disconnect', () => {
      this.needsReconnect = true;
      this.bus.emit('connection:error', { error: '与服务器连接中断，正在等待自动重连' });
    });
    this.socket.on('connect', () => {
      if (!this.needsReconnect || !this.lastJoin || !this.playerToken) return;
      this.needsReconnect = false;
      this.socket.emit('room:join', { ...this.lastJoin, playerToken: this.playerToken }, (ack) => {
        if (ack?.ok && ack.playerToken) {
          this.playerToken = ack.playerToken;
          this._saveSession();
        } else if (!ack?.ok) {
          this.bus.emit('connection:error', ack || { error: '自动重连失败' });
        }
      });
    });
  }

  async _req(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ...data, status: res.status };
    return data;
  }

  async login(payload) { return this._req('POST', '/api/auth/login', payload); }
  async me() { return this._req('GET', '/api/auth/me'); }
  async logout() { await this._req('POST', '/api/auth/logout'); return { ok: true }; }
  async listWorldbooks() { return this._req('GET', '/api/admin/worldbooks'); }
  async importWorldbook(payload) { return this._req('POST', '/api/admin/worldbooks', payload); }
  async selectWorldbook(id) { return this._req('POST', '/api/admin/worldbooks/' + encodeURIComponent(id) + '/select'); }
  async createRoom(payload) { return this._req('POST', '/api/admin/rooms', payload || {}); }
  async listRooms() { return this._req('GET', '/api/admin/rooms'); }
  async listRoomHistory() { return this._req('GET', '/api/admin/rooms/history'); }
  async getRoom(id) { return this._req('GET', '/api/admin/rooms/' + encodeURIComponent(id)); }
  async closeRoom(id) { return this._req('POST', '/api/admin/rooms/' + encodeURIComponent(id) + '/close'); }

  async join(payload) {
    const identity = {
      roomCode: String(payload.roomCode || '').trim().toUpperCase(),
      name: String(payload.name || '').trim(),
    };
    const previous = this.lastJoin;
    const sameIdentity = previous
      && previous.roomCode === identity.roomCode
      && previous.name === identity.name;
    const reconnectToken = sameIdentity ? this.playerToken : null;
    this.lastJoin = identity;
    const ack = await this._emitAck('room:join', {
      ...identity,
      playerToken: payload.playerToken || reconnectToken,
    });
    if (ack?.ok && ack.playerToken) {
      this.playerToken = ack.playerToken;
      this._saveSession();
    }
    return ack;
  }

  _emitAck(event, payload = {}, timeoutMs = 15000) {
    return new Promise((resolve) => {
      this._connect();
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: '服务器响应超时，请检查连接后重试' }), timeoutMs);
      this.socket.emit(event, payload, (ack) => finish(ack || { ok: false, error: '服务器未确认请求' }));
    });
  }

  setReady() { return this._emitAck('room:ready'); }
  startGame() { return this._emitAck('game:start', {}, 70000); }
  submitChoice(choiceId) { return this._emitAck('game:choice', { choiceId }); }
  advance() { return this._emitAck('game:advance'); }
  next() { return this._emitAck('game:next'); }
  async leave() {
    if (!this.socket || !this.lastJoin) return { ok: true, reconnectable: false };
    const ack = await this._emitAck('room:leave');
    if (ack?.ok && !ack.reconnectable) {
      this._clearSession();
    }
    return ack;
  }
}

// 全局实例：接真后端时把 USE_MOCK 改为 false
window.client = USE_MOCK ? new MockClient() : new SocketClient();
