// The chat screen: templates, composer (text, attachments, format), sending
// with live progress and stop, and rendering replies with document cards.
import { api, streamGenerate } from './api.js';
import { IS_NATIVE } from './config.js';
import { state, emit, persist, upsertDocumentSummary } from './state.js';
import { icon, escapeHtml, formatMessage, formatBadge, formatLabel, toast, setLoading } from './ui.js';
import { buildDocument } from './builders.js';
import { saveFile } from './native.js';
import { reportContent } from './report.js';

const $ = (id) => document.getElementById(id);
let openStudio = () => {};
let openUpgrade = () => {};

const TEMPLATES = [
  { emoji: '🧾', title: 'Invoice', desc: 'Items, VAT and totals', format: 'pdf',
    prompt: 'Create a professional invoice from my company to a client for 3 services, with quantities, unit prices, 12% VAT and a grand total.' },
  { emoji: '👤', title: 'CV / Resume', desc: 'Modern one-page CV', format: 'docx',
    prompt: 'Write a modern one-page CV for a junior software developer with a profile summary, skills, experience, education and projects.' },
  { emoji: '📊', title: 'Monthly budget', desc: 'Spreadsheet with formulas', format: 'xlsx',
    prompt: 'Make a monthly personal budget spreadsheet with income, expense categories, planned vs actual amounts, the difference, and totals using formulas.' },
  { emoji: '✉️', title: 'Business letter', desc: 'Formal and polite', format: 'docx',
    prompt: 'Write a formal business letter to a potential partner requesting a meeting to discuss cooperation.' },
  { emoji: '📈', title: 'Sales report', desc: 'Summary, table, insights', format: 'pdf',
    prompt: 'Create a quarterly sales report with an executive summary, a table of monthly sales by product, key insights and next steps.' },
  { emoji: '📝', title: 'Meeting minutes', desc: 'Decisions and action items', format: 'docx',
    prompt: 'Prepare meeting minutes with attendees, agenda, discussion points, decisions, and action items with owners and deadlines.' }
];

const MAX_ATTACHMENTS = 5;
const MAX_TEXT_FILE = 1024 * 1024;
const MAX_IMAGE_SOURCE = 25 * 1024 * 1024;

let attachments = [];
let abortController = null;
let loadToken = 0;
const legacyDocs = new Map();

export function initChat(hooks) {
  openStudio = hooks.openStudio;
  openUpgrade = hooks.openUpgrade;

  renderTemplates();
  setFormat(state.format);

  $('formatSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-format]');
    if (btn) setFormat(btn.dataset.format);
  });

  const prompt = $('prompt');
  prompt.addEventListener('input', () => { autosize(); updateSendState(); });
  prompt.addEventListener('keydown', e => {
    // Enter sends on devices with a keyboard; on phones Enter adds a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      send();
    }
  });
  prompt.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  $('sendBtn').addEventListener('click', () => (state.generating ? stop() : send()));
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });

  $('messages').addEventListener('click', onMessagesClick);
  updateSendState();
}

export function setGreeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = (state.user?.name || '').split(/\s+/)[0];
  $('greeting').textContent = first ? `${part}, ${first}` : 'What should we create?';
}

function renderTemplates() {
  $('templates').innerHTML = TEMPLATES.map((t, i) => `
    <button class="template" type="button" data-template="${i}">
      <span class="t-emoji" aria-hidden="true">${t.emoji}</span>
      <span class="t-title">${escapeHtml(t.title)}</span>
      <span class="t-desc">${escapeHtml(t.desc)} · ${formatLabel(t.format)}</span>
    </button>`).join('');
  $('templates').addEventListener('click', e => {
    const btn = e.target.closest('[data-template]');
    if (!btn) return;
    const t = TEMPLATES[Number(btn.dataset.template)];
    setFormat(t.format);
    const prompt = $('prompt');
    prompt.value = t.prompt;
    autosize();
    updateSendState();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  });
}

function setFormat(format) {
  state.format = format;
  persist('format', format);
  $('formatSeg').querySelectorAll('[data-format]').forEach(b => {
    const active = b.dataset.format === format;
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', String(active));
  });
}

function autosize() {
  const el = $('prompt');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

function updateSendState() {
  const btn = $('sendBtn');
  const hasInput = $('prompt').value.trim().length > 0 || attachments.length > 0;
  btn.classList.toggle('stop', state.generating);
  btn.innerHTML = icon(state.generating ? 'stop' : 'send');
  btn.setAttribute('aria-label', state.generating ? 'Stop' : 'Send');
  btn.disabled = !state.generating && !hasInput;
}

// ---------- conversations ----------

export function newChat() {
  if (state.generating) stop();
  loadToken++;
  state.currentConversationId = null;
  $('messages').innerHTML = '';
  $('empty').classList.remove('hidden');
  $('topTitle').textContent = 'DocGen AI';
  setGreeting();
  emit('conversation-selected', null);
}

export async function openConversation(id) {
  if (state.generating) stop();
  const token = ++loadToken;
  state.currentConversationId = id;
  emit('conversation-selected', id);
  const convo = state.conversations.find(c => c.id === id);
  $('topTitle').textContent = convo?.title || 'Chat';
  $('empty').classList.add('hidden');
  $('messages').innerHTML = `<div class="status-line">${dots()}<span>Loading chat…</span></div>`;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (token !== loadToken) return;
    $('topTitle').textContent = data.title;
    $('messages').innerHTML = '';
    data.messages.forEach(m => appendMessage(m, { animate: false }));
    scrollToBottom(true);
  } catch (err) {
    if (token !== loadToken) return;
    if (err.status === 404) {
      toast('That chat no longer exists.', { type: 'error' });
      state.conversations = state.conversations.filter(c => c.id !== id);
      emit('conversations-changed');
      newChat();
      return;
    }
    $('messages').innerHTML = '';
    appendError(err.message, () => openConversation(id));
  }
}

// Called by the drawer after a chat is renamed or deleted.
export function onConversationRenamed(id, title) {
  if (state.currentConversationId === id) $('topTitle').textContent = title;
}

// ---------- rendering ----------

function dots() {
  return '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
}

function isNearBottom() {
  const el = $('chat');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

function scrollToBottom(force = false) {
  const el = $('chat');
  if (force || isNearBottom()) {
    el.style.scrollBehavior = force ? 'auto' : '';
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = '';
  }
}

function docCardHtml(doc, { legacyKey } = {}) {
  const data = legacyKey ? `data-legacy="${escapeHtml(legacyKey)}"` : `data-doc="${escapeHtml(doc.id)}"`;
  return `
    <button class="doc-card" type="button" ${data} data-action="open-doc">
      ${formatBadge(doc.format)}
      <span class="dc-main">
        <span class="dc-title">${escapeHtml(doc.title || 'Document')}</span>
        <span class="dc-meta">${formatLabel(doc.format)} · Tap to view and edit</span>
      </span>
      ${icon('pencil')}
    </button>
    <div class="doc-card-actions">
      <button class="btn btn-secondary" type="button" ${data} data-action="download-doc">${icon('download')}Download</button>
    </div>`;
}

function appendMessage(m, { animate = true, suggestions = null } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'user' ? 'user' : 'assistant'}`;
  if (m.role === 'user') {
    el.textContent = m.content || '';
    if (m.attachmentNames?.length) {
      const atts = document.createElement('div');
      atts.className = 'msg-attachments';
      atts.innerHTML = m.attachmentNames.map(n => `<span class="msg-att">${icon('paperclip')} ${escapeHtml(n)}</span>`).join('');
      el.appendChild(atts);
    }
  } else {
    let html = `<div class="bubble-text">${formatMessage(m.content || '')}</div>`;
    if (m.document) {
      html += docCardHtml(m.document);
    } else if (m.legacyDocument) {
      const key = `legacy_${m.id}`;
      legacyDocs.set(key, { ...m.legacyDocument, messageId: m.id });
      html += docCardHtml(m.legacyDocument, { legacyKey: key });
    }
    if (suggestions?.length) {
      html += `<div class="suggestions">${suggestions.map(s => `<button class="chip" type="button" data-action="suggest">${escapeHtml(s)}</button>`).join('')}</div>`;
    }
    html += `<div class="msg-tools"><button class="icon-btn" type="button" data-action="copy" aria-label="Copy">${icon('copy')}</button>` +
      (m.id ? `<button class="icon-btn" type="button" data-action="report" aria-label="Report this response">${icon('flag')}</button>` : '') + '</div>';
    el.innerHTML = html;
    el.dataset.raw = m.content || '';
    if (m.id) el.dataset.messageId = m.id;
  }
  if (!animate) el.style.animation = 'none';
  $('messages').appendChild(el);
  return el;
}

function appendError(message, onRetry, { upgrade = false } = {}) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="msg-error">${icon('alert')}<div><div>${escapeHtml(message)}</div>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${upgrade ? '<button class="btn btn-primary" data-upgrade type="button">See plans</button>' : ''}
      ${onRetry ? `<button class="btn btn-secondary" data-retry type="button">${icon('refresh')}Try again</button>` : ''}
    </div></div></div>`;
  el.querySelector('[data-retry]')?.addEventListener('click', () => { el.remove(); onRetry(); });
  el.querySelector('[data-upgrade]')?.addEventListener('click', () => openUpgrade());
  $('messages').appendChild(el);
  scrollToBottom();
  return el;
}

async function resolveDocId(btn) {
  if (btn.dataset.doc) return btn.dataset.doc;
  const key = btn.dataset.legacy;
  const legacy = legacyDocs.get(key);
  if (!legacy) return null;
  if (legacy.importedId) return legacy.importedId;
  // Documents from older versions of the app live only inside the chat
  // message — copy them into the library the first time they're opened.
  const { document: doc } = await api('/api/documents', {
    method: 'POST',
    body: { schema: legacy.schema, format: legacy.format, conversationId: state.currentConversationId, messageId: legacy.messageId }
  });
  legacy.importedId = doc.id;
  upsertDocumentSummary(doc);
  document.querySelectorAll(`[data-legacy="${key}"]`).forEach(b => { b.dataset.doc = doc.id; b.removeAttribute('data-legacy'); });
  return doc.id;
}

async function onMessagesClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'suggest') {
    $('prompt').value = btn.textContent;
    btn.closest('.suggestions')?.remove();
    send();
  } else if (action === 'copy') {
    const raw = btn.closest('.msg')?.dataset.raw || '';
    try {
      await navigator.clipboard.writeText(raw);
      toast('Copied', { type: 'success', duration: 1500 });
    } catch {
      toast('Couldn’t copy on this device.', { type: 'error' });
    }
  } else if (action === 'report') {
    const id = Number(btn.closest('.msg')?.dataset.messageId);
    if (id) reportContent({ messageId: id });
  } else if (action === 'open-doc') {
    try {
      const id = await resolveDocId(btn);
      if (id) openStudio(id);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  } else if (action === 'download-doc') {
    setLoading(btn, true);
    try {
      const id = await resolveDocId(btn);
      const { document: doc } = await api(`/api/documents/${encodeURIComponent(id)}`);
      const file = await buildDocument(doc.schema, doc.format);
      const how = await saveFile(file.blob, file.filename, file.mime);
      if (how === 'downloaded') toast(`Downloaded ${file.filename}`, { type: 'success' });
    } catch (err) {
      toast(err.status === 404 ? 'This document was deleted.' : err.message, { type: 'error' });
    } finally {
      setLoading(btn, false);
    }
  }
}

// ---------- attachments ----------

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Phone photos are often 5–12 MB; shrink them so uploads are fast and the
// AI gets a sensible size.
async function downscaleImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('unreadable'));
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addFiles(files) {
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast(`You can attach up to ${MAX_ATTACHMENTS} files.`, { type: 'error' });
      break;
    }
    try {
      if (file.type.startsWith('image/')) {
        if (!state.config.vision) { toast('Image attachments aren’t supported right now. Try a text file instead.', { type: 'error' }); continue; }
        if (file.size > MAX_IMAGE_SOURCE) { toast(`"${file.name}" is too large.`, { type: 'error' }); continue; }
        const dataUrl = await downscaleImage(file);
        attachments.push({ kind: 'image', name: file.name || 'image.jpg', dataUrl });
      } else {
        if (file.size > MAX_TEXT_FILE) { toast(`"${file.name}" is too large (max 1 MB for text files).`, { type: 'error' }); continue; }
        const text = await file.text();
        if (/\u0000/.test(text.slice(0, 2000))) { toast(`"${file.name}" isn’t a text file. Attach images or text files (TXT, CSV, MD, JSON).`, { type: 'error' }); continue; }
        attachments.push({ kind: 'text', name: file.name, text });
      }
    } catch {
      toast(`Couldn’t read "${file.name}".`, { type: 'error' });
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const row = $('attachRow');
  row.classList.toggle('hidden', attachments.length === 0);
  row.innerHTML = attachments.map((a, i) => `
    <div class="att-chip">
      ${a.kind === 'image' ? `<img src="${a.dataUrl}" alt="">` : icon('file')}
      <span class="att-name">${escapeHtml(a.name)}</span>
      <button class="icon-btn" type="button" data-remove="${i}" aria-label="Remove ${escapeHtml(a.name)}">${icon('x')}</button>
    </div>`).join('');
  row.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    attachments.splice(Number(b.dataset.remove), 1);
    renderAttachments();
  }));
  updateSendState();
}

// ---------- sending ----------

function stop() {
  abortController?.abort();
}

function send() {
  if (state.generating) return;
  const text = $('prompt').value.trim();
  if (!text && attachments.length === 0) return;

  const body = {
    text,
    format: state.format,
    conversationId: state.currentConversationId,
    attachments: attachments.map(a => a.kind === 'image' ? { kind: 'image', name: a.name, dataUrl: a.dataUrl } : { kind: 'text', name: a.name, text: a.text })
  };

  $('empty').classList.add('hidden');
  document.querySelectorAll('#messages .suggestions').forEach(s => s.remove());
  appendMessage({ role: 'user', content: text || 'Attached file(s)', attachmentNames: attachments.map(a => a.name) });
  $('prompt').value = '';
  attachments = [];
  renderAttachments();
  autosize();
  scrollToBottom(true);
  run(body);
}

export function friendlyQuotaMessage(err) {
  const resetsAt = err.data?.resetsAt;
  const resets = resetsAt ? new Date(resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null;
  return resets ? `${err.message} It resets on ${resets}.` : err.message;
}

async function run(body) {
  state.generating = true;
  updateSendState();
  const conversationAtStart = state.currentConversationId;
  const token = loadToken;

  const pending = document.createElement('div');
  pending.className = 'msg assistant';
  pending.innerHTML = `<div class="status-line">${dots()}<span class="status-text">Thinking…</span></div>`;
  $('messages').appendChild(pending);
  scrollToBottom(true);
  const setStatus = (t) => { const s = pending.querySelector('.status-text'); if (s) s.textContent = t; };

  abortController = new AbortController();
  let finished = false;
  try {
    await streamGenerate(body, {
      signal: abortController.signal,
      onEvent: (event, data) => {
        if (token !== loadToken) return;
        if (event === 'meta' && data.conversationId && !body.conversationId) {
          body.conversationId = data.conversationId;
          if (state.currentConversationId === conversationAtStart) {
            state.currentConversationId = data.conversationId;
            const title = (body.text || body.attachments[0]?.name || 'New chat').replace(/\s+/g, ' ').slice(0, 80);
            state.conversations.unshift({ id: data.conversationId, title, updatedAt: new Date().toISOString() });
            $('topTitle').textContent = title;
            emit('conversations-changed');
            emit('conversation-selected', data.conversationId);
          }
        } else if (event === 'status') {
          setStatus(data.text);
          scrollToBottom();
        } else if (event === 'result') {
          finished = true;
          pending.remove();
          handleResult(data);
        } else if (event === 'error') {
          finished = true;
          pending.remove();
          appendError(data.message, () => run(body));
        }
      }
    });
  } catch (err) {
    pending.remove();
    if (token !== loadToken) return;
    if (err.code === 'aborted') {
      const el = document.createElement('div');
      el.className = 'msg assistant';
      el.innerHTML = '<div class="muted">Stopped.</div>';
      $('messages').appendChild(el);
    } else if (err.code === 'quota_exceeded') {
      appendError(friendlyQuotaMessage(err), null, { upgrade: !IS_NATIVE });
      emit('usage-refresh');
    } else if (!finished) {
      appendError(err.message, () => run(body));
    }
  } finally {
    state.generating = false;
    abortController = null;
    updateSendState();
    bumpConversation(body.conversationId);
  }
}

function bumpConversation(id) {
  if (!id) return;
  const i = state.conversations.findIndex(c => c.id === id);
  if (i > 0) {
    const [c] = state.conversations.splice(i, 1);
    c.updatedAt = new Date().toISOString();
    state.conversations.unshift(c);
    emit('conversations-changed');
  }
}

function handleResult(data) {
  if (data.conversationTitle) {
    const c = state.conversations.find(x => x.id === data.conversationId);
    if (c) { c.title = data.conversationTitle; emit('conversations-changed'); }
    if (state.currentConversationId === data.conversationId) $('topTitle').textContent = data.conversationTitle;
  }
  if (data.action === 'generate' && data.document) {
    const doc = data.document;
    upsertDocumentSummary(doc);
    appendMessage({ id: data.messageId, role: 'assistant', content: data.message, document: { id: doc.id, title: doc.title, format: doc.format } }, { suggestions: data.suggestions });
    if (data.usage) emit('usage-changed', data.usage);
    emit('document-updated', doc);
    if (data.usage?.remaining === 1) toast('Heads up: you have 1 free document left this month.', { type: 'info', duration: 4500 });
  } else {
    appendMessage({ id: data.messageId, role: 'assistant', content: data.message }, { suggestions: data.suggestions });
  }
  scrollToBottom();
}

// Used by the studio: after an AI edit, show the exchange in the chat if
// that conversation is on screen.
export function appendExternalExchange(conversationId, userText, result) {
  if (!conversationId || conversationId !== state.currentConversationId) return;
  appendMessage({ role: 'user', content: userText });
  if (result.action === 'generate' && result.document) {
    appendMessage({ id: result.messageId, role: 'assistant', content: result.message, document: { id: result.document.id, title: result.document.title, format: result.document.format } });
  } else {
    appendMessage({ id: result.messageId, role: 'assistant', content: result.message });
  }
}

export function resetChatState() {
  newChat();
  attachments = [];
  renderAttachments();
  $('prompt').value = '';
}
