// 主控：6 视图状态机 + 事件绑定 + 渲染
// 业务只调 window.client.xxx()，订阅 client 事件驱动渲染（事件名对齐后端契约）

(function () {
  const client = window.client;
  const $ = (id) => document.getElementById(id);
  const OPP = (role) => (role === 'A' ? 'B' : 'A');

  const state = {
    view: 'admin-login',   // admin-login | admin-panel | player-entry | lobby | game | ending
    admin: { loggedIn: false, worldbooks: [], current: null, rooms: [], history: [], lastRoom: null },
    room: null,            // 房间全量镜像（room:state 推送）
    me: null,              // { role, name }
    game: { phase: 'intro', intro: null, summary: null, next: { me: false, opp: false } }, // intro | round | summary | judging | ended
    turn: { myChoiceId: null, submitted: false, oppSubmitted: false, oppChoiceText: null, advancing: false, judging: false },
  };

  // ============ 视图切换 ============
  function switchView(name) {
    state.view = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('view-active', v.dataset.view === name));
    const isAdmin = name === 'admin-login' || name === 'admin-panel';
    document.querySelectorAll('.role-switch .link').forEach(b => b.classList.toggle('is-active', (b.dataset.role === 'admin') === isAdmin));
    render();
    window.scrollTo(0, 0);
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
    state.turn = { myChoiceId: null, submitted: false, oppSubmitted: false, oppChoiceText: null, advancing: false, judging: false };
    typedDone = { narrative: null, summary: null };
  }
  async function leaveCurrentRoom() {
    if (state.me) await client.leave();
    state.room = null;
    state.me = null;
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
  client.on('room:state', ({ room }) => { state.room = room; render(); });
  client.on('connection:error', ({ error }) => UI.toast(error || '连接异常，请稍后重试'));
  client.on('player:joined', () => render());
  client.on('player:ready', () => render());
  client.on('game:started', () => {});
  client.on('game:intro', ({ intro, round }) => {
    resetTurn();
    state.game = { phase: 'intro', intro, summary: null, next: { me: false, opp: false } };
    if (state.view !== 'game') switchView('game'); else render();
  });
  client.on('game:round', (payload) => {
    resetTurn();
    if (state.room) {
      state.room.currentNode = payload;
      state.room.round = payload.round;
      state.room.progress = payload.progress;
    }
    state.game.phase = 'round';
    state.game.next = { me: false, opp: false };
    if (state.view !== 'game') switchView('game'); else render();
  });
  client.on('game:summary', (payload) => {
    state.game.phase = 'summary';
    state.game.summary = payload;
    state.game.next = { me: false, opp: false };
    render();
  });
  client.on('game:next_update', ({ role, confirmed }) => {
    if (state.me && role === OPP(state.me.role)) state.game.next.opp = confirmed;
    render();
  });
  client.on('game:choice_update', ({ role, chosen, choiceText }) => {
    if (state.me && role !== state.me.role) {
      state.turn.oppSubmitted = chosen;
      state.turn.oppChoiceText = choiceText || null;   // 封缄回合无 choiceText
    }
    // 双方都提交 → 自动推进（无需手动点）
    if (state.turn.submitted && state.turn.oppSubmitted && !state.turn.advancing && state.game.phase === 'round') {
      state.turn.advancing = true;
      render();
      client.advance().then((res) => {
        if (!res || !res.ok) {
          state.turn.advancing = false;
          UI.toast((res && res.error) || '推进失败，请重试');
          render();
        }
      });
      return;
    }
    render();
  });
  client.on('game:judging', () => {   // mock 附加事件（后端可选）
    state.turn.advancing = true;
    state.turn.judging = true;
    render();
  });
  client.on('game:ended', ({ ending }) => {
    if (state.room) state.room.ending = ending;
    switchView('ending');
  });

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
    render();
  }

  async function refreshRooms() {
    const [roomsResult, historyResult] = await Promise.all([
      adminCall(() => client.listRooms()),
      adminCall(() => client.listRoomHistory()),
    ]);
    if (roomsResult && roomsResult.rooms) state.admin.rooms = roomsResult.rooms;
    if (historyResult && historyResult.history) state.admin.history = historyResult.history;
  }

  function renderAdminPanel() {
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
      if (!parsed || typeof parsed !== 'object' || !parsed.name || typeof parsed.entries !== 'object') {
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
      UI.el('div', { class: 'room-detail-row' }, [
        UI.el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => toggleRoomDetail(item, room) }, [UI.icon('eye'), UI.el('span', { text: '查看进度' })]),
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
        UI.el('span', { class: 'badge ended', text: '已结束' }),
      ]),
      record.ending?.title ? UI.el('div', { class: 'room-item-meta', text: '结局：' + record.ending.title }) : null,
      UI.el('div', { class: 'room-item-meta', text: '结束于 ' + UI.formatTime(record.endedAt || record.createdAt) }),
    ]);
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
    if (res.ok) {
      state.me = { role: res.role, name: '组织者预览' };
      resetTurn();
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
    if (action === 'go-home') {
      await leaveCurrentRoom();
      switchView('admin-login');
    }
    if (action === 'goto-admin') {
      await leaveCurrentRoom();
      if (state.admin.loggedIn) enterAdminPanel();
      else switchView('admin-login');
    }
    if (action === 'goto-player') {
      await leaveCurrentRoom();
      switchView('player-entry');
    }
    if (action === 'copy-code') {
      const code = state.room ? state.room.code : (state.admin.lastRoom ? state.admin.lastRoom.code : null);
      if (code) copyText(code);
    }
    if (action === 'admin-logout') {
      await client.logout();
      state.admin.loggedIn = false;
      UI.toast('已退出登录');
      switchView('player-entry');
    }
    if (action === 'create-room') createRoom();
    if (action === 'room-refresh') { await refreshRooms(); render(); }
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
      state.me = { role: res.role, name };
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

    const acts = $('lobby-actions');
    UI.clear(acts);
    const myPlayer = state.me && room.players && room.players[state.me.role];
    if (!myPlayer) return;
    acts.appendChild(UI.el('button', {
      class: 'btn ' + (myPlayer.ready ? 'btn-ghost' : 'btn-primary') + ' btn-block', type: 'button',
      onclick: () => client.setReady(),
    }, [UI.icon(myPlayer.ready ? 'check' : 'users'), UI.el('span', { text: myPlayer.ready ? '已准备（点击取消）' : '准备' })]));

    const aReady = room.players.A && room.players.A.ready;
    const bReady = room.players.B && room.players.B.ready;
    const isWaiting = room.status === 'lobby' || room.status === 'waiting';
    const isHost = state.me?.role === 'A';
    const canStart = isHost && aReady && bReady && isWaiting;
    acts.appendChild(UI.el('button', {
      class: 'btn btn-primary btn-block', type: 'button', disabled: !canStart,
      onclick: async () => {
        if (!canStart) return;
        // 立即反馈：真实 AI 生成开场需要一点时间
        UI.clear(acts);
        acts.appendChild(waitLine('DM 正在生成开场信息…'));
        UI.refreshIcons();
        const res = await client.startGame();
        if (!res || !res.ok) {
          UI.toast((res && res.error) || '开始失败，请重试');
          render();
        }
      },
    }, [UI.icon('play'), UI.el('span', { text: '开始游戏' })]));
    if (isWaiting && room.openingStatus === 'loading') {
      acts.appendChild(UI.el('p', { class: 'hint', text: 'DM 正在后台预生成开场，准备期间无需等待。' }));
    } else if (isWaiting && room.openingStatus === 'ready') {
      acts.appendChild(UI.el('p', { class: 'hint', text: '开场已预加载，可以立即开始。' }));
    } else if (!canStart) {
      const hint = !isWaiting
        ? '游戏进行中'
        : !aReady || !bReady
          ? '等待双方准备就绪…'
          : '双方已准备，等待房主开始…';
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

  function renderGame() {
    const room = state.room;
    const g = state.game;
    const node = room && room.currentNode;
    renderTopbar(room, node);
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
    if (node && phase === 'round') {
      const reveal = node.reveal !== false;
      top.appendChild(UI.el('span', { class: 'top-sep' }));
      top.appendChild(UI.el('span', { class: 'reveal-chip' + (reveal ? ' open' : ''), title: reveal ? '本回合对方选择对你可见' : '本回合对方选择封缄，结束后揭晓' }, [
        UI.icon(reveal ? 'eye' : 'eye-off'),
        UI.el('span', { text: reveal ? '对方选择可见' : '对方选择封缄' }),
      ]));
    }
    top.appendChild(UI.el('div', { class: 'top-progress' }, [UI.progressBar(room.progress)]));
  }

  function renderWaiting() {
    const na = $('narrative-area');
    UI.clear(na);
    na.className = 'narrative waiting';
    na.appendChild(UI.el('div', { class: 'ai-tag' }, [UI.icon('loader', 'icon-spin'), UI.el('span', { text: 'DM 正在准备开场…' })]));
    UI.clear($('my-choices')); UI.clear($('opp-choices')); UI.clear($('action-bar')); UI.clear($('status-panel'));
  }

  function clearGameAreas() {
    UI.clear($('narrative-area')); UI.clear($('my-choices')); UI.clear($('opp-choices'));
    UI.clear($('action-bar')); UI.clear($('status-panel'));
  }

  // ---- 开场信息页：世界观背景 + 双方角色 + 开始冒险 ----
  function renderIntroPage(intro) {
    clearGameAreas();
    const na = $('narrative-area');
    na.className = 'info-page';
    na.appendChild(UI.el('div', { class: 'info-page-head' }, [
      UI.icon('scroll-text'),
      UI.el('h2', { text: '世界背景' }),
    ]));
    na.appendChild(UI.el('div', { class: 'info-block' }, [
      UI.el('p', { class: 'info-world', text: (intro && intro.world) || '（开场信息生成中…）' }),
    ]));
    na.appendChild(UI.el('div', { class: 'info-roles' }, [
      UI.el('div', { class: 'info-role-card' }, [UI.icon('user'), UI.el('b', { text: '玩家 A' }), UI.el('p', { text: (intro && intro.roleA) || '' })]),
      UI.el('div', { class: 'info-role-card' }, [UI.icon('user'), UI.el('b', { text: '玩家 B' }), UI.el('p', { text: (intro && intro.roleB) || '' })]),
    ]));
    renderNextButton('开始冒险', 'flag');
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
        UI.el('div', { class: 'reveal-item' }, [UI.el('b', { text: '玩家 A' }), UI.el('span', { text: summary.choiceA || '（未行动）' })]),
        UI.el('div', { class: 'reveal-item' }, [UI.el('b', { text: '玩家 B' }), UI.el('span', { text: summary.choiceB || '（未行动）' })]),
      ]);
      na.appendChild(revealBox);
      const body = UI.el('div', { class: 'narrative-text' });
      na.appendChild(body);
      const text = summary.summary || '（本回合没有新的变化）';
      if (typedDone.summary === text) {
        body.textContent = text;
      } else {
        typedDone.summary = text;
        typeNarrative(body, text);
      }
      renderStatusPanel(summary.storyState, state.me.role);
    }
    renderNextButton('下一步', 'arrow-right');
  }

  // 双方确认按钮（intro / summary 共用）
  function renderNextButton(label, iconName) {
    const bar = $('action-bar');
    UI.clear(bar);
    const g = state.game;
    const meConfirmed = g.next.me;
    const oppConfirmed = g.next.opp;
    const btnText = meConfirmed
      ? (oppConfirmed ? '双方已确认，正在继续…' : '已确认，等待对方…')
      : label;
    bar.appendChild(UI.el('button', {
      class: 'btn btn-primary btn-block', type: 'button',
      disabled: meConfirmed,
      onclick: async () => {
        g.next.me = true;
        render();
        await client.next();
      },
    }, [UI.icon(meConfirmed ? 'loader' : iconName, meConfirmed ? 'icon-spin' : null), UI.el('span', { text: btnText })]));
  }

  // ---- 叙事打字机 ----
  function typeNarrative(el, text, onDone) {
    if (narrativeTyping.timer) clearInterval(narrativeTyping.timer);
    el.textContent = '';
    narrativeTyping = { active: true, text };
    let i = 0;
    const step = () => {
      i = Math.min(text.length, i + 3);
      el.textContent = text.slice(0, i);
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
    const body = UI.el('div', { class: 'narrative-text' });
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
    renderOppChoices(oppChoices, node.reveal);
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
    choices.forEach((c) => {
      const isPick = state.turn.myChoiceId === c.id;
      list.appendChild(UI.el('button', {
        class: 'choice-item' + (isPick ? ' selected' : ''),
        type: 'button',
        disabled: state.turn.submitted,
        onclick: () => pickChoice(c.id),
      }, [
        UI.el('span', { class: 'choice-text', text: c.text }),
        isPick ? UI.icon('check', 'choice-mark') : null,
      ]));
    });
    box.appendChild(list);

    // 自定义行动：跑团自由行动，玩家可输入任意行动/台词
    const custom = UI.el('div', { class: 'custom-action' }, [
      UI.el('div', { class: 'custom-head' }, [UI.icon('pencil-line'), UI.el('span', { text: '自定义行动' })]),
      UI.el('div', { class: 'custom-row' }, [
        UI.el('input', {
          class: 'custom-input',
          type: 'text',
          placeholder: '输入你想做的任意事…',
          maxlength: '120',
          disabled: state.turn.submitted,
        }),
        UI.el('button', {
          class: 'btn btn-ghost custom-btn',
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
    submitMyChoice();
  }

  // 对方选择区：手机端简化为一行状态（不再陈列对方选项）
  function renderOppChoices(choices, reveal) {
    const box = $('opp-choices');
    UI.clear(box);
    const oppRole = OPP(state.me.role);
    const oppName = ((state.room.storyState && state.room.storyState[oppRole]) || {}).name || ('玩家 ' + oppRole);
    if (!reveal) {
      box.appendChild(UI.el('div', { class: 'opp-line sealed' }, [
        state.turn.oppSubmitted ? UI.icon('lock') : UI.icon('loader', 'icon-spin'),
        UI.el('span', { text: state.turn.oppSubmitted ? oppName + ' 已选择 · 封缄中' : oppName + ' 思考中…' }),
      ]));
      return;
    }
    box.appendChild(UI.el('div', { class: 'opp-line' }, [
      UI.icon(state.turn.oppSubmitted ? 'check' : 'clock'),
      UI.el('span', {
        text: state.turn.oppSubmitted
          ? oppName + ' 已选择：' + (state.turn.oppChoiceText || '（行动已提交）')
          : oppName + ' 待选择',
      }),
    ]));
  }

  // 状态面板：紧凑横排，两位玩家各占一行
  function renderStatusPanel(storyState, myRole) {
    const panel = $('status-panel');
    UI.clear(panel);
    if (!storyState) return;
    panel.appendChild(UI.el('div', { class: 'status-row' }, [
      statusChip(storyState[myRole], myRole, true),
      statusChip(storyState[OPP(myRole)], OPP(myRole), false),
    ]));
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

  function statusChip(p, role, isMe) {
    const chip = UI.el('div', { class: 'status-chip' + (isMe ? ' me' : '') });
    chip.appendChild(UI.el('span', { class: 'sc-name' }, [
      UI.icon(isMe ? 'user-check' : 'user'),
      UI.el('b', { text: (p && p.name) || '玩家 ' + role }),
    ]));
    if (p && typeof p === 'object') {
      for (const [key, val] of Object.entries(p)) {
        if (key === 'name') continue;
        const meta = FIELD_META[key] || { icon: 'circle-dot', label: key };
        chip.appendChild(UI.el('span', { class: 'sc-stat', title: meta.label }, [
          UI.icon(meta.icon),
          UI.el('span', { text: meta.label + ' ' + val }),
        ]));
      }
    }
    return chip;
  }

  // 操作栏状态机：选择 → 提交 → 等待对方 → AI 推进 → 编织中 / 判定中
  function renderActionBar() {
    const bar = $('action-bar');
    UI.clear(bar);
    const t = state.turn;
    if (t.advancing && t.judging) {
      bar.appendChild(waitLine('DM 正在判定结局…'));
      return;
    }
    if (t.advancing) {
      bar.appendChild(waitLine('DM 正在编织剧情…'));
      return;
    }
    if (t.submitted && !t.oppSubmitted) {
      bar.appendChild(waitLine('已提交，等待对方选择…'));
      return;
    }
    if (t.submitted && t.oppSubmitted) {
      // 双方已提交 → 自动推进中
      bar.appendChild(waitLine('DM 正在编织本回合结果…'));
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
    box.appendChild(UI.el('div', { class: 'ending-text', text: ending.text }));

    // 本局回顾（封缄回合事后揭秘）
    const recap = UI.el('div', { class: 'recap' });
    recap.appendChild(UI.el('div', { class: 'recap-title' }, [UI.icon('history'), UI.el('span', { text: '本局回顾' })]));
    (ending.history || []).forEach((h) => {
      const sealed = h.reveal === false;
      const bodyKids = [
        UI.el('div', { class: 'recap-text', text: h.narrative }),
        UI.el('div', { class: 'recap-reveal' + (sealed ? ' sealed' : '') }, [
          UI.icon(sealed ? 'lock' : 'eye'),
          UI.el('span', { text: '第 ' + h.round + ' 回合 · ' + (sealed ? '封缄回合' : '公开回合') }),
        ]),
      ];
      if (h.choices) {
        bodyKids.push(UI.el('div', { class: 'recap-picks' + (sealed ? ' sealed' : '') }, [
          UI.el('span', { class: 'recap-pick' }, [UI.el('b', { text: 'A' }), UI.el('span', { text: h.choices.A ? h.choices.A.text : '（未选择）' })]),
          UI.el('span', { class: 'recap-pick' }, [UI.el('b', { text: 'B' }), UI.el('span', { text: h.choices.B ? h.choices.B.text : '（未选择）' })]),
          sealed ? UI.el('span', { class: 'recap-sealed-tag' }, [UI.icon('lock'), UI.el('span', { text: '封缄揭晓' })]) : null,
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
    // 默认显示玩家入口；若检测到已登录（Cookie 7 天），自动进入后台
    const me = await client.me();
    if (me && me.ok) {
      state.admin.loggedIn = true;
      enterAdminPanel();
    } else {
      switchView('player-entry');
    }
    UI.refreshIcons();
  })();
})();
