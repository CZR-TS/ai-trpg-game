const STATUS_LABELS = {
  waiting: '等待中',
  playing: '进行中',
  ended: '已结束',
};

function text(value, fallback = '—') {
  const result = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  return result || fallback;
}
function markdownBody(value, fallback = '—') {
  return text(value, fallback)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`_[\]])/g, '\\$1')
    .replace(/^(\s*)(#{1,6}|>|[-+*]|\d+\.)\s/gm, '$1\\$2 ')
    .replace(/^(\s*)(\*{3,}|-{3,})\s*$/gm, '$1\\$2');
}


function inline(value, fallback = '—') {
  return text(value, fallback)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n+/g, ' ')
    .replace(/([\\`*_[\]<>])/g, '\\$1');
}

function formatDate(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function playerData(record, role) {
  const rawPlayer = record.players?.[role];
  const name = typeof rawPlayer === 'object'
    ? rawPlayer?.displayName || rawPlayer?.name
    : rawPlayer;
  const profile = record.playerProfiles?.[role]
    || (typeof rawPlayer === 'object' ? rawPlayer?.profile : null)
    || {};
  return { name: text(name, `玩家 ${role}`), profile };
}

function appendProfile(lines, role, player, openingText) {
  lines.push(`### 玩家 ${role}：${inline(player.name)}`, '');
  const fields = [
    ['性别', player.profile?.gender],
    ['性格', player.profile?.personality],
    ['补充设定', player.profile?.details],
  ].filter(([, value]) => String(value ?? '').trim());
  if (!fields.length) {
    lines.push('未填写角色资料。', '');
  } else {
    for (const [label, value] of fields) lines.push(`- **${label}**：${inline(value)}`);
  }
  lines.push('');
  if (openingText) {
    lines.push('**开场介绍**', '', markdownBody(openingText), '');
  }
}

function exportRounds(record) {
  const rounds = Array.isArray(record.history) ? record.history.map((item) => ({ ...item })) : [];
  const current = record.currentNode;
  const currentRound = Number(current?.round ?? record.round);
  if (current?.narrative && !rounds.some((item) => Number(item.round) === currentRound)) {
    rounds.push({
      round: currentRound || rounds.length + 1,
      narrative: current.narrative,
      choiceA: record.chosen?.A,
      choiceB: record.chosen?.B,
      current: true,
    });
  }
  return rounds.sort((a, b) => Number(a.round || 0) - Number(b.round || 0));
}

/** 将进行中房间或历史记录转换为不包含内部状态的 Markdown 故事文档。 */
export function buildStoryMarkdown(record, { worldbookName } = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('房间记录无效');
  const playerA = playerData(record, 'A');
  const playerB = playerData(record, 'B');
  const opening = record.intro || (Array.isArray(record.history) ? record.history : []).find((item) => item?.intro)?.intro
    || record.currentNode?.intro
    || null;
  const lines = [
    `# 共叙故事：${inline(record.code, '未知房间')}`,
    '',
    `- **世界书**：${inline(worldbookName || record.worldbookName || record.worldbookId, '未知')}`,
    `- **房间码**：${inline(record.code)}`,
    `- **状态**：${STATUS_LABELS[record.status] || inline(record.status, '未知')}`,
    `- **故事进度**：${Math.round(Math.max(0, Math.min(1, Number(record.progress) || 0)) * 100)}%`,
    `- **创建时间**：${formatDate(record.createdAt)}`,
  ];
  if (record.endedAt) lines.push(`- **结束时间**：${formatDate(record.endedAt)}`);
  if (opening?.world) {
    lines.push('', '## 世界背景', '', markdownBody(opening.world));
  }
  lines.push('', '## 角色资料', '');
  appendProfile(lines, 'A', playerA, opening?.roleA);
  appendProfile(lines, 'B', playerB, opening?.roleB);
  lines.push('## 故事正文', '');

  const rounds = exportRounds(record);
  if (!rounds.length) lines.push('故事尚未开始。', '');
  for (const round of rounds) {
    const suffix = round.current ? '（当前）' : '';
    lines.push(`### 第 ${Number(round.round) || 0} 回合${suffix}`, '', markdownBody(round.narrative, '（无叙事内容）'), '');
    lines.push(`- **${inline(playerA.name)}的选择**：${inline(round.choiceA, '尚未选择')}`);
    lines.push(`- **${inline(playerB.name)}的选择**：${inline(round.choiceB, '尚未选择')}`, '');
  }

  if (record.ending?.title || record.ending?.text) {
    lines.push('## 结局', '', `### ${inline(record.ending?.title, '结局')}`, '', markdownBody(record.ending?.text, '（无结局内容）'), '');
  }
  lines.push('---', '', '由「共叙」导出。', '');
  return lines.join('\n');
}

export function storyExportFilename(code) {
  const safe = String(code || 'story').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32) || 'story';
  return `共叙-${safe}.md`;
}
