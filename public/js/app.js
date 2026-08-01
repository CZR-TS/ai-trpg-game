// 主控：6 视图状态机 + 事件绑定 + 渲染
// 业务只调 window.client.xxx()，订阅 client 事件驱动渲染（事件名对齐后端契约）

(function () {
  const client = window.client;
  const $ = (id) => document.getElementById(id);
  const OPP = (role) => (role === 'A' ? 'B' : 'A');

  const state = {
    view: 'admin-login',   // admin-login | admin-panel | player-entry | lobby | game | ending
    playerView: 'player-entry',
    adminView: 'admin-login',
    admin: { loggedIn: false, worldbooks: [], current: null, rooms: [], history: [], storage: { usedBytes: 0, limitBytes: 200 * 1024 * 1024, fileCount: 0 }, lastRoom: null, online: { count: 0, rooms: [] } },
    room: null,            // 房间全量镜像（room:state 推送）
    me: null,              // { role, name }
    game: { phase: 'intro', intro: null, summary: null, next: { me: false, opp: false }, starting: false }, // intro | round | summary | judging | ended
    turn: { myChoiceId: null, submitted: false, oppSubmitted: false, oppChoiceText: null, advancing: false, advanceFailed: false, judging: false, customText: null },
    oppOffline: false, // 对方是否离线（游戏中）
  };

  // ============ 明暗主题 ============
  const THEME_KEY = 'trpg_theme_v1';
  function applyTheme(theme, persist = true) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    const button = $('theme-toggle');
    if (button) {
      const dark = next === 'dark';
      const label = dark ? '切换到明色模式' : '切换到暗色模式';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(dark));
      UI.clear(button);
      button.appendChild(UI.icon(dark ? 'sun' : 'moon'));
      UI.refreshIcons();
    }
    if (persist) {
      try { localStorage.setItem(THEME_KEY, next); } catch {}
    }
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // ============ 视图切换 ============
  const ADMIN_VIEWS = new Set(['admin-login', 'admin-panel']);
  const PLAYER_VIEWS = new Set(['player-entry', 'lobby', 'game', 'ending']);
  const WORKSPACE_KEY = 'trpg_workspace_v1';
  const isAdminView = (name) => ADMIN_VIEWS.has(name);

  function saveActiveWorkspace(workspace) {
    try { localStorage.setItem(WORKSPACE_KEY, workspace); } catch {}
  }

  function loadActiveWorkspace() {
    try { return localStorage.getItem(WORKSPACE_KEY); } catch { return null; }
  }

  function switchView(name) {
    state.view = name;
    if (ADMIN_VIEWS.has(name)) state.adminView = name;
    if (PLAYER_VIEWS.has(name)) state.playerView = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('view-active', v.dataset.view === name));
    const isAdmin = isAdminView(name);
    document.querySelectorAll('.role-switch .link').forEach(b => b.classList.toggle('is-active', (b.dataset.role === 'admin') === isAdmin));
    render();
    window.scrollTo(0, 0);
  }


  function showPlayerView(name) {
    state.playerView = name;
    if (isAdminView(state.view)) return;
    if (state.view !== name) switchView(name); else render();
  }
  function render() {
    switch (state.view) {
      case 'admin-panel': renderAdminPanel(); break;
      case 'lobby': renderLobby(); break;
      case 'game': renderGame(); break;
      case 'ending': renderEnding(); break;
    }
    UI.refreshIcons();
  }

  function resetTurn() {
    state.turn = { myChoiceId: null, submitted: false, oppSubmitted: false, oppChoiceText: null, advancing: false, advanceFailed: false, judging: false, customText: null };
    typedDone = { narrative: null, summary: null };
  }
  // ============ 浏览器会话持久化（刷新/重开页面后自动恢复）============
  const SESSION_KEY = 'trpg_session_v1';
  function saveSession(roomCode, name) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, name })); } catch {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  async function leaveCurrentRoom() {
    if (state.me) await client.leave();
    clearGenerations();
    state.room = null;
    state.me = null;
    state.oppOffline = false;
    clearSession();
    resetTurn();
  }

  // ============ 通用辅助 ============
  function copyText(text) {
    // 局域网 IP（非 HTTPS）下 navigator.clipboard 不可用，用兼容方案
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        () => UI.toast('已复制：' + text),
        () => legacyCopy(text)
      );
    } else {
      legacyCopy(text);
    }
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatTokens(value) {
    const amount = Math.max(0, Number(value) || 0);
    if (amount < 1000) return String(Math.round(amount));
    if (amount < 1000000) return (amount / 1000).toFixed(amount < 10000 ? 1 : 0) + 'K';
    return (amount / 1000000).toFixed(amount < 10000000 ? 1 : 0) + 'M';
  }

  function tokenUsageNode(usage, extraClass = '') {
    const current = usage || {};
    const windowTokens = formatTokens(current.contextWindowTokens || 1000000);
    const context = formatTokens(current.lastContextTokens);
    const request = formatTokens(current.lastRequestTokens);
    const requestCached = formatTokens(current.lastCacheHitTokens);
    const cacheRate = current.promptTokens > 0
      ? Math.min(100, Math.max(0, current.cacheHitTokens / current.promptTokens * 100))
      : 0;
    const label = `上下文窗口 ${windowTokens} / ${context}，本次 ${request}（缓存 ${requestCached}），本局缓存 ${cacheRate.toFixed(1)}%`;
    return UI.el('div', {
      class: 'token-usage' + (extraClass ? ' ' + extraClass : ''),
      title: label,
      'aria-label': label,
    }, [
      UI.el('span', { class: 'token-usage-item token-usage-context' }, [UI.icon('layers-3'), UI.el('span', { text: `${windowTokens} / ${context}` })]),
      UI.el('span', { class: 'token-usage-item' }, [UI.icon('coins'), UI.el('span', { text: request })]),
      UI.el('span', { class: 'token-usage-paren', text: '（' }),
      UI.el('span', { class: 'token-usage-item' }, [UI.icon('database'), UI.el('span', { text: requestCached })]),
      UI.el('span', { class: 'token-usage-paren', text: '）' }),
      UI.el('span', { class: 'token-usage-item' }, [UI.icon('database'), UI.el('span', { text: cacheRate.toFixed(1) + '%' })]),
    ]);
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) UI.toast('已复制：' + text);
      else UI.toast('复制失败，请手动复制');
    } catch {
      UI.toast('复制失败，请手动复制');
    }
  }

  // 管理员调用统一处理 401（未登录/会话过期 → 回登录视图）
  async function adminCall(fn, fallback) {
    const r = await fn();
    if (r && r.status === 401) {
      state.admin.loggedIn = false;
      UI.toast('登录已失效，请重新登录');
      switchView('admin-login');
      return null;
    }
    if (!r) return fallback || null;
    return r;
  }

  // ============ 事件订阅（对齐 Socket.IO 服务端→客户端事件名）============
  client.on('room:state', ({ room }) => {
    state.room = room;
    if (room?.generationProgress) beginGeneration(room.generationProgress.kind, room.generationProgress);
    syncOpponentOffline();
    render();
  });
  client.on('connection:error', ({ error }) => UI.toast(error || '连接异常，请稍后重试'));
  client.on('player:joined', () => render());
  client.on('player:ready', () => render());
  client.on('game:started', () => { state.game.starting = false; });
  client.on('game:starting', () => {
    state.game.starting = true;
    beginGeneration('opening');
    render();
  });
  client.on('game:generation_progress', (progress) => {
    if (!progress?.kind) return;
    beginGeneration(progress.kind, progress);
    if (state.room && progress.tokenUsage) state.room.tokenUsage = progress.tokenUsage;
    const updated = refreshGenerationCards(progress.kind);
    if (!updated && (state.view === 'lobby' || state.view === 'game' || state.view === 'ending')) render();
  });
  client.on('game:intro', ({ intro, round, confirmed }) => {
    finishGeneration('opening');
    resetTurn();
    syncOpponentOffline();
    state.game = { phase: 'intro', intro, summary: null, next: { me: false, opp: false }, starting: false };
    restoreNextConfirm(confirmed);
    showPlayerView('game');
  });
  client.on('game:round', (payload) => {
    finishGeneration('round');
    finishGeneration('preload');
    resetTurn();
    syncOpponentOffline();
    if (state.room) {
      state.room.currentNode = payload;
      state.room.round = payload.round;
      state.room.progress = payload.progress;
    }
    state.game.phase = 'round';
    state.game.next = { me: false, opp: false };
    // 重连恢复：提交状态 + 自己的选择（仅本人可见），避免重复提交
    const meRole = state.me && state.me.role;
    if (meRole && payload.submitted) {
      if (payload.submitted[meRole]) {
        state.turn.submitted = true;
        const own = payload.ownChosen;
        if (own) {
          const choices = meRole === 'A' ? payload.choices_A : payload.choices_B;
          const isPreset = (Array.isArray(choices) ? choices : []).some((c) => {
            const t = typeof c === 'string' ? c : (c && (c.text || c.id || c.label));
            return t === own;
          });
          state.turn.myChoiceId = own;
          state.turn.customText = isPreset ? null : own;
        }
      }
      state.turn.oppSubmitted = !!payload.submitted[OPP(meRole)];
      if (state.turn.submitted && payload.opponentChosen) state.turn.oppChoiceText = payload.opponentChosen;
    }
    showPlayerView('game');
  });
  client.on('game:summary', (payload) => {
    syncOpponentOffline();
    finishGeneration('summary');
    state.game.phase = 'summary';
    state.game.summary = payload;
    state.game.next = { me: false, opp: false };
    restoreNextConfirm(payload.confirmed);
    if (payload.preloadStatus === 'loading') beginGeneration('preload');
    showPlayerView('game');
  });
  client.on('game:preload_status', ({ status }) => {
    if (state.game.summary) state.game.summary.preloadStatus = status;
    if (status === 'ready') finishGeneration('preload');
    else if (status === 'loading') beginGeneration('preload');
    if (state.game.phase === 'summary') render();
  });
  client.on('game:next_update', ({ role, confirmed }) => {
    if (state.me && role === OPP(state.me.role)) state.game.next.opp = confirmed;
    if (state.game.next.me && state.game.next.opp) beginGeneration('round');
    render();
  });
  client.on('game:choice_update', ({ role, chosen, choiceText, opponentChoiceText }) => {
    if (state.me && role !== state.me.role) {
      state.turn.oppSubmitted = chosen;
      if (choiceText) state.turn.oppChoiceText = choiceText;
    }
    if (opponentChoiceText) {
      state.turn.oppSubmitted = true;
      state.turn.oppChoiceText = opponentChoiceText;
    }
    // 只由 A 端发起推进，避免双方同时请求而出现重复结算状态。
    if (state.me?.role === 'A' && state.turn.submitted && state.turn.oppSubmitted && !state.turn.advancing && state.game.phase === 'round') {
      requestRoundAdvance();
      return;
    }
    render();
  });
  client.on('game:advance_failed', () => {
    state.turn.advancing = false;
    state.turn.advanceFailed = true;
    finishGeneration('summary');
    render();
  });
  client.on('game:judging', () => {   // mock 附加事件（后端可选）
    state.turn.advancing = true;
    state.turn.judging = true;
    finishGeneration('summary');
    beginGeneration('ending');
    render();
  });
  client.on('game:ended', ({ ending }) => {
    if (state.room) state.room.ending = ending;
    state.oppOffline = false;
    finishGeneration('opening');
    finishGeneration('round');
    finishGeneration('summary');
    finishGeneration('preload');
    finishGeneration('ending');
    showPlayerView('ending');
  });

  // 对方离线/重连提示（游戏中一方掉线时显示横幅 + 结束本局）
  client.on('player:disconnected', ({ role }) => {
    if (state.me && role === OPP(state.me.role)) {
      state.oppOffline = true;
      if (state.view === 'game') render();
    }
  });
  client.on('player:reconnected', ({ role }) => {
    if (state.me && role === OPP(state.me.role)) {
      state.oppOffline = false;
      if (state.view === 'game') render();
    }
  });

  // 重连时恢复「开始冒险/下一步」的双方确认状态
  function restoreNextConfirm(confirmed) {
    if (!confirmed || !state.me) return;
    state.game.next = {
      me: !!confirmed[state.me.role],
      opp: !!confirmed[OPP(state.me.role)],
    };
  }

  function syncOpponentOffline() {
    if (!state.me || !state.room || state.room.status !== 'playing') {
      state.oppOffline = false;
      return;
    }
    const opponent = state.room.players?.[OPP(state.me.role)];
    state.oppOffline = !!opponent && opponent.online === false;
  }

  // ============ 1. 管理员登录 ============
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('inp-user').value.trim();
    const password = $('inp-pass').value;
    const err = $('login-error');
    if (!username || !password) { err.textContent = '请输入账号与密码'; err.hidden = false; return; }
    err.hidden = true;
    const res = await client.login({ username, password });
    if (res && res.ok) {
      state.admin.loggedIn = true;
      enterAdminPanel();
    } else {
      err.textContent = (res && res.error) || '登录失败';
      err.hidden = false;
    }
  });

  // ============ 2. 后台管理 ============
  async function enterAdminPanel() {
    switchView('admin-panel');
    const wb = await adminCall(() => client.listWorldbooks());
    if (!wb) return;
    state.admin.worldbooks = wb.worldbooks || [];
    state.admin.current = wb.current;
    await refreshRooms();
    await refreshOnline();
    render();
    startOnlinePolling();
  }

  // 实时在线：每 5 秒轮询一次（后台仅管理员可见，无需实时推送）
  let onlineTimer = null;
  function startOnlinePolling() {
    stopOnlinePolling();
    onlineTimer = setInterval(async () => { await refreshOnline(); }, 5000);
  }
  function stopOnlinePolling() {
    if (onlineTimer) { clearInterval(onlineTimer); onlineTimer = null; }
  }

  async function refreshOnline() {
    const r = await adminCall(() => client.listOnline());
    if (r && r.count !== undefined) state.admin.online = r;
    if (state.view === 'admin-panel') render();
  }

  async function refreshRooms() {
    const [roomsResult, historyResult] = await Promise.all([
      adminCall(() => client.listRooms()),
      adminCall(() => client.listRoomHistory()),
    ]);
    if (roomsResult && roomsResult.rooms) state.admin.rooms = roomsResult.rooms;
    if (historyResult && historyResult.history) state.admin.history = historyResult.history;
    if (historyResult && historyResult.storage) state.admin.storage = historyResult.storage;
  }

  function renderAdminPanel() {
    renderOnlinePanel();

    // 世界书列表
    const wbList = $('wb-list');
    UI.clear(wbList);
    state.admin.worldbooks.forEach((wb) => {
      const isCur = wb.id === state.admin.current;
      wbList.appendChild(UI.el('div', { class: 'wb-item' + (isCur ? ' is-current' : '') }, [
        UI.el('div', { class: 'wb-item-main' }, [
          UI.el('div', { class: 'wb-item-name', text: wb.name }),
          UI.el('div', { class: 'wb-item-meta', text: `${wb.entryCount} 个条目 · ${wb.builtin ? '内置' : '已导入'}` }),
        ]),
        isCur
          ? UI.el('span', { class: 'wb-current-tag', text: '当前' })
          : UI.el('button', { class: 'icon-btn', type: 'button', title: '设为当前', onclick: () => selectWb(wb.id) }, [UI.icon('check')]),
      ]));
    });

    // 新房间码卡片
    const box = $('room-new');
    UI.clear(box);
    if (state.admin.lastRoom) {
      box.appendChild(UI.el('div', { class: 'label', text: '新房间已创建，将此房间码发给两位玩家' }));
      box.appendChild(UI.el('div', { class: 'big-code', text: state.admin.lastRoom.code }));
      box.appendChild(UI.el('div', { class: 'row' }, [
        UI.el('button', { class: 'btn btn-primary', type: 'button', onclick: () => copyText(state.admin.lastRoom.code) }, [UI.icon('copy'), UI.el('span', { text: '复制房间码' })]),
        UI.el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => demoJoin(state.admin.lastRoom.code) }, [UI.icon('door-open'), UI.el('span', { text: '进入演示' })]),
      ]));
      box.hidden = false;
    }

    // 房间列表
    const roomList = $('room-list');
    UI.clear(roomList);
    if (!state.admin.rooms.length) {
      roomList.appendChild(UI.el('p', { class: 'hint', text: '暂无房间，点击上方创建。' }));
    }
    state.admin.rooms.forEach((room) => roomList.appendChild(renderRoomItem(room)));

    const storageBox = $('history-storage');
    UI.clear(storageBox);
    const storage = state.admin.storage || { usedBytes: 0, limitBytes: 200 * 1024 * 1024, fileCount: 0 };
    const ratio = storage.limitBytes > 0 ? storage.usedBytes / storage.limitBytes : 0;
    storageBox.appendChild(UI.el('div', { class: 'history-storage-row' }, [
      UI.el('span', { text: '历史存储用量' }),
      UI.el('b', { text: `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.limitBytes)}（${Math.min(100, ratio * 100).toFixed(2)}%）` }),
    ]));
    storageBox.appendChild(UI.progressBar(ratio, ratio >= 0.9 ? 'storage-danger' : ratio >= 0.75 ? 'storage-warning' : 'storage-normal'));
    storageBox.appendChild(UI.el('p', { class: 'hint', text: `共 ${storage.fileCount || 0} 条记录；系统不会自动删除，请按需手动清理。` }));

    const historyList = $('room-history');
    UI.clear(historyList);
    if (!state.admin.history.length) {
      historyList.appendChild(UI.el('p', { class: 'hint', text: '暂无已结束的房间记录。' }));
    }
    state.admin.history.forEach((record) => historyList.appendChild(renderHistoryItem(record)));
  }

  async function selectWb(id) {
    const res = await adminCall(() => client.selectWorldbook(id));
    if (res && res.ok) {
      state.admin.current = res.current;
      render();
      UI.toast('已设为当前世界书');
    }
  }

  // 导入世界书：读取 .json → 解析 → 校验 → 登记入库
  $('inp-wb-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const info = $('wb-import-info');
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !parsed.name || typeof parsed.entries !== 'object'
        || typeof parsed.opening_background !== 'string' || !parsed.opening_background.trim()) {
        throw new Error('格式不符');
      }
      const res = await client.importWorldbook({ name: parsed.name, content: parsed });
      const wb = await adminCall(() => client.listWorldbooks());
      if (!wb) return;
      state.admin.worldbooks = wb.worldbooks || [];
      state.admin.current = wb.current;
      render();
      info.textContent = `已导入「${res.name}」，共 ${Object.keys(parsed.entries).length} 个条目`;
      info.hidden = false;
      UI.toast('导入成功：' + res.name);
    } catch (err) {
      info.textContent = '导入失败：JSON 解析错误或格式不符（需含 name 与 entries）';
      info.hidden = false;
      UI.toast('导入失败');
    }
    e.target.value = '';
  });

  function renderRoomItem(room) {
    const badgeText = { lobby: '等待中', waiting: '等待中', playing: '进行中', judging: '判定中', ended: '已结束' }[room.status] || room.status;
    const wbName = (state.admin.worldbooks.find(w => w.id === room.worldbookId) || {}).name || room.worldbookName || '未知世界书';
    const item = UI.el('div', { class: 'room-item' }, [
      UI.el('div', { class: 'room-item-head' }, [
        UI.el('div', {}, [
          UI.el('div', { class: 'room-item-code', text: room.code }),
          UI.el('div', { class: 'room-item-meta', text: `${wbName} · 回合 ${room.round} · 进度 ${Math.round(room.progress * 100)}%` }),
        ]),
        UI.el('span', { class: 'badge ' + room.status, text: badgeText }),
      ]),
      UI.el('div', { class: 'room-item-meta', text: `A ${playerLine(room.players.A)}　B ${playerLine(room.players.B)}` }),
      UI.el('div', { class: 'room-item-meta', text: '创建于 ' + UI.formatTime(room.createdAt) }),
      UI.el('div', { class: 'room-detail-row room-actions' }, [
        UI.el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => toggleRoomDetail(item, room) }, [UI.icon('eye'), UI.el('span', { text: '查看进度' })]),
        UI.el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => downloadStory(room, false) }, [UI.icon('download'), UI.el('span', { text: '导出故事' })]),
        room.status !== 'ended' ? UI.el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => closeRoom(room.id) }, [UI.icon('x'), UI.el('span', { text: '关闭' })]) : null,
      ]),
    ]);
    return item;
  }

  function renderHistoryItem(record) {
    const names = `A ${record.players?.A || '—'}　B ${record.players?.B || '—'}`;
    return UI.el('div', { class: 'room-item history-item' }, [
      UI.el('div', { class: 'room-item-head' }, [
        UI.el('div', {}, [
          UI.el('div', { class: 'room-item-code', text: record.code }),
          UI.el('div', { class: 'room-item-meta', text: `回合 ${record.round || 0} · ${names}` }),
        ]),
        UI.el('div', { class: 'history-actions' }, [
          UI.el('span', { class: 'badge ended', text: '已结束' }),
          UI.el('button', { class: 'icon-btn', type: 'button', title: '导出 Markdown 故事', onclick: () => downloadStory(record, true) }, [UI.icon('download')]),
          UI.el('button', { class: 'icon-btn history-delete', type: 'button', title: '删除这条历史记录', onclick: () => deleteHistoryRecord(record) }, [UI.icon('trash-2')]),
        ]),
      ]),
      record.ending?.title ? UI.el('div', { class: 'room-item-meta', text: '结局：' + record.ending.title }) : null,
      UI.el('div', { class: 'room-item-meta', text: `结束于 ${UI.formatTime(record.endedAt || record.createdAt)} · ${formatBytes(record.fileBytes)}` }),
    ]);
  }

  async function downloadStory(record, history) {
    const result = await adminCall(() => client.exportRoom(record.id, { history }));
    if (!result) return;
    if (!result.ok || !result.blob) {
      UI.toast(result.error || '导出失败');
      return;
    }
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename || `共叙-${record.code || '故事'}.md`;
    link.hidden = true;
    document.body.appendChild(link);
    try {
      link.click();
      UI.toast('Markdown 故事已导出');
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function deleteHistoryRecord(record) {
    if (!window.confirm(`确定删除房间 ${record.code} 的历史记录吗？此操作不可恢复。`)) return;
    const res = await adminCall(() => client.deleteRoomHistory(record.id));
    if (!res || !res.ok) {
      UI.toast((res && res.error) || '删除失败');
      return;
    }
    await refreshRooms();
    render();
    UI.toast('历史记录已删除');
  }

  // ---- 实时在线面板：按房间成对显示在线玩家 ----
  function renderOnlinePanel() {
    const box = $('online-list');
    const hint = $('online-hint');
    const countEl = $('online-count');
    if (!box || !countEl) return;
    UI.clear(box);
    const online = state.admin.online || { count: 0, rooms: [] };
    const pairs = online.rooms || [];
    countEl.textContent = pairs.length ? `在线 ${online.count} 人 / ${pairs.length} 房` : '在线 0 人';
    countEl.className = 'online-count' + (online.count ? ' has-online' : '');
    countEl.hidden = false;
    if (!pairs.length) {
      hint.textContent = '当前没有玩家在线，玩家加入房间后会出现在这里。';
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    pairs.forEach((pair) => {
      const card = UI.el('div', { class: 'online-card' }, [
        UI.el('div', { class: 'online-card-head' }, [
          UI.icon('door-open'),
          UI.el('code', { class: 'code-chip', text: pair.code }),
          UI.el('span', { class: 'badge ' + pair.status, text: { lobby: '等待中', waiting: '等待中', playing: '进行中', judging: '判定中', ended: '已结束' }[pair.status] || pair.status }),
        ]),
        UI.el('div', { class: 'online-pair' }, pair.players.map((p) =>
          UI.el('div', { class: 'online-player' }, [
            UI.el('span', { class: 'online-role', text: p.role }),
            UI.el('span', { class: 'online-name', text: p.name }),
            UI.icon('user-check'),
          ])
        )),
      ]);
      box.appendChild(card);
    });
  }

  function playerLine(p) {
    if (!p) return '—';
    return p.name + (p.ready ? ' ✓已准备' : ' 未准备');
  }

  async function toggleRoomDetail(item, room) {
    let detail = item.querySelector('.room-detail');
    if (detail) { detail.remove(); return; }
    const res = await adminCall(() => client.getRoom(room.id));
    if (!res) return;
    const full = res.room || res;
    detail = UI.el('div', { class: 'room-detail' });
    detail.appendChild(row('状态', { lobby: '等待中', playing: '进行中', judging: '判定中', ended: '已结束' }[full.status] || full.status));
    detail.appendChild(UI.el('div', { class: 'room-detail-row' }, [UI.el('span', { class: 'k', text: '进度' }), UI.el('div', { style: 'flex:1;max-width:200px' }, [UI.progressBar(full.progress)])]));
    detail.appendChild(row('回合', full.round));
    if (full.storyState) {
      ['A', 'B'].forEach((role) => {
        const p = full.storyState[role];
        if (p) detail.appendChild(row('玩家 ' + role, `${p.name} · 生命 ${p.hp} · 资源 ${p.resources} · 阵营 ${p.alignment > 0 ? '+' : ''}${p.alignment}`));
      });
    } else {
      detail.appendChild(row('玩家', '尚未开局'));
    }
    if (full.currentNode) detail.appendChild(row('当前叙事', full.currentNode.narrative.slice(0, 48) + (full.currentNode.narrative.length > 48 ? '…' : '')));
    detail.appendChild(row('历史', full.history ? full.history.length + ' 个回合' : '无'));
    if (full.ending) detail.appendChild(row('结局', full.ending.title));
    item.appendChild(detail);
    UI.refreshIcons();
  }

  function row(k, v) {
    return UI.el('div', { class: 'room-detail-row' }, [UI.el('span', { class: 'k', text: k }), UI.el('span', { text: v })]);
  }

  async function closeRoom(id) {
    const res = await adminCall(() => client.closeRoom(id));
    if (res && res.ok) {
      UI.toast('房间已关闭');
      await refreshRooms();
      render();
    }
  }

  // 创建房间 → 生成房间码（给玩家使用）
  async function createRoom() {
    const res = await adminCall(() => client.createRoom({ worldbookId: state.admin.current }));
    if (!res) return;
    state.admin.lastRoom = { code: res.code, roomId: res.roomId };
    await refreshRooms();
    render();
  }

  // 以玩家身份进入房间（演示用；组织者旁观，不参与玩家选择，仅作演示）
  async function demoJoin(roomCode) {
    const res = await client.join({ roomCode, name: '组织者预览' });
      if (res.room) state.room = res.room;
    if (res.ok) {
      state.me = { role: res.role, name: '组织者预览' };
      resetTurn();
      saveActiveWorkspace('player');
      switchView('lobby');
    } else {
      UI.toast(res.error || '进入失败');
    }
  }

  // ============ 顶部导航动作 ============
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'theme-toggle') toggleTheme();
    if (action === 'go-home') {
      await leaveCurrentRoom();
      switchView('admin-login');
    }
    if (action === 'goto-admin') {
      saveActiveWorkspace('admin');
      if (state.admin.loggedIn) enterAdminPanel();
      else switchView('admin-login');
    }
    if (action === 'goto-player') {
      saveActiveWorkspace('player');
      stopOnlinePolling();
      switchView(state.playerView || (state.me ? 'lobby' : 'player-entry'));
    }
    if (action === 'copy-code') {
      const code = state.room ? state.room.code : (state.admin.lastRoom ? state.admin.lastRoom.code : null);
      if (code) copyText(code);
    }
    if (action === 'admin-logout') {
      await client.logout();
      state.admin.loggedIn = false;
      state.adminView = 'admin-login';
      stopOnlinePolling();
      UI.toast('已退出登录');
      saveActiveWorkspace('player');
      switchView(state.playerView || (state.me ? 'lobby' : 'player-entry'));
    }
    if (action === 'create-room') createRoom();
    if (action === 'room-refresh') { await refreshRooms(); render(); }
    if (action === 'online-refresh') { await refreshOnline(); render(); }
  });

  // ============ 3. 玩家入口 ============
  $('form-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    const roomCode = $('inp-code').value.trim().toUpperCase();
    const name = $('inp-name').value.trim();
    const err = $('join-error');
    if (!roomCode || !name) { err.textContent = '请填写房间码与昵称'; err.hidden = false; return; }
    err.hidden = true;
    const res = await client.join({ roomCode, name });
    if (res.ok) {
      if (res.room) state.room = res.room;
      state.me = { role: res.role, name };
      saveSession(roomCode, name);
      resetTurn();
      switchView('lobby');
    } else {
      err.textContent = res.error || '加入失败';
      err.hidden = false;
    }
  });

  // ============ 4. 大厅 ============
  function renderLobby() {
    const room = state.room;
    if (!room) {
      $('lobby-code').textContent = '--------';
      const acts = $('lobby-actions');
      UI.clear(acts);
      acts.appendChild(waitLine('正在同步房间状态…'));
      return;
    }
    $('lobby-code').textContent = room.code;
    const wbEl = $('lobby-wb');
    if (room.worldbookName) { wbEl.textContent = '世界书：' + room.worldbookName; wbEl.hidden = false; }

    const seats = $('lobby-seats');
    UI.clear(seats);
    seats.appendChild(renderSeat('A', room.players && room.players.A, state.me && state.me.role === 'A'));
    seats.appendChild(renderSeat('B', room.players && room.players.B, state.me && state.me.role === 'B'));
    const lobbyUsage = $('lobby-token-usage');
    UI.clear(lobbyUsage);
    lobbyUsage.appendChild(tokenUsageNode(room.tokenUsage));
    lobbyUsage.hidden = false;


    const acts = $('lobby-actions');
    UI.clear(acts);
    const myPlayer = state.me && room.players && room.players[state.me.role];
    if (!myPlayer) return;
    // 房主已点开始、DM 正在生成开场：双方都显示等待，避免对方界面毫无反馈
    if (state.game.starting) {
      acts.appendChild(generationLoader('opening'));
      return;
    }
    // 游戏进行中（断线重连过渡，后端会推送 game 事件并自动切到对局界面）
    if (room.status === 'playing') {
      acts.appendChild(waitLine('游戏进行中，正在重连…'));
      return;
    }
    acts.appendChild(UI.el('button', {
      class: 'btn ' + (myPlayer.ready ? 'btn-ghost' : 'btn-primary') + ' btn-block', type: 'button',
      onclick: () => client.setReady(),
    }, [UI.icon(myPlayer.ready ? 'check' : 'users'), UI.el('span', { text: myPlayer.ready ? '已准备（点击取消）' : '准备' })]));

    const aReady = room.players.A && room.players.A.ready;
    const bReady = room.players.B && room.players.B.ready;
    const isWaiting = room.status === 'lobby' || room.status === 'waiting';
    const isHost = state.me?.role === 'A';
    const canStart = isHost && aReady && bReady && isWaiting;
    if (isHost) {
      acts.appendChild(UI.el('button', {
        class: 'btn btn-primary btn-block', type: 'button', disabled: !canStart,
        onclick: async () => {
          if (!canStart) return;
          // 立即反馈：真实 AI 生成开场需要一点时间
          UI.clear(acts);
          beginGeneration('opening');
          acts.appendChild(generationLoader('opening'));
          UI.refreshIcons();
          const res = await client.startGame();
          if (!res || !res.ok) {
            finishGeneration('opening');
            UI.toast((res && res.error) || '开始失败，请重试');
            render();
          }
        },
      }, [UI.icon('play'), UI.el('span', { text: '开始游戏' })]));
    } else {
      const waitingText = !myPlayer.ready
        ? '准备后等待房主开始游戏'
        : aReady && bReady
          ? '双方已准备，等待房主开始游戏'
          : '你已准备，等待另一位玩家准备';
      acts.appendChild(UI.el('div', { class: 'lobby-waiting' }, [
        UI.icon(aReady && bReady ? 'hourglass' : 'clock-3'),
        UI.el('span', { text: waitingText }),
      ]));
    }
    if (isWaiting && room.openingStatus === 'loading') {
      acts.appendChild(generationLoader('opening', { compact: true, title: 'DM 正在后台预生成开场' }));
    } else if (isWaiting && room.openingStatus === 'ready') {
      finishGeneration('opening');
      acts.appendChild(UI.el('p', { class: 'hint', text: '开场已预加载，可以立即开始。' }));
    } else if (isHost && !canStart) {
      const hint = !isWaiting
        ? '游戏进行中'
        : !aReady || !bReady
          ? '等待双方准备就绪…'
          : '双方已准备，可以开始游戏。';
      acts.appendChild(UI.el('p', { class: 'hint', text: hint }));
    }
  }

  function renderSeat(role, player, isMe) {
    if (!player) {
      return UI.el('div', { class: 'seat is-empty' }, [
        UI.icon('user'),
        UI.el('div', { class: 'role-tag', text: '玩家 ' + role }),
        UI.el('div', { class: 'seat-name', text: '等待加入…' }),
        UI.el('div', { class: 'seat-state waiting' }, [UI.el('span', { class: 'dot' }), UI.el('span', { text: '空位' })]),
      ]);
    }
    return UI.el('div', { class: 'seat' + (isMe ? ' is-me' : '') }, [
      UI.icon(isMe ? 'user-check' : 'user'),
      UI.el('div', { class: 'role-tag', text: '玩家 ' + role + (isMe ? '（你）' : '') }),
      UI.el('div', { class: 'seat-name', text: player.name }),
      UI.el('div', { class: 'seat-state ' + (player.ready ? 'ready' : 'waiting') }, [UI.el('span', { class: 'dot' }), UI.el('span', { text: player.ready ? '已准备' : '未准备' })]),
    ]);
  }

  // ============ 5. 游戏主界面 ============
  let narrativeTyping = { active: false, text: '' };
  let typedDone = { narrative: null, summary: null };

  const generationStates = Object.create(null);
  const GENERATION_PHASES = {
    opening: { title: 'DM 正在准备开场' },
    round: { title: 'DM 正在续写下一回合' },
    summary: { title: 'DM 正在结算本回合' },
    preload: { title: 'DM 正在后台准备下一回合' },
    ending: { title: 'DM 正在判定故事结局' },
  };

  const GENERATION_SECTIONS = {
    opening: [['intro', '背景'], ['narrative', '开场'], ['choices_A', 'A 行动'], ['choices_B', 'B 行动'], ['story_state', '状态']],
    round: [['narrative', '叙事'], ['choices_A', 'A 行动'], ['choices_B', 'B 行动'], ['story_state', '状态']],
    preload: [['narrative', '叙事'], ['choices_A', 'A 行动'], ['choices_B', 'B 行动'], ['story_state', '状态']],
    summary: [['summary', '反馈'], ['story_state', '状态'], ['ending', '结局']],
    ending: [['summary', '反馈'], ['story_state', '状态'], ['ending', '结局']],
  };

  const GENERATION_HINTS = {
    opening: [
      '整理世界背景与人物资料',
      '寻找适合两位玩家的故事切口',
      '编排双方初次登场的行动机会',
      '检查开场线索与角色设定是否吻合',
    ],
    round: [
      '衔接双方行动造成的后果',
      '梳理仍在发酵的线索与关系',
      '为两位玩家编排新的行动机会',
      '同步人物状态与故事进度',
      '检查下一幕与前文是否连贯',
    ],
    preload: [
      '整理本回合留下的变化',
      '沿着双方选择推演下一幕',
      '提前准备两位玩家的行动机会',
      '同步人物状态与未解线索',
      '检查下一回合能否顺畅接续',
    ],
    summary: [
      '核对双方刚刚作出的选择',
      '整理行动带来的即时影响',
      '更新人物状态与共同局势',
      '判断故事是否触发新的转折',
    ],
    ending: [
      '回看一路积累的关键选择',
      '核对仍未解决的故事线索',
      '判断角色最终抵达的结局',
    ],
  };

  const GENERATION_STATUS = {
    queued: ['准备中', '正在整理本次生成资料'],
    requesting: ['连接中', '正在连接 DeepSeek'],
    connected: ['已连接', '已连接 DeepSeek，等待模型响应'],
    thinking: ['推演中', '模型正在推演故事'],
    receiving: ['接收中', '正在接收剧情内容'],
    received: ['已接收', '剧情内容接收完成'],
    validating: ['校验中', '正在校验剧情结构'],
    retrying: ['重试中', '返回格式异常，正在重新生成'],
    failed: ['异常', '模型请求异常，正在准备备用内容'],
    fallback: ['备用内容', '正在生成安全备用剧情'],
    completed: ['已完成', '剧情结构校验完成'],
  };

  function beginGeneration(kind, detail = {}) {
    const previous = generationStates[kind] || {
      kind, phase: 'queued', startedAt: Date.now(), contentChars: 0,
      reasoningChars: 0, completedFields: [], totalSections: 0, attempt: 1,
    };
    generationStates[kind] = { ...previous, ...detail, kind };
    if (!generationStates[kind].startedAt) generationStates[kind].startedAt = Date.now();
  }

  function finishGeneration(kind) {
    delete generationStates[kind];
  }

  function clearGenerations() {
    Object.keys(generationStates).forEach((kind) => delete generationStates[kind]);
  }

  function generationStageText(kind, data, elapsedMs) {
    const status = GENERATION_STATUS[data.phase] || GENERATION_STATUS.queued;
    const hints = GENERATION_HINTS[kind] || GENERATION_HINTS.round;
    const hint = hints[Math.floor(Math.max(0, elapsedMs) / 3600) % hints.length];
    if (data.phase === 'receiving') {
      const chars = Math.max(0, Number(data.contentChars) || 0);
      return chars ? `已收到 ${chars} 字 · ${hint}` : `正在接收剧情内容 · ${hint}`;
    }
    if (data.phase === 'validating') return `${status[1]} · 核对已返回的每一项内容`;
    if (data.phase === 'retrying') return `${status[1]} · 保留前文并重新组织返回格式`;
    if (data.phase === 'failed' || data.phase === 'fallback') return status[1];
    return `${status[1]} · ${hint}`;
  }

  function updateGenerationCard(card, kind) {
    const data = generationStates[kind];
    if (!data || !card) return;
    const status = GENERATION_STATUS[data.phase] || GENERATION_STATUS.queued;
    const elapsedMs = Math.max(0, Date.now() - (Number(data.startedAt) || Date.now()));
    const completedFields = Array.isArray(data.completedFields) ? data.completedFields : [];
    const completedSet = new Set(completedFields);
    const sectionConfig = GENERATION_SECTIONS[kind] || GENERATION_SECTIONS.round;
    const total = Math.max(sectionConfig.length, Number(data.totalSections) || 0);
    const completed = Math.min(total, completedFields.length);
    const whole = Math.floor(elapsedMs / 1000);
    const live = card.querySelector('[data-generation-live]');
    const stage = card.querySelector('[data-generation-stage]');
    const chars = card.querySelector('[data-generation-chars]');
    const count = card.querySelector('[data-generation-count]');
    const attempt = card.querySelector('[data-generation-attempt]');
    const elapsed = card.querySelector('[data-generation-elapsed]');
    const currentStep = card.querySelector('[data-generation-current]');
    const progressFill = card.querySelector('[data-generation-progress]');
    if (live) live.textContent = status[0];
    if (stage) stage.textContent = generationStageText(kind, data, elapsedMs);
    if (chars) chars.textContent = String(Math.max(0, Number(data.contentChars) || 0)) + ' 字';
    if (count) count.textContent = completed + '/' + total;
    if (attempt) {
      attempt.hidden = Number(data.attempt) <= 1;
      attempt.querySelector('span').textContent = '第 ' + (Number(data.attempt) || 1) + ' 次';
    }
    if (elapsed) elapsed.textContent = whole < 60 ? `已等待 ${whole} 秒` : `已等待 ${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
    if (currentStep) {
      const nextSection = sectionConfig.find(([key], index) => !completedSet.has(key) && index >= completed);
      currentStep.textContent = completed >= total ? '内容已齐' : '当前：' + (nextSection?.[1] || sectionConfig[Math.min(completed, sectionConfig.length - 1)]?.[1] || '生成中');
    }
    if (progressFill) progressFill.style.width = total ? Math.min(100, completed / total * 100) + '%' : '0%';
  }

  function refreshGenerationCards(kind) {
    const cards = document.querySelectorAll('.dm-generation[data-generation-kind="' + kind + '"]');
    cards.forEach((card) => updateGenerationCard(card, kind));
    return cards.length;
  }

  function generationLoader(kind, { compact = false, title } = {}) {
    const config = GENERATION_PHASES[kind] || GENERATION_PHASES.round;
    beginGeneration(kind);
    const facts = [
      UI.el('span', { title: '实际接收的剧情字符数' }, [UI.icon('file-text'), UI.el('span', { 'data-generation-chars': '', text: '0 字' })]),
      UI.el('span', { title: '已经完整接收的剧情结构项' }, [UI.icon('list-checks'), UI.el('span', { 'data-generation-count': '', text: '0/0' })]),
      UI.el('span', { title: 'AI 请求次数', 'data-generation-attempt': '', hidden: true }, [UI.icon('rotate-cw'), UI.el('span', { text: '第 1 次' })]),
    ];
    const card = UI.el('div', {
      class: 'dm-generation' + (compact ? ' is-compact' : ''),
      role: 'status',
      'aria-live': 'polite',
      'data-generation-kind': kind,
    }, [
      UI.el('div', { class: 'dm-generation-mark', 'aria-hidden': 'true' }, [
        UI.el('span', { class: 'dm-generation-glow' }),
        UI.el('span', { class: 'dm-generation-glyph' }, [UI.icon('sparkles')]),
      ]),
      UI.el('div', { class: 'dm-generation-copy' }, [
        UI.el('div', { class: 'dm-generation-head' }, [
          UI.el('strong', { text: title || config.title }),
          UI.el('span', { class: 'dm-generation-live', 'data-generation-live': '', text: '准备中' }),
        ]),
        UI.el('span', { class: 'dm-generation-stage', 'data-generation-stage': '', text: '正在整理本次生成资料' }),
        UI.el('div', { class: 'dm-generation-bottom' }, [
          UI.el('div', { class: 'dm-generation-facts' }, facts),
          UI.el('span', { class: 'dm-generation-current', 'data-generation-current': '', text: '当前：生成中' }),
          UI.el('span', { 'data-generation-elapsed': '', text: '已等待 0 秒' }),
        ]),
        UI.el('div', { class: 'dm-generation-track', 'aria-hidden': 'true' }, [
          UI.el('span', { 'data-generation-progress': '' }),
        ]),
      ]),
    ]);
    let wasConnected = false;
    const update = () => {
      if (card.isConnected) wasConnected = true;
      else if (wasConnected) return clearInterval(timer);
      updateGenerationCard(card, kind);
    };
    const timer = setInterval(update, 600);
    update();
    return card;
  }

  function renderGame() {
    const room = state.room;
    const g = state.game;
    const node = room && room.currentNode;
    renderTopbar(room, node);
    renderOfflineBanner();
    // intro / summary / 等待阶段隐藏选择区（避免出现空的白色方框）
    const choicesArea = document.querySelector('.choices-area');
    if (choicesArea) choicesArea.style.display = g.phase === 'round' && node ? '' : 'none';
    if (g.phase === 'intro') { renderIntroPage(g.intro); return; }
    if (g.phase === 'summary') { renderSummaryPage(g.summary); return; }
    if (!node) { renderWaiting(); return; }
    if (narrativeTyping.active) { renderRoundStatusOnly(node); return; }
    renderRound(node);
  }

  function renderTopbar(room, node) {
    const top = $('game-top');
    UI.clear(top);
    if (!room) return;
    top.appendChild(UI.el('span', { class: 'top-code', text: room.code }));
    top.appendChild(UI.el('span', { class: 'top-sep' }));
    const phase = state.game.phase;
    const roundLabel = phase === 'summary' ? '回合反馈' : phase === 'intro' ? '准备阶段' : '回合 ' + (node ? node.round : room.round);
    top.appendChild(UI.el('span', { class: 'top-round', text: roundLabel }));
    top.appendChild(UI.el('div', { class: 'top-progress' }, [UI.progressBar(room.progress)]));
    top.appendChild(tokenUsageNode(room.tokenUsage, 'token-usage-top'));
  }

  function renderWaiting() {
    const na = $('narrative-area');
    UI.clear(na);
    na.className = 'narrative waiting';
    na.appendChild(generationLoader('opening'));
    UI.clear($('my-choices')); UI.clear($('opp-choices')); UI.clear($('action-bar')); UI.clear($('status-panel'));
  }

  function clearGameAreas() {
    UI.clear($('narrative-area')); UI.clear($('my-choices')); UI.clear($('opp-choices'));
    UI.clear($('action-bar')); UI.clear($('status-panel'));
  }

  // ---- 对方离线横幅 + 结束本局 ----
  function renderOfflineBanner() {
    const box = $('offline-banner');
    if (!box) return;
    UI.clear(box);
    if (!state.oppOffline) { box.hidden = true; return; }
    box.hidden = false;
    const oppRole = OPP(state.me.role);
    const oppName = ((state.room?.storyState && state.room.storyState[oppRole]) || {}).name
      || state.room?.players?.[oppRole]?.name
      || '对方';
    box.appendChild(UI.el('div', { class: 'offline-banner-text' }, [
      UI.icon('wifi-off'),
      UI.el('span', { text: `${oppName} 已离线，等待重连中…（30 分钟后自动结束）` }),
    ]));
    box.appendChild(UI.el('button', {
      class: 'btn btn-sm btn-danger', type: 'button',
      onclick: abandonGame,
    }, [UI.icon('flag'), UI.el('span', { text: '结束本局' })]));
  }

  async function abandonGame() {
    if (!window.confirm('对方已离线。结束本局后，本局故事会完整保存，但无法继续游玩。确定结束吗？')) return;
    const res = await client.abandon();
    if (!res || !res.ok) { UI.toast((res && res.error) || '结束本局失败'); return; }
    // 后端会广播 game:ended，前端自动进入结局页
  }

  // ---- 开场信息页：世界观背景 + 双方角色 + 开始冒险 ----
  function renderIntroPage(intro) {
    clearGameAreas();
    const na = $('narrative-area');
    const meRole = state.me?.role;
    const oppRole = OPP(meRole);
    const me = state.room?.players?.[meRole];
    const opp = state.room?.players?.[oppRole];
    const profile = me?.profile || { gender: '', personality: '', details: '' };
    na.className = 'info-page';
    na.appendChild(UI.el('div', { class: 'info-page-head' }, [
      UI.icon('scroll-text'), UI.el('h2', { text: '世界背景' }),
    ]));
    const worldText = UI.el('div', { class: 'info-world rich-text' });
    UI.renderRichText(worldText, (intro && intro.world) || '（开场信息生成中…）');
    na.appendChild(UI.el('div', { class: 'info-block' }, [worldText]));

    const form = UI.el('form', {
      class: 'profile-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const displayName = $('profile-name').value.trim();
        const res = await client.saveProfile({
          displayName,
          gender: $('profile-gender').value.trim(),
          personality: $('profile-personality').value.trim(),
          details: $('profile-details').value.trim(),
        });
        if (!res || !res.ok) {
          UI.toast((res && res.error) || '角色资料保存失败');
          return;
        }
        UI.toast(me?.profileReady ? '角色资料已更新' : '角色资料已保存');
      },
    });
    form.appendChild(UI.el('div', { class: 'profile-form-head' }, [
      UI.icon('user-round-pen'),
      UI.el('div', null, [
        UI.el('h3', { text: '塑造你的角色' }),
      ]),
      me?.profileReady ? UI.el('span', { class: 'profile-ready', text: '已保存' }) : null,
    ]));
    form.appendChild(profileInput('剧情昵称', 'profile-name', me?.name || state.me?.name || '', 32, '故事中显示的名字', true));
    form.appendChild(profileInput('性别（选填）', 'profile-gender', profile.gender || '', 20, '可自由填写，例如：女、男、非二元、未设定'));
    form.appendChild(profileTextarea('性格（选填）', 'profile-personality', profile.personality || '', 120, '例如：外冷内热，面对危险时异常冷静'));
    form.appendChild(profileTextarea('补充设定（选填）', 'profile-details', profile.details || '', 300, '希望 AI 知道的身份、经历、外貌或习惯'));
    form.appendChild(UI.el('button', { class: 'btn btn-ghost btn-block', type: 'submit' }, [
      UI.icon('save'), UI.el('span', { text: me?.profileReady ? '更新角色资料' : '保存角色资料' }),
    ]));
    na.appendChild(form);

    const oppCard = UI.el('div', { class: 'profile-peer' }, [
      UI.el('div', { class: 'profile-peer-head' }, [
        UI.icon(opp?.profileReady ? 'user-check' : 'user-round'),
        UI.el('b', { text: opp?.profileReady ? opp.name : `玩家 ${oppRole}` }),
        UI.el('span', { text: opp?.profileReady ? '角色已就绪' : '正在塑造角色…' }),
      ]),
    ]);
    if (opp?.profileReady) {
      const parts = [opp.profile?.gender, opp.profile?.personality, opp.profile?.details].filter(Boolean);
      oppCard.appendChild(UI.el('p', { text: parts.length ? parts.join(' · ') : '未填写额外资料' }));
    }
    na.appendChild(oppCard);

    const allReady = !!(state.room?.players?.A?.profileReady && state.room?.players?.B?.profileReady);
    renderNextButton('开始冒险', 'flag', {
      disabled: !allReady,
      disabledText: me?.profileReady ? '等待对方完成角色资料…' : '请先保存角色资料',
    });
  }

  function profileInput(label, id, value, maxLength, placeholder, required = false) {
    return UI.el('label', { class: 'profile-field' }, [
      UI.el('span', { text: label }),
      UI.el('input', { id, value, maxlength: maxLength, placeholder, required }),
    ]);
  }

  function profileTextarea(label, id, value, maxLength, placeholder) {
    return UI.el('label', { class: 'profile-field' }, [
      UI.el('span', { text: label }),
      UI.el('textarea', { id, maxlength: maxLength, placeholder, rows: 3 }, [value]),
    ]);
  }

  // ---- 回合反馈页：本回合结果 + 双方选择揭晓 + 下一步 ----
  function renderSummaryPage(summary) {
    clearGameAreas();
    const na = $('narrative-area');
    na.className = 'info-page';
    na.appendChild(UI.el('div', { class: 'info-page-head' }, [
      UI.icon('list-checks'),
      UI.el('h2', { text: '本回合反馈' }),
      UI.el('span', { class: 'dm-tag' }, [UI.el('span', { text: '第 ' + (summary && summary.round) + ' 回合' })]),
    ]));
    if (summary) {
      const revealBox = UI.el('div', { class: 'reveal-box' }, [
        UI.el('div', { class: 'reveal-item' }, [UI.el('b', { text: summary.playerNames?.A || state.room?.players?.A?.name || '玩家 A' }), UI.el('span', { text: summary.choiceA || '（未行动）' })]),
        UI.el('div', { class: 'reveal-item' }, [UI.el('b', { text: summary.playerNames?.B || state.room?.players?.B?.name || '玩家 B' }), UI.el('span', { text: summary.choiceB || '（未行动）' })]),
      ]);
      na.appendChild(revealBox);
      const body = UI.el('div', { class: 'narrative-text rich-text' });
      na.appendChild(body);
      const text = summary.summary || '（本回合没有新的变化）';
      if (typedDone.summary === text) {
        UI.renderRichText(body, text);
      } else {
        typedDone.summary = text;
        typeNarrative(body, text);
      }
      if (summary.preloadStatus) {
        const preloadReady = summary.preloadStatus === 'ready';
        if (preloadReady) {
          finishGeneration('preload');
          na.appendChild(UI.el('div', { class: 'round-preload-status ready' }, [
            UI.icon('check-circle-2'), UI.el('span', { text: '下一回合已预加载' }),
          ]));
        } else if (summary.preloadStatus === 'loading') {
          na.appendChild(generationLoader('preload', { compact: true }));
        } else if (summary.preloadStatus === 'failed') {
          finishGeneration('preload');
          na.appendChild(UI.el('div', { class: 'round-preload-status retry' }, [
            UI.icon('refresh-cw'), UI.el('span', { text: '预加载未完成，双方确认后会自动重试' }),
          ]));
        }
      }
      renderStatusPanel(summary.storyState, state.me.role);
    }
    renderNextButton('下一步', 'arrow-right');
  }

  // 双方确认按钮（intro / summary 共用）
  function renderNextButton(label, iconName, options = {}) {
    const bar = $('action-bar');
    UI.clear(bar);
    const g = state.game;
    const meConfirmed = g.next.me;
    const oppConfirmed = g.next.opp;
    if (meConfirmed && oppConfirmed) {
      // 反馈页已经显示同一个后台预加载任务，不再重复创建第二张状态卡。
      if (g.phase !== 'summary') bar.appendChild(generationLoader('round', { compact: true }));
      return;
    }
    const btnText = options.disabled
      ? options.disabledText
      : meConfirmed
      ? (oppConfirmed ? '双方已确认，正在继续…' : '已确认，等待对方…')
      : label;
    bar.appendChild(UI.el('button', {
      class: 'btn btn-primary btn-block', type: 'button',
      disabled: meConfirmed || !!options.disabled,
      onclick: async () => {
        g.next.me = true;
        render();
        if (g.next.opp) beginGeneration('round');
        const res = await client.next();
        if (!res || !res.ok) {
          g.next.me = false;
          finishGeneration('round');
          UI.toast((res && res.error) || '继续失败，请重试');
          render();
        }
      },
    }, [UI.icon(meConfirmed ? 'loader' : iconName, meConfirmed ? 'icon-spin' : null), UI.el('span', { text: btnText })]));
  }

  // ---- 叙事打字机 ----
  function typeNarrative(el, text, onDone) {
    if (narrativeTyping.timer) clearInterval(narrativeTyping.timer);
    UI.renderRichText(el, '');
    narrativeTyping = { active: true, text };
    let i = 0;
    const step = () => {
      i = Math.min(text.length, i + 3);
      UI.renderRichText(el, text.slice(0, i));
      if (i >= text.length) {
        clearInterval(narrativeTyping.timer);
        narrativeTyping.active = false;
        if (onDone) onDone();
      }
    };
    narrativeTyping.timer = setInterval(step, 16);
  }

  // ---- 回合叙事 + 选项（打字机播完再出选项，给 AI 留"落笔"时间）----
  function renderRound(node) {
    if (typedDone.narrative === node.narrative) {
      // 同一段叙事已播完（如提交选择后重渲染）：直接渲染选择区
      renderRoundChoices(node);
      return;
    }
    typedDone.narrative = node.narrative;
    clearGameAreas();
    const na = $('narrative-area');
    na.className = 'narrative';
    na.appendChild(UI.el('div', { class: 'narrative-head' }, [
      UI.el('span', { class: 'dm-tag' }, [UI.icon('dices'), UI.el('span', { text: 'DM · 第 ' + node.round + ' 回合' })]),
    ]));
    const body = UI.el('div', { class: 'narrative-text rich-text' });
    na.appendChild(body);
    renderStatusPanel(node.story_state, state.me.role);
    const bar = $('action-bar');
    UI.clear(bar);
    bar.appendChild(waitLine('DM 正在落笔…'));
    typeNarrative(body, node.narrative, () => {
      renderRoundChoices(node);
      UI.refreshIcons();
    });
  }

  // 打字机播放期间的增量渲染：只更新顶栏/状态/对方区，不打断叙事
  function renderRoundStatusOnly(node) {
    renderStatusPanel(node.story_state, state.me.role);
  }

  function renderRoundChoices(node) {
    const myChoices = state.me.role === 'A' ? node.choices_A : node.choices_B;
    renderMyChoices(myChoices);
    const oppRole = OPP(state.me.role);
    const oppChoices = oppRole === 'A' ? node.choices_A : node.choices_B;
    renderOppChoices(oppChoices);
    renderActionBar();
  }

  function renderMyChoices(choices) {
    const box = $('my-choices');
    UI.clear(box);
    box.appendChild(UI.el('div', { class: 'block-head' }, [
      UI.el('div', { class: 'block-title' }, [UI.icon('sword'), UI.el('span', { text: '你的行动' })]),
      UI.el('div', { class: 'block-sub', text: state.turn.submitted ? '已提交' : '选择一项' }),
    ]));
    const list = UI.el('div', { class: 'choice-list' });
    (Array.isArray(choices) ? choices : []).forEach((rawChoice, index) => {
      const c = typeof rawChoice === 'string'
        ? { id: rawChoice, text: rawChoice }
        : { id: rawChoice?.id || rawChoice?.text || String(index), text: rawChoice?.text || rawChoice?.label || String(rawChoice?.id || '') };
      if (!c.text) return;
      const isPick = state.turn.myChoiceId === c.id;
      list.appendChild(UI.el('button', {
        class: 'choice-item' + (isPick ? ' selected' : ''),
        type: 'button',
        disabled: state.turn.submitted,
        onclick: () => pickChoice(c.id),
      }, [
        UI.el('span', { class: 'choice-index', text: String(index + 1) }),
        UI.el('span', { class: 'choice-text', text: c.text }),
        UI.icon(isPick ? 'check' : 'chevron-right', 'choice-mark'),
      ]));
    });
    box.appendChild(list);

    // 自定义行动：跑团自由行动，玩家可输入任意行动/台词
    const custom = UI.el('div', { class: 'custom-action' }, [
      UI.el('div', { class: 'custom-head' }, [UI.icon('pencil-line'), UI.el('span', { text: '自定义行动' })]),
      UI.el('div', { class: 'custom-row' }, [
        UI.el('input', {
          class: 'input custom-input',
          type: 'text',
          maxlength: '200',
          placeholder: '输入你想做的任意事…',
          value: state.turn.customText || '',
          disabled: state.turn.submitted,
          oninput: (e) => { state.turn.customText = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCustomChoice(); } },
        }),
        UI.el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          disabled: state.turn.submitted,
          onclick: submitCustomChoice,
        }, [UI.icon('send'), UI.el('span', { text: '提交' })]),
      ]),
    ]);
    box.appendChild(custom);
  }

  function submitCustomChoice() {
    if (state.turn.submitted) return;
    const inp = $('my-choices').querySelector('.custom-input');
    const text = (inp && inp.value || '').trim();
    if (!text) { UI.toast('先输入你的行动'); return; }
    state.turn.myChoiceId = text;
    state.turn.customText = text;
    submitMyChoice();
  }

  // 对方选择区：手机端简化为一行状态（不再陈列对方选项）
  function renderOppChoices(choices) {
    const box = $('opp-choices');
    UI.clear(box);
    const oppRole = OPP(state.me.role);
    const oppName = ((state.room.storyState && state.room.storyState[oppRole]) || {}).name || ('玩家 ' + oppRole);
    box.appendChild(UI.el('div', { class: 'opp-line' }, [
      UI.icon(state.turn.oppSubmitted ? 'check' : 'clock'),
      UI.el('span', {
        text: state.turn.oppSubmitted
          ? state.turn.submitted
            ? oppName + ' 已选择：' + (state.turn.oppChoiceText || '（行动已提交）')
            : oppName + ' 已完成选择'
          : oppName + ' 待选择',
      }),
    ]));
  }

  // 状态面板：紧凑横排，两位玩家各占一行
  function renderStatusPanel(storyState, myRole) {
    const panel = $('status-panel');
    UI.clear(panel);
    if (!storyState) return;
    const shared = deriveSharedState(storyState);
    const sharedKeys = new Set(Object.keys(shared));
    if (sharedKeys.size) panel.appendChild(sharedStatusCard(shared));
    panel.appendChild(UI.el('div', { class: 'status-row' }, [
      statusChip(storyState[myRole], myRole, true, sharedKeys),
      statusChip(storyState[OPP(myRole)], OPP(myRole), false, sharedKeys),
    ]));
  }

  const SHARED_STATE_KEYS = new Set(['位置', 'location', '场景', 'scene', '时间', 'time', '天气', 'weather', '共同目标', '队伍目标', 'team_goal', '共享物品', 'shared_inventory']);
  const OPPONENT_VISIBLE_KEYS = new Set(['name', 'hp', 'health', 'status', 'condition', 'location', 'position', 'alignment', 'level', 'class', '生命', '生命值', '状态', '位置', '阵营', '等级', '职业', '境界', '外观']);

  function deriveSharedState(storyState) {
    const explicit = storyState.shared || storyState.共同 || storyState.公共;
    const shared = explicit && !Array.isArray(explicit) && typeof explicit === 'object' ? { ...explicit } : {};
    const a = storyState.A || {};
    const b = storyState.B || {};
    SHARED_STATE_KEYS.forEach((key) => {
      if (key in a && key in b && JSON.stringify(a[key]) === JSON.stringify(b[key]) && !(key in shared)) shared[key] = a[key];
    });
    return shared;
  }

  function visibleStatusFields(player, own, sharedKeys) {
    if (!player || Array.isArray(player) || typeof player !== 'object') return {};
    const result = {};
    const publicPart = player._public || player.public || player.公开;
    const privatePart = player._private || player.private || player.私密;
    Object.entries(player).forEach(([key, value]) => {
      if (key === 'name' || sharedKeys.has(key)) return;
      if (['_public', 'public', '公开', '_private', 'private', '私密'].includes(key)) return;
      if (/^_?flags?(?:_|$)/i.test(key)) return;
      if (own || OPPONENT_VISIBLE_KEYS.has(key)) result[key] = value;
    });
    if (publicPart && !Array.isArray(publicPart) && typeof publicPart === 'object') Object.assign(result, publicPart);
    if (own && privatePart && !Array.isArray(privatePart) && typeof privatePart === 'object') Object.assign(result, privatePart);
    return result;
  }

  // AI 可自定义状态字段：字段名→图标/中文名；未收录的字段显示原名
  const FIELD_META = {
    hp: { icon: 'heart', label: '生命' },
    resources: { icon: 'gem', label: '资源' },
    alignment: { icon: 'scale', label: '阵营' },
    san: { icon: 'brain', label: '理智' },
    gold: { icon: 'coins', label: '金币' },
    mp: { icon: 'zap', label: '法力' },
    stamina: { icon: 'footsteps', label: '体力' },
    luck: { icon: 'clover', label: '幸运' },
  };

  function statusChip(p, role, isMe, sharedKeys = new Set()) {
    const chip = UI.el('div', { class: 'status-chip' + (isMe ? ' me' : '') });
    chip.appendChild(UI.el('div', { class: 'status-chip-head' }, [
      UI.el('span', { class: 'sc-name' }, [
        UI.icon(isMe ? 'user-check' : 'user'),
        UI.el('b', { text: (p && p.name) || state.room?.players?.[role]?.name || '玩家 ' + role }),
      ]),
      UI.el('span', { class: 'status-role' + (isMe ? ' me' : ''), text: isMe ? '你 · ' + role : '玩家 ' + role }),
    ]));
    if (p && typeof p === 'object') {
      const stats = UI.el('div', { class: 'status-stats' });
      for (const [key, val] of Object.entries(visibleStatusFields(p, isMe, sharedKeys))) {
        const meta = FIELD_META[key] || { icon: 'circle-dot', label: key };
        const display = val != null && typeof val === 'object' ? (Array.isArray(val) ? val.join('、') : JSON.stringify(val)) : String(val ?? '—');
        const wide = key === 'note' || key === 'notes' || display.length > 12;
        stats.appendChild(UI.el('div', { class: 'sc-stat' + (wide ? ' wide' : ''), title: meta.label }, [
          UI.icon(meta.icon),
          UI.el('span', { class: 'sc-stat-copy' }, [
            UI.el('small', { text: meta.label }),
            UI.el('strong', { text: display }),
          ]),
        ]));
      }
      chip.appendChild(stats);
    }
    return chip;
  }

  function sharedStatusCard(shared) {
    const card = UI.el('div', { class: 'shared-status-card' });
    card.appendChild(UI.el('div', { class: 'shared-status-head' }, [
      UI.icon('map-pinned'),
      UI.el('b', { text: '共同状态' }),
    ]));
    const grid = UI.el('div', { class: 'status-stats' });
    Object.entries(shared).forEach(([key, val]) => {
      const meta = FIELD_META[key] || { icon: 'circle-dot', label: key };
      const display = val != null && typeof val === 'object' ? (Array.isArray(val) ? val.join('、') : JSON.stringify(val)) : String(val ?? '—');
      grid.appendChild(UI.el('div', { class: 'sc-stat' + (display.length > 12 ? ' wide' : '') }, [
        UI.icon(meta.icon),
        UI.el('span', { class: 'sc-stat-copy' }, [UI.el('small', { text: meta.label }), UI.el('strong', { text: display })]),
      ]));
    });
    card.appendChild(grid);
    return card;
  }

  // 操作栏状态机：选择 → 提交 → 等待对方 → AI 推进 → 编织中 / 判定中
  function renderActionBar() {
    const bar = $('action-bar');
    UI.clear(bar);
    const t = state.turn;
    if (t.advancing && t.judging) {
      bar.appendChild(generationLoader('ending'));
      return;
    }
    if (t.advancing) {
      bar.appendChild(generationLoader('summary'));
      return;
    }
    if (t.advanceFailed && t.submitted && t.oppSubmitted) {
      bar.appendChild(UI.el('button', {
        class: 'btn btn-primary btn-block', type: 'button', onclick: requestRoundAdvance,
      }, [UI.icon('refresh-cw'), UI.el('span', { text: '重新结算' })]));
      return;
    }
    if (t.submitted && !t.oppSubmitted) {
      bar.appendChild(waitLine('已提交，等待对方选择…'));
      return;
    }
    if (t.submitted && t.oppSubmitted) {
      // 双方已提交 → 自动推进中
      beginGeneration('summary');
      bar.appendChild(generationLoader('summary'));
      return;
    }
    bar.appendChild(UI.el('button', {
      class: 'btn btn-primary btn-block', type: 'button',
      disabled: !t.myChoiceId,
      onclick: submitMyChoice,
    }, [UI.el('span', { text: t.myChoiceId ? '提交选择' : '请先选择一项行动' }), UI.icon('chevron-right')]));
  }

  function waitLine(text) {
    return UI.el('div', { class: 'waiting-line' }, [UI.icon('loader', 'icon-spin'), UI.el('span', { text })]);
  }

  function pickChoice(id) {
    if (state.turn.submitted) return;
    state.turn.myChoiceId = id;
    renderGame();
    UI.refreshIcons();
  }

  async function submitMyChoice() {
    if (!state.turn.myChoiceId || state.turn.submitted) return;
    state.turn.submitted = true;
    renderGame();
    UI.refreshIcons();
    const res = await client.submitChoice(state.turn.myChoiceId);
    if (!res || !res.ok) {
      state.turn.submitted = false;
      UI.toast((res && res.error) || '提交失败，请重试');
      renderGame();
      UI.refreshIcons();
    }
  }

  async function requestRoundAdvance() {
    if (state.turn.advancing || state.game.phase !== 'round') return;
    state.turn.advancing = true;
    state.turn.advanceFailed = false;
    beginGeneration('summary');
    render();
    const res = await client.advance();
    if (!res || !res.ok) {
      state.turn.advancing = false;
      state.turn.advanceFailed = true;
      finishGeneration('summary');
      UI.toast((res && res.error) || '推进失败，请重新结算');
      render();
    }
  }

  // ============ 6. 结局 ============
  function renderEnding() {
    const ending = state.room && state.room.ending;
    const box = $('ending-area');
    UI.clear(box);
    if (!ending) {
      box.appendChild(UI.el('p', { class: 'hint', text: '结局数据缺失' }));
      return;
    }
    box.appendChild(UI.el('div', { class: 'ending-head' }, [
      UI.icon('crown', 'ending-icon'),
      UI.el('h1', { text: ending.title }),
    ]));
    const endingText = UI.el('div', { class: 'ending-text rich-text' });
    UI.renderRichText(endingText, ending.text);
    box.appendChild(endingText);
    box.appendChild(tokenUsageNode(state.room?.tokenUsage, 'token-usage-ending'));

    // 本局回顾
    const recap = UI.el('div', { class: 'recap' });
    recap.appendChild(UI.el('div', { class: 'recap-title' }, [UI.icon('history'), UI.el('span', { text: '本局回顾' })]));
    (ending.history || []).forEach((h) => {
      const recapText = UI.el('div', { class: 'recap-text rich-text' });
      UI.renderRichText(recapText, h.narrative);
      const bodyKids = [
        recapText,
        UI.el('div', { class: 'recap-reveal' }, [
          UI.icon('history'),
          UI.el('span', { text: '第 ' + h.round + ' 回合' }),
        ]),
      ];
      if (h.choices) {
        bodyKids.push(UI.el('div', { class: 'recap-picks' }, [
          UI.el('span', { class: 'recap-pick' }, [UI.el('b', { text: 'A' }), UI.el('span', { text: h.choices.A ? h.choices.A.text : '（未选择）' })]),
          UI.el('span', { class: 'recap-pick' }, [UI.el('b', { text: 'B' }), UI.el('span', { text: h.choices.B ? h.choices.B.text : '（未选择）' })]),
        ]));
      }
      recap.appendChild(UI.el('div', { class: 'recap-item' }, [
        UI.el('div', { class: 'recap-round', text: 'R' + h.round }),
        UI.el('div', { class: 'recap-body' }, bodyKids),
      ]));
    });
    box.appendChild(recap);

    box.appendChild(UI.el('button', {
      class: 'btn btn-primary btn-block', type: 'button',
      onclick: async () => {
        await leaveCurrentRoom();
        switchView('player-entry');
      },
    }, [UI.icon('rotate-ccw'), UI.el('span', { text: '再来一局' })]));
  }

  // ============ 初始化 ============
  (async function init() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);

    // 管理员登录态与玩家房间态分别恢复，互不覆盖。
    const adminSession = await client.me();
    state.admin.loggedIn = !!(adminSession && adminSession.ok);
    state.adminView = state.admin.loggedIn ? 'admin-panel' : 'admin-login';

    const sess = loadSession();
    if (sess && sess.roomCode && sess.name) {
      $('inp-code').value = sess.roomCode;
      $('inp-name').value = sess.name;
      const res = await client.join({ roomCode: sess.roomCode, name: sess.name });
      if (res && res.ok) {
        if (res.room) state.room = res.room;
        state.me = { role: res.role, name: sess.name };
        resetTurn();
        if (state.playerView === 'player-entry') state.playerView = 'lobby';
      } else {
        clearSession();
        state.playerView = 'player-entry';
      }
    }

    const preferredWorkspace = loadActiveWorkspace();
    if (preferredWorkspace === 'admin') {
      if (state.admin.loggedIn) await enterAdminPanel();
      else switchView('admin-login');
    } else if (preferredWorkspace === 'player') {
      switchView(state.playerView);
    } else if (state.admin.loggedIn) {
      await enterAdminPanel();
    } else {
      switchView(state.playerView);
    }
    UI.refreshIcons();
  })();
})();
