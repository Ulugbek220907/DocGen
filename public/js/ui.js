// Shared UI building blocks: icons, toasts, dialogs, bottom sheets, menus,
// and small text helpers. Every overlay registers on one stack so the
// Android back button always closes the top-most thing first.

const P = (d) => `<path d="${d}"/>`;
const ICONS = {
  menu: P('M4 6h16M4 12h16M4 18h16'),
  plus: P('M12 5v14M5 12h14'),
  send: P('M22 2 11 13') + P('M22 2l-7 20-4-9-9-4z'),
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  paperclip: P('M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'),
  x: P('M18 6 6 18M6 6l12 12'),
  settings: '<circle cx="12" cy="12" r="3"/>' + P('M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'),
  search: '<circle cx="11" cy="11" r="7"/>' + P('M21 21l-4.35-4.35'),
  edit: P('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7') + P('M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'),
  pencil: P('M12 20h9') + P('M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'),
  back: P('M15 18l-6-6 6-6'),
  undo: P('M3 7v6h6') + P('M21 17a9 9 0 0 0-15-6.7L3 13'),
  redo: P('M21 7v6h-6') + P('M3 17a9 9 0 0 1 15-6.7L21 13'),
  more: '<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>',
  download: P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4') + P('M7 10l5 5 5-5') + P('M12 15V3'),
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>' + P('M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98'),
  external: P('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6') + P('M15 3h6v6') + P('M10 14L21 3'),
  sparkles: P('M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z') + P('M19 3v4M17 5h4'),
  trash: P('M3 6h18') + P('M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6') + P('M10 11v6M14 11v6') + P('M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2'),
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/>' + P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
  check: P('M20 6L9 17l-5-5'),
  logout: P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4') + P('M16 17l5-5-5-5') + P('M21 12H9'),
  user: '<circle cx="12" cy="7" r="4"/>' + P('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'),
  eye: P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z') + '<circle cx="12" cy="12" r="3"/>',
  eyeOff: P('M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24') + P('M1 1l22 22'),
  refresh: P('M23 4v6h-6') + P('M1 20v-6h6') + P('M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'),
  file: P('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z') + P('M14 2v6h6'),
  crown: P('M2 18h20M3 7l4.5 4L12 5l4.5 6L21 7l-2 11H5z'),
  shield: P('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'),
  chat: P('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'),
  up: P('M12 19V5M5 12l7-7 7 7'),
  down: P('M12 5v14M19 12l-7 7-7-7'),
  list: P('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'),
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/>' + P('M3 9h18M3 15h18M9 3v18'),
  text: P('M4 7V4h16v3M9 20h6M12 4v16'),
  globe: '<circle cx="12" cy="12" r="10"/>' + P('M2 12h20') + P('M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'),
  alert: '<circle cx="12" cy="12" r="10"/>' + P('M12 8v4M12 16h.01'),
  flag: P('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z') + P('M4 22v-7')
};

export function icon(name) {
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg></span>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.dataset.hydrated) return;
    el.dataset.hydrated = '1';
    el.outerHTML = icon(el.dataset.icon);
  });
}

// ---------- text helpers ----------

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// **bold**, *italic*, `code`, ^(sup), _(sub) on ALREADY-escaped text.
export function renderRichText(escaped) {
  return String(escaped)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\^\(([^)]+)\)/g, '<sup>$1</sup>')
    .replace(/\^([A-Za-z0-9+\-=]+)/g, '<sup>$1</sup>')
    .replace(/_\(([^)]+)\)/g, '<sub>$1</sub>');
}

// Light markdown for chat replies: paragraphs, bullet and numbered lists.
export function formatMessage(raw) {
  const lines = escapeHtml(raw).split('\n');
  let html = '';
  let list = null;
  let para = [];
  const flush = () => { if (para.length) { html += `<p>${para.map(renderRichText).join('<br>')}</p>`; para = []; } };
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    const t = line.trim();
    const bullet = t.match(/^[-*•]\s+(.*)/);
    const num = t.match(/^\d+[.)]\s+(.*)/);
    if (!t) { flush(); close(); continue; }
    if (bullet || num) {
      flush();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) { close(); html += `<${type}>`; list = type; }
      html += `<li>${renderRichText((bullet || num)[1])}</li>`;
    } else {
      close();
      para.push(t.replace(/^#{1,4}\s+/, ''));
    }
  }
  flush(); close();
  return html;
}

export function relativeTime(date) {
  const d = new Date(date);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function formatLabel(format) {
  return { pdf: 'PDF', docx: 'Word', xlsx: 'Excel' }[format] || String(format).toUpperCase();
}

export function formatBadge(format) {
  const label = { pdf: 'PDF', docx: 'DOC', xlsx: 'XLS' }[format] || '';
  return `<span class="fmt-badge fmt-${escapeHtml(format)}">${label}</span>`;
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('loading', !!loading);
  btn.disabled = !!loading;
}

// ---------- toasts ----------

export function toast(message, { type = 'info', action, duration } = {}) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { remove(); action.onClick(); });
    el.appendChild(btn);
  }
  root.appendChild(el);
  while (root.children.length > 3) root.firstChild.remove();
  const remove = () => el.remove();
  setTimeout(remove, duration || (type === 'error' ? 5500 : 3000));
  return remove;
}

// ---------- overlay stack ----------

const stack = [];

export function pushOverlay(close) {
  const entry = { close };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
  };
}

// For the Android back button. Returns true if something was closed.
export function closeTopOverlay() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

function mountBackdrop(contentEl, { onDismiss, dismissible = true } = {}) {
  const root = document.getElementById('overlay-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.appendChild(contentEl);
  root.appendChild(backdrop);

  let closed = false;
  let unregister = () => {};
  const close = (value) => {
    if (closed) return;
    closed = true;
    unregister();
    backdrop.remove();
    onDismiss?.(value);
  };
  unregister = pushOverlay(() => close(undefined));
  if (dismissible) backdrop.addEventListener('click', e => { if (e.target === backdrop) close(undefined); });
  return close;
}

// Bottom sheet (centered modal on wide screens).
export function openSheet({ title, body, onClose }) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.innerHTML = `
    <div class="sheet-grip"></div>
    <div class="sheet-head"><div class="sheet-title">${escapeHtml(title || '')}</div>
      <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body"></div>`;
  const bodyEl = sheet.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const close = mountBackdrop(sheet, { onDismiss: onClose });
  sheet.querySelector('[data-close]').addEventListener('click', () => close());
  return { el: sheet, body: bodyEl, close };
}

// Action menu as a bottom sheet: items = [{ icon, label, danger, onClick }].
export function showMenu(items, { title } = {}) {
  const list = document.createElement('div');
  list.className = 'menu-list';
  const { close } = openSheet({ title: title || '', body: list });
  items.filter(Boolean).forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'menu-item' + (item.danger ? ' danger' : '');
    btn.innerHTML = `${icon(item.icon || 'check')}<span>${escapeHtml(item.label)}</span>`;
    btn.addEventListener('click', () => { close(); item.onClick(); });
    list.appendChild(btn);
  });
}

export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'dialog';
    box.setAttribute('role', 'alertdialog');
    box.innerHTML = `<h3>${escapeHtml(title)}</h3>${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <div class="dialog-actions">
        <button class="btn btn-secondary" data-no>${escapeHtml(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(confirmLabel)}</button>
      </div>`;
    const close = mountBackdrop(box, { onDismiss: v => resolve(!!v) });
    box.querySelector('[data-no]').addEventListener('click', () => close(false));
    box.querySelector('[data-yes]').addEventListener('click', () => close(true));
    box.querySelector('[data-yes]').focus();
  });
}

export function promptDialog({ title, value = '', placeholder = '', confirmLabel = 'Save', maxLength = 200 }) {
  return new Promise(resolve => {
    const box = document.createElement('form');
    box.className = 'dialog';
    box.innerHTML = `<h3>${escapeHtml(title)}</h3>
      <input class="input" maxlength="${maxLength}" placeholder="${escapeHtml(placeholder)}" />
      <div class="dialog-actions">
        <button class="btn btn-secondary" type="button" data-no>Cancel</button>
        <button class="btn btn-primary" type="submit">${escapeHtml(confirmLabel)}</button>
      </div>`;
    const input = box.querySelector('input');
    input.value = value;
    const close = mountBackdrop(box, { onDismiss: v => resolve(typeof v === 'string' ? v : null) });
    box.querySelector('[data-no]').addEventListener('click', () => close(null));
    box.addEventListener('submit', e => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}
