// Side drawer: account chip, chat history and the document library.
import { api } from './api.js';
import { state, on, emit, persist, upsertDocumentSummary } from './state.js';
import {
  icon, escapeHtml, formatBadge, formatLabel, relativeTime, debounce, toast,
  pushOverlay, showMenu, confirmDialog, promptDialog
} from './ui.js';
import { buildDocument } from './builders.js';
import { saveFile } from './native.js';
import { IS_NATIVE } from './config.js';

const $ = (id) => document.getElementById(id);
const desktop = matchMedia('(min-width: 900px)');
let hooks = {};
let unregisterOverlay = null;
let tab = 'chats';
let searchResults = null;
let searchToken = 0;
let listsLoaded = false;

export function initDrawer(h) {
  hooks = h;
  $('menuBtn').addEventListener('click', openDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('newChatBtn').addEventListener('click', () => { hooks.newChat(); closeDrawer(); });
  $('topNewChat').addEventListener('click', () => hooks.newChat());
  $('accountChip').addEventListener('click', () => { closeDrawer(); hooks.openSettings(); });

  document.querySelectorAll('.drawer-tabs [data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  try { if (localStorage.getItem('drawerTab') === 'docs') setTab('docs'); } catch { /* ignore */ }

  const runSearch = debounce(search, 300);
  $('docSearch').addEventListener('input', runSearch);

  $('chatList').addEventListener('click', onChatListClick);
  $('docList').addEventListener('click', onDocListClick);
  // Rows are div[role=button] (they contain a nested menu button), so wire up keyboard activation.
  [$('chatList'), $('docList')].forEach(list => list.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-chat], [data-open-doc]')) {
      e.preventDefault();
      e.target.click();
    }
  }));

  on('conversations-changed', renderChats);
  on('conversation-selected', renderChats);
  on('documents-changed', () => { if (!$('docSearch').value.trim()) searchResults = null; renderDocs(); });
  desktop.addEventListener('change', () => { if (desktop.matches) closeDrawer(); });
}

export function openDrawer() {
  if (desktop.matches) return;
  $('drawer').classList.add('open');
  $('scrim').classList.add('show');
  if (!unregisterOverlay) unregisterOverlay = pushOverlay(closeDrawer);
}

export function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').classList.remove('show');
  unregisterOverlay?.();
  unregisterOverlay = null;
}

function setTab(name) {
  tab = name;
  persist('drawerTab', name);
  document.querySelectorAll('.drawer-tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('chatList').classList.toggle('hidden', name !== 'chats');
  $('docList').classList.toggle('hidden', name !== 'docs');
  $('docSearchWrap').classList.toggle('hidden', name !== 'docs');
}

export function renderAccount() {
  const u = state.user;
  if (!u) return;
  const avatar = $('avatar');
  if (u.avatarUrl) {
    avatar.textContent = '';
    avatar.style.backgroundImage = `url("${u.avatarUrl.replace(/"/g, '%22')}")`;
  } else {
    avatar.style.backgroundImage = '';
    avatar.textContent = (u.name || u.email || '?').trim().charAt(0).toUpperCase();
  }
  $('accountName').textContent = u.name || u.email;
  renderPlanLabel();
}

export function renderPlanLabel() {
  const b = state.billing;
  const el = $('accountPlan');
  if (!b) { el.textContent = ''; return; }
  if (b.plan === 'pro') {
    const until = b.planExpiresAt ? ` · until ${new Date(b.planExpiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
    el.innerHTML = `<span class="plan-pro">Pro</span>${escapeHtml(until)}`;
  } else {
    el.textContent = `Free · ${b.remaining ?? 0} of ${b.limit} documents left`;
  }
}

export async function loadLists() {
  const [c, d] = await Promise.allSettled([api('/api/conversations'), api('/api/documents')]);
  if (c.status === 'fulfilled') state.conversations = c.value.conversations;
  if (d.status === 'fulfilled') { state.documents = d.value.documents; state.documentsLoaded = true; }
  listsLoaded = true;
  renderChats();
  renderDocs();
  const failed = [c, d].find(r => r.status === 'rejected');
  if (failed && failed.reason?.status !== 401) {
    toast('Couldn’t load your chats and documents.', { type: 'error', action: { label: 'Retry', onClick: loadLists } });
  }
}

export function clearLists() {
  listsLoaded = false;
  searchResults = null;
  $('docSearch').value = '';
  $('chatList').innerHTML = '';
  $('docList').innerHTML = '';
}

// ---------- chats ----------

function dayBucket(date) {
  const d = new Date(date);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((start - d) / 86400000) + 1;
  if (d >= start) return 'Today';
  if (diffDays <= 1) return 'Yesterday';
  if (diffDays <= 7) return 'Previous 7 days';
  if (diffDays <= 30) return 'Previous 30 days';
  return 'Older';
}

function renderChats() {
  const list = $('chatList');
  if (!listsLoaded) { list.innerHTML = '<div class="list-empty">Loading…</div>'; return; }
  if (!state.conversations.length) {
    list.innerHTML = '<div class="list-empty">No chats yet.<br>Start one — it will appear here.</div>';
    return;
  }
  let html = '';
  let bucket = null;
  for (const c of state.conversations) {
    const b = dayBucket(c.updatedAt);
    if (b !== bucket) { html += `<div class="list-section">${b}</div>`; bucket = b; }
    const active = c.id === state.currentConversationId ? ' active' : '';
    html += `<div class="list-item${active}" role="button" tabindex="0" data-chat="${escapeHtml(c.id)}">
      <span class="li-main"><span class="li-title">${escapeHtml(c.title)}</span></span>
      <button class="icon-btn li-more" type="button" data-chat-more="${escapeHtml(c.id)}" aria-label="Chat options">${icon('more')}</button>
    </div>`;
  }
  list.innerHTML = html;
}

function onChatListClick(e) {
  const more = e.target.closest('[data-chat-more]');
  if (more) { chatMenu(more.dataset.chatMore); return; }
  const item = e.target.closest('[data-chat]');
  if (item) {
    closeDrawer();
    if (item.dataset.chat !== state.currentConversationId) hooks.openConversation(item.dataset.chat);
  }
}

function chatMenu(id) {
  const c = state.conversations.find(x => x.id === id);
  if (!c) return;
  showMenu([
    { icon: 'pencil', label: 'Rename', onClick: async () => {
      const title = await promptDialog({ title: 'Rename chat', value: c.title, maxLength: 120 });
      if (!title || title === c.title) return;
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } });
        c.title = title;
        renderChats();
        hooks.onConversationRenamed(id, title);
      } catch (err) { toast(err.message, { type: 'error' }); }
    } },
    { icon: 'trash', label: 'Delete chat', danger: true, onClick: async () => {
      const ok = await confirmDialog({
        title: 'Delete this chat?',
        message: 'The conversation will be deleted. Documents it created stay in your library.',
        confirmLabel: 'Delete', danger: true
      });
      if (!ok) return;
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.conversations = state.conversations.filter(x => x.id !== id);
        state.documents.forEach(d => { if (d.conversationId === id) d.conversationId = null; });
        if (state.currentConversationId === id) hooks.newChat();
        renderChats();
        toast('Chat deleted');
      } catch (err) { toast(err.message, { type: 'error' }); }
    } }
  ], { title: c.title });
}

// ---------- documents ----------

async function search() {
  const q = $('docSearch').value.trim();
  const token = ++searchToken;
  if (!q) { searchResults = null; renderDocs(); return; }
  try {
    const { documents } = await api(`/api/documents?q=${encodeURIComponent(q)}`);
    if (token !== searchToken) return;
    searchResults = documents;
    renderDocs();
  } catch (err) {
    if (token === searchToken) toast(err.message, { type: 'error' });
  }
}

function renderDocs() {
  const list = $('docList');
  if (!listsLoaded) { list.innerHTML = '<div class="list-empty">Loading…</div>'; return; }
  const docs = searchResults ?? state.documents;
  if (!docs.length) {
    list.innerHTML = searchResults
      ? '<div class="list-empty">No documents match your search.</div>'
      : '<div class="list-empty">Your documents will appear here.<br>Every file you create is saved automatically.</div>';
    return;
  }
  list.innerHTML = docs.map(d => `
    <div class="list-item" role="button" tabindex="0" data-open-doc="${escapeHtml(d.id)}">
      ${formatBadge(d.format)}
      <span class="li-main">
        <span class="li-title">${escapeHtml(d.title)}</span>
        <span class="li-meta">${formatLabel(d.format)} · ${relativeTime(d.updatedAt)}</span>
      </span>
      <button class="icon-btn li-more" type="button" data-doc-more="${escapeHtml(d.id)}" aria-label="Document options">${icon('more')}</button>
    </div>`).join('');
}

function onDocListClick(e) {
  const more = e.target.closest('[data-doc-more]');
  if (more) { docMenu(more.dataset.docMore); return; }
  const item = e.target.closest('[data-open-doc]');
  if (item) { closeDrawer(); hooks.openStudio(item.dataset.openDoc); }
}

function findDoc(id) {
  return state.documents.find(x => x.id === id) || searchResults?.find(x => x.id === id);
}

function docMenu(id) {
  const d = findDoc(id);
  if (!d) return;
  showMenu([
    { icon: 'pencil', label: 'Open and edit', onClick: () => { closeDrawer(); hooks.openStudio(id); } },
    { icon: IS_NATIVE ? 'share' : 'download', label: IS_NATIVE ? 'Share / save' : 'Download', onClick: async () => {
      try {
        const { document: full } = await api(`/api/documents/${encodeURIComponent(id)}`);
        const file = await buildDocument(full.schema, full.format);
        const how = await saveFile(file.blob, file.filename, file.mime);
        if (how === 'downloaded') toast(`Downloaded ${file.filename}`, { type: 'success' });
      } catch (err) { toast(err.message, { type: 'error' }); }
    } },
    { icon: 'copy', label: 'Duplicate', onClick: async () => {
      try {
        const { document: copy } = await api(`/api/documents/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
        upsertDocumentSummary(copy);
        toast('Copy created', { type: 'success' });
      } catch (err) { toast(err.message, { type: 'error' }); }
    } },
    { icon: 'text', label: 'Rename', onClick: async () => {
      const title = await promptDialog({ title: 'Rename document', value: d.title, maxLength: 300 });
      if (!title || title === d.title) return;
      try {
        const { document: saved } = await api(`/api/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } });
        upsertDocumentSummary(saved);
        if (searchResults) { const r = searchResults.find(x => x.id === id); if (r) r.title = saved.title; renderDocs(); }
        emit('document-renamed', saved);
      } catch (err) { toast(err.message, { type: 'error' }); }
    } },
    { icon: 'trash', label: 'Delete', danger: true, onClick: async () => {
      const ok = await confirmDialog({ title: 'Delete this document?', message: `“${d.title}” will be permanently deleted.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.documents = state.documents.filter(x => x.id !== id);
        if (searchResults) searchResults = searchResults.filter(x => x.id !== id);
        renderDocs();
        toast('Document deleted');
      } catch (err) { toast(err.message, { type: 'error' }); }
    } }
  ], { title: d.title });
}
