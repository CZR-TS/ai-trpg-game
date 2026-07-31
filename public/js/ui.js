// UI 工具层：DOM 构造、lucide 刷新、轻提示、进度条
// 纯函数，不持有业务状态。

const UI = {
  // 创建元素：el('div', {class:'x', text:'hi'}, [child1, '文本'])
  el(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') for (const d in v) node.dataset[d] = v[d];
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else if (v !== false && v != null) node.setAttribute(k, v);
      }
    }
    (kids == null ? [] : Array.isArray(kids) ? kids : [kids]).forEach(k => {
      if (k == null || k === false) return;
      node.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return node;
  },

  // 图标占位：<i data-lucide="name">，渲染后由 refreshIcons 替换为 svg
  icon(name, cls) {
    return UI.el('i', { 'data-lucide': name, class: cls || '' });
  },

  // 刷新页面所有 <i data-lucide>（每次 DOM 更新后必须调用，否则动态图标不显示）
  refreshIcons() {
    if (window.lucide && lucide.createIcons) {
      lucide.createIcons({ attrs: { 'stroke-width': 1.5 } });
    }
  },

  clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); },

  escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  formatTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // 全局轻提示（自动消失）
  toast(msg, ms = 2200) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = UI.el('div', { id: 'toast-host', class: 'toast-host' });
      document.body.appendChild(host);
    }
    const t = UI.el('div', { class: 'toast' }, [UI.el('span', { text: msg })]);
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, ms);
  },

  // 进度条（0-1）
  progressBar(value, cls) {
    const v = Math.max(0, Math.min(1, value));
    return UI.el('div', { class: 'progress ' + (cls || '') }, [
      UI.el('div', { class: 'progress-fill', style: `width:${(v * 100).toFixed(1)}%` }),
    ]);
  },
};

window.UI = UI;
