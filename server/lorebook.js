import fs from 'node:fs';
import path from 'node:path';

/** 世界书引擎：加载、关键词匹配、递归激活与预算裁剪。 */
export function loadWorldbookFile(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data || Array.isArray(data) || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
    throw new Error('世界书格式无效：entries 必须为对象');
  }
  const entries = Object.values(data.entries).map(normalizeEntry);
  return {
    name: data.name || path.basename(filePath, '.json'),
    recursive_scanning: data.recursive_scanning !== false,
    scan_depth: Number.isInteger(data.scan_depth) ? Math.max(0, data.scan_depth) : null,
    token_budget: Number.isFinite(Number(data.token_budget)) ? Math.max(0, Number(data.token_budget)) : null,
    recursive_depth: Number.isInteger(data.recursive_depth) ? Math.max(0, data.recursive_depth) : 2,
    entries,
  };
}

function stringList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.filter((item) => typeof item === 'string' && item.length > 0);
}

function normalizeEntry(e = {}) {
  return {
    uid: e.uid ?? 0,
    key: stringList(e.key),
    keysecondary: stringList(e.keysecondary),
    content: typeof e.content === 'string' ? e.content : '',
    constant: !!e.constant,
    order: Number.isFinite(Number(e.order)) ? Number(e.order) : 100,
    disable: !!e.disable,
    probability: Math.min(100, Math.max(0, Number(e.probability ?? 100))),
    group: typeof e.group === 'string' ? e.group : '',
    groupWeight: Math.max(0, Number(e.groupWeight ?? 100)),
    selective: e.selective !== false,
    selectiveLogic: [0, 1, 2, 3].includes(e.selectiveLogic) ? e.selectiveLogic : 0,
    caseSensitive: e.caseSensitive === true,
    matchWholeWords: e.matchWholeWords === true,
    excludeRecursion: !!e.excludeRecursion,
    preventRecursion: !!e.preventRecursion,
    delayUntilRecursion: !!e.delayUntilRecursion,
  };
}

/** 估算 token：CJK 1 字≈1，其余按字符数/3。 */
export function estimateTokens(text) {
  if (!text) return 0;
  let t = 0;
  for (const ch of text) t += /[\u4e00-\u9fff\u3040-\u30ff]/.test(ch) ? 1 : 1 / 3;
  return Math.ceil(t);
}

function pickWeighted(list) {
  const total = list.reduce((sum, entry) => sum + entry.groupWeight, 0);
  if (total <= 0) return list[cryptoIndex(list.length)];
  let random = Math.random() * total;
  for (const entry of list) {
    random -= entry.groupWeight;
    if (random <= 0) return entry;
  }
  return list[list.length - 1];
}

function cryptoIndex(length) {
  return Math.floor(Math.random() * length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordHit(text, keyword, entry) {
  if (!keyword) return false;
  const source = entry.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = entry.caseSensitive ? keyword : keyword.toLocaleLowerCase();
  if (!entry.matchWholeWords) return source.includes(needle);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}_])`, 'u');
  return pattern.test(source);
}

function entryMatches(entry, text) {
  if (!entry.key.some((keyword) => keywordHit(text, keyword, entry))) return false;
  if (!entry.selective || entry.keysecondary.length === 0) return true;
  const hits = entry.keysecondary.map((keyword) => keywordHit(text, keyword, entry));
  switch (entry.selectiveLogic) {
    case 1: return !hits.every(Boolean); // NOT ALL
    case 2: return !hits.some(Boolean);  // NOT ANY
    case 3: return hits.every(Boolean);  // AND ALL
    default: return hits.some(Boolean);  // AND ANY
  }
}

/** 按 order 升序返回预算内的已激活条目。 */
export function activateEntries(worldbook, scanText, opts = {}) {
  if (!worldbook || !Array.isArray(worldbook.entries)) return [];
  const budget = Math.max(0, Number(opts.budget ?? 1500));
  const maxRecursion = Math.max(0, Number(opts.maxRecursion ?? worldbook.recursive_depth ?? 2));
  let text = String(scanText || '');
  const activated = [];
  const activatedSet = new Set();
  const probabilityChecked = new Set();
  const resolvedGroups = new Set();

  const sweep = (depth) => {
    const direct = [];
    const groupPool = new Map();
    for (const entry of worldbook.entries) {
      if (entry.disable || activatedSet.has(entry)) continue;
      if (depth === 0 && entry.delayUntilRecursion) continue;
      if (depth > 0 && entry.excludeRecursion) continue;
      const hit = entry.constant ? depth === 0 : entryMatches(entry, text);
      if (!hit) continue;
      if (!probabilityChecked.has(entry)) {
        probabilityChecked.add(entry);
        if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue;
      } else if (!activatedSet.has(entry)) {
        continue;
      }
      if (entry.group) {
        if (resolvedGroups.has(entry.group)) continue;
        if (!groupPool.has(entry.group)) groupPool.set(entry.group, []);
        groupPool.get(entry.group).push(entry);
      } else {
        direct.push(entry);
      }
    }
    for (const [group, candidates] of groupPool) {
      const selected = pickWeighted(candidates);
      if (selected) direct.push(selected);
      resolvedGroups.add(group);
    }
    for (const entry of direct) {
      if (activatedSet.has(entry)) continue;
      activatedSet.add(entry);
      activated.push(entry);
    }
    return direct;
  };

  let frontier = sweep(0);
  if (worldbook.recursive_scanning) {
    for (let depth = 1; depth <= maxRecursion; depth++) {
      const extra = frontier
        .filter((entry) => !entry.preventRecursion && !entry.constant)
        .map((entry) => entry.content)
        .join('\n');
      if (!extra) break;
      text += `\n${extra}`;
      frontier = sweep(depth);
      if (frontier.length === 0) break;
    }
  }

  activated.sort((a, b) => a.order - b.order);
  const byPriority = [...activated].sort((a, b) => b.order - a.order);
  let used = 0;
  const selected = [];
  for (const entry of byPriority) {
    const cost = estimateTokens(entry.content);
    if (used + cost > budget) continue;
    selected.push(entry);
    used += cost;
  }
  selected.sort((a, b) => a.order - b.order);
  return selected;
}

export function buildLoreText(worldbook, activated) {
  if (!activated.length) return '';
  return '【世界设定·仅注入与当前剧情相关的条目】\n' + activated.map((entry) => entry.content).join('\n\n');
}
