// Document studio: a WYSIWYG "paper" editor for the document model with
// undo/redo, autosave, section/table tools, AI edits, and export.
import './doc-schema.js';
import { api, streamGenerate } from './api.js';
import { IS_NATIVE } from './config.js';
import { state, emit, upsertDocumentSummary } from './state.js';
import {
  icon, escapeHtml, renderRichText, formatLabel, formatMessage, toast, setLoading,
  pushOverlay, showMenu, confirmDialog, openSheet, debounce
} from './ui.js';
import { buildDocument } from './builders.js';
import { saveFile, openFile } from './native.js';
import { isFormula, displayCell, parseNumber } from './formula.js';
import { reportContent } from './report.js';

const DocSchema = globalThis.DocSchema;
const $ = (id) => document.getElementById(id);

// plaintext-only keeps pasted/typed content free of stray HTML where supported.
const EDITABLE = (() => {
  const d = document.createElement('div');
  try { d.contentEditable = 'plaintext-only'; } catch { return 'true'; }
  return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
})();

let doc = null;            // { id, title, format, conversationId, schema }
let undoStack = [];
let redoStack = [];
let burst = null;          // groups consecutive typing into one undo step
let saveState = 'saved';   // saved | dirty | saving | error
let savePromise = null;
let unregisterOverlay = null;
let openToken = 0;
let lastCell = null;       // { sec, r, c } of the last focused table cell
let aiBusy = false;
let shiftHeld = false;
let hooks = { openConversation: () => {}, onAiExchange: () => {}, openUpgrade: () => {}, quotaMessage: (e) => e.message };

export function initStudio(h) {
  hooks = { ...hooks, ...h };
  const paper = $('paper');

  $('studioClose').addEventListener('click', closeStudio);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('studioMore').addEventListener('click', moreMenu);
  $('studioTitle').addEventListener('click', () => focusPath('title'));
  $('studioDownload').addEventListener('click', download);
  $('studioOpen').addEventListener('click', openExternally);
  $('studioFormat').addEventListener('click', e => {
    const btn = e.target.closest('[data-format]');
    if (btn && doc && btn.dataset.format !== doc.format) setFormat(btn.dataset.format);
  });
  $('aiEditForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('aiEditInput').value.trim();
    if (text) aiEdit(text);
  });

  paper.addEventListener('input', onInput);
  paper.addEventListener('beforeinput', onBeforeInput);
  paper.addEventListener('keydown', onKeyDown);
  paper.addEventListener('keyup', e => { shiftHeld = e.shiftKey; });
  paper.addEventListener('paste', onPaste);
  paper.addEventListener('focusin', onFocusIn);
  paper.addEventListener('focusout', onFocusOut);
  paper.addEventListener('click', onPaperClick);

  $('studio').addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); flushSave(); }
  });

  // Save before the app is backgrounded or the tab is closed.
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('beforeunload', e => {
    if (saveState === 'dirty' || saveState === 'saving') { flushSave(); e.preventDefault(); }
  });

  $('studioDownload').innerHTML = IS_NATIVE ? `${icon('share')}Share` : `${icon('download')}Download`;
}

export function isStudioOpen() {
  return !$('studio').classList.contains('hidden');
}

export function currentDocumentId() {
  return isStudioOpen() ? doc?.id : null;
}

// ---------- open / close ----------

export async function openStudio(id) {
  const token = ++openToken;
  if (doc && doc.id !== id) flushSave();
  const studio = $('studio');
  studio.classList.remove('hidden');
  studio.classList.remove('editing');
  if (!unregisterOverlay) unregisterOverlay = pushOverlay(closeStudio);
  $('studioTitle').textContent = 'Loading…';
  setStatus('');
  $('paper').innerHTML = '<div class="status-line"><span class="dots"><i></i><i></i><i></i></span><span>Opening document…</span></div>';
  setActionsEnabled(false);

  try {
    const { document: d } = await api(`/api/documents/${encodeURIComponent(id)}`);
    if (token !== openToken) return;
    doc = { id: d.id, title: d.title, format: d.format, conversationId: d.conversationId, schema: DocSchema.normalize(d.schema) };
    undoStack = [];
    redoStack = [];
    burst = null;
    saveState = 'saved';
    lastCell = null;
    $('aiEditInput').value = '';
    render();
    syncChrome();
    setStatus('All changes saved');
    setActionsEnabled(true);
    $('studioScroll').scrollTop = 0;
  } catch (err) {
    if (token !== openToken) return;
    if (err.status === 404) {
      toast('This document was deleted.', { type: 'error' });
      state.documents = state.documents.filter(x => x.id !== id);
      emit('documents-changed');
      closeStudio();
      return;
    }
    $('paper').innerHTML = `<div class="msg-error">${icon('alert')}<div><div>${escapeHtml(err.message)}</div>
      <button class="btn btn-secondary" type="button" id="studioRetry">${icon('refresh')}Try again</button></div></div>`;
    $('studioRetry').addEventListener('click', () => openStudio(id));
  }
}

export function closeStudio() {
  if (!isStudioOpen()) return;
  openToken++;
  if (document.activeElement && $('paper').contains(document.activeElement)) document.activeElement.blur();
  flushSave();
  $('studio').classList.add('hidden');
  unregisterOverlay?.();
  unregisterOverlay = null;
}

function setActionsEnabled(on) {
  ['undoBtn', 'redoBtn', 'studioMore', 'studioDownload', 'studioOpen'].forEach(id => { $(id).disabled = !on; });
  $('aiEditForm').classList.toggle('busy', !on);
  if (on) updateUndoButtons();
}

function syncChrome() {
  $('studioTitle').textContent = doc.schema.title || 'Untitled document';
  $('studioFormat').querySelectorAll('[data-format]').forEach(b => {
    const active = b.dataset.format === doc.format;
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', String(active));
  });
  document.querySelector('.studio-hint').textContent = {
    pdf: 'Tap any text to edit · PDF is best for sharing',
    docx: 'Tap any text to edit · Word is easy to edit later',
    xlsx: 'Tap any text to edit · Excel keeps formulas live'
  }[doc.format];
  // Browsers can only show PDFs; on Android any installed viewer app works.
  const open = $('studioOpen');
  open.classList.toggle('hidden', !IS_NATIVE && doc.format !== 'pdf');
  open.innerHTML = `${icon('external')}${IS_NATIVE ? 'Open' : 'Open PDF'}`;
}

function setStatus(text, { error = false, retry = null } = {}) {
  const el = $('studioStatus');
  el.classList.toggle('error', error);
  el.textContent = text;
  if (retry) {
    const b = document.createElement('button');
    b.className = 'link-btn small';
    b.textContent = 'Retry';
    b.style.marginLeft = '6px';
    b.addEventListener('click', retry);
    el.appendChild(b);
  }
}

// ---------- rendering ----------

function hasMarkup(text) {
  return /\*\*|\*\S|`|\^|_\(/.test(text);
}

function tableForPath(path) {
  const p = path.split('.');
  return doc.schema.sections[+p[1]]?.table || null;
}

// What an element shows when it isn't being edited: computed values for
// formulas, bold/italic for markdown-style markers, plain text otherwise.
function displayFor(path, text) {
  if (path.includes('.t.r.')) {
    const shown = displayCell(text, tableForPath(path), +path.split('.')[5]);
    if (shown !== text) return { html: escapeHtml(shown), differs: true };
  }
  if (hasMarkup(text)) return { html: renderRichText(escapeHtml(text)), differs: true };
  return { html: escapeHtml(text), differs: false };
}

function editable(tag, cls, path, text, placeholder) {
  const { html, differs } = displayFor(path, text || '');
  return `<${tag} class="${cls}" data-path="${path}" contenteditable="${EDITABLE}" spellcheck="true"` +
    ` data-placeholder="${escapeHtml(placeholder)}"${differs ? ' data-display="1"' : ''}>${html}</${tag}>`;
}

function numericColumns(t) {
  return t.headers.map((_, c) => {
    const vals = t.rows.map(r => r[c]).filter(v => String(v).trim() !== '');
    return vals.length > 0 && vals.every(v => isFormula(v) || !Number.isNaN(parseNumber(v)));
  });
}

function tableHtml(t, i) {
  const numCol = numericColumns(t);
  let h = '<div class="p-table-wrap"><table class="p-table"><thead><tr>';
  t.headers.forEach((hd, c) => { h += `<th class="${numCol[c] ? 'num' : ''}">${editable('div', 'cell', `s.${i}.t.h.${c}`, hd, 'Header')}</th>`; });
  h += '</tr></thead><tbody>';
  t.rows.forEach((row, r) => {
    h += '<tr>';
    row.forEach((v, c) => {
      const cls = `${isFormula(v) ? 'formula ' : ''}${numCol[c] ? 'num' : ''}`;
      h += `<td class="${cls.trim()}">${editable('div', 'cell', `s.${i}.t.r.${r}.${c}`, v, '')}</td>`;
    });
    h += '</tr>';
  });
  h += '</tbody></table></div>';
  h += `<div class="p-table-tools">
    <button class="p-tool" type="button" data-act="row-add" data-sec="${i}">+ Row</button>
    <button class="p-tool" type="button" data-act="col-add" data-sec="${i}">+ Column</button>
    <button class="p-tool" type="button" data-act="row-del" data-sec="${i}">− Row</button>
    <button class="p-tool" type="button" data-act="col-del" data-sec="${i}">− Column</button>
  </div>`;
  return h;
}

function sectionHtml(sec, i) {
  let h = `<section class="p-section" data-sec="${i}">`;
  h += `<button class="p-sec-menu" type="button" data-act="sec-menu" data-sec="${i}" aria-label="Section options">${icon('more')}</button>`;
  h += editable('h2', 'p-heading', `s.${i}.heading`, sec.heading, 'Section heading');
  sec.paragraphs.forEach((p, j) => { h += editable('p', 'p-para', `s.${i}.p.${j}`, p, 'Write something…'); });
  if (sec.bullets.length) {
    h += '<ul class="p-bullets">' + sec.bullets.map((b, j) => `<li>${editable('span', 'p-bullet', `s.${i}.b.${j}`, b, 'List item')}</li>`).join('') + '</ul>';
  }
  if (sec.table) h += tableHtml(sec.table, i);
  return h + '</section>';
}

function render({ focus } = {}) {
  const s = doc.schema;
  let h = editable('h1', 'p-title', 'title', s.title, 'Document title');
  h += editable('div', 'p-subtitle', 'subtitle', s.subtitle || '', 'Add a subtitle (optional)');
  h += '<div class="p-rule"></div>';
  s.sections.forEach((sec, i) => { h += sectionHtml(sec, i); });
  h += `<button class="p-tool p-add-section" type="button" data-act="add-section">+ Add section</button>`;
  $('paper').innerHTML = h;
  if (focus) focusPath(focus.path, focus.offset);
  // Removing the focused element fires no blur event, so resync here.
  syncEditingMode();
}

// While a text field is focused on a phone, hide the toolbars so the paper
// gets the space left over by the keyboard.
function syncEditingMode() {
  const a = document.activeElement;
  $('studio').classList.toggle('editing', !!(a && a.closest && a.closest('#paper [data-path]')));
}

// ---------- text model access ----------

function getText(path) {
  const p = path.split('.');
  const s = doc.schema;
  if (p[0] === 'title') return s.title;
  if (p[0] === 'subtitle') return s.subtitle || '';
  const sec = s.sections[+p[1]];
  if (!sec) return '';
  if (p[2] === 'heading') return sec.heading;
  if (p[2] === 'p') return sec.paragraphs[+p[3]] ?? '';
  if (p[2] === 'b') return sec.bullets[+p[3]] ?? '';
  if (p[2] === 't') return p[3] === 'h' ? sec.table.headers[+p[4]] : sec.table.rows[+p[4]][+p[5]];
  return '';
}

function setText(path, value) {
  const p = path.split('.');
  const s = doc.schema;
  if (p[0] === 'title') { s.title = value; return; }
  if (p[0] === 'subtitle') { s.subtitle = value; return; }
  const sec = s.sections[+p[1]];
  if (!sec) return;
  if (p[2] === 'heading') sec.heading = value;
  else if (p[2] === 'p') sec.paragraphs[+p[3]] = value;
  else if (p[2] === 'b') sec.bullets[+p[3]] = value;
  else if (p[2] === 't') {
    if (p[3] === 'h') sec.table.headers[+p[4]] = value;
    else sec.table.rows[+p[4]][+p[5]] = value;
  }
}

function readText(el) {
  let t = el.innerText.replace(/ /g, ' ');
  if (t.endsWith('\n')) t = t.slice(0, -1);
  const path = el.dataset.path;
  // Only paragraphs may contain line breaks.
  if (!/\.p\.\d+$/.test(path)) t = t.replace(/\n+/g, ' ');
  return t;
}

// ---------- caret helpers ----------

function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaret(el, offset) {
  const sel = getSelection();
  const range = document.createRange();
  if (offset === 'end' || offset === undefined) {
    range.selectNodeContents(el);
    range.collapse(false);
  } else if (offset === 'all') {
    range.selectNodeContents(el);
  } else {
    let remaining = offset;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let placed = false;
    while (node) {
      if (remaining <= node.length) { range.setStart(node, remaining); placed = true; break; }
      remaining -= node.length;
      node = walker.nextNode();
    }
    if (!placed) { range.selectNodeContents(el); range.collapse(offset !== 0 ? false : true); }
    else range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function focusPath(path, offset = 'end') {
  const el = $('paper').querySelector(`[data-path="${path}"]`);
  if (!el) return;
  el.focus();
  setCaret(el, offset);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- history ----------

function snapshot() {
  return JSON.stringify(doc.schema);
}

function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function updateUndoButtons() {
  $('undoBtn').disabled = undoStack.length === 0;
  $('redoBtn').disabled = redoStack.length === 0;
}

function undo() {
  if (!doc || !undoStack.length) return;
  redoStack.push(snapshot());
  doc.schema = JSON.parse(undoStack.pop());
  burst = null;
  render();
  syncChrome();
  updateUndoButtons();
  markDirty();
}

function redo() {
  if (!doc || !redoStack.length) return;
  undoStack.push(snapshot());
  doc.schema = JSON.parse(redoStack.pop());
  burst = null;
  render();
  syncChrome();
  updateUndoButtons();
  markDirty();
}

// A structural change: one undo step, then re-render and save.
function mutate(fn, focus) {
  burst = null;
  pushHistory();
  fn(doc.schema);
  render({ focus });
  markDirty();
}

// ---------- saving ----------

function cleanForSave(schema) {
  const copy = JSON.parse(JSON.stringify(schema));
  if (!copy.subtitle?.trim()) delete copy.subtitle;
  copy.sections = copy.sections
    .map(s => ({ ...s, paragraphs: s.paragraphs.filter(p => p.trim()), bullets: s.bullets.filter(b => b.trim()) }))
    .filter(s => s.heading.trim() || s.paragraphs.length || s.bullets.length || s.table);
  return copy;
}

const scheduleSave = debounce(() => save().catch(() => {}), 900);

function markDirty() {
  saveState = 'dirty';
  setStatus('Editing…');
  scheduleSave();
}

async function save(target = doc) {
  if (!target) return;
  while (savePromise) await savePromise.catch(() => {});
  if (target === doc && saveState !== 'dirty' && saveState !== 'error') return;
  const payload = { schema: cleanForSave(target.schema), format: target.format };
  if (target === doc) { saveState = 'saving'; setStatus('Saving…'); }
  savePromise = api(`/api/documents/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: payload });
  try {
    const { document: saved } = await savePromise;
    target.title = saved.title;
    upsertDocumentSummary(saved);
    syncCards(saved);
    if (target === doc && saveState === 'saving') {
      saveState = 'saved';
      setStatus('All changes saved');
    }
  } catch (err) {
    if (target === doc && isStudioOpen()) {
      saveState = 'error';
      setStatus(err.code === 'offline' ? 'Offline — not saved yet' : 'Couldn’t save', { error: true, retry: () => save(target).catch(() => {}) });
    } else {
      toast('Your last changes couldn’t be saved.', { type: 'error', action: { label: 'Retry', onClick: () => save(target).catch(() => {}) } });
    }
    throw err;
  } finally {
    savePromise = null;
  }
}

export async function flushSave() {
  scheduleSave.cancel();
  try {
    if (doc && (saveState === 'dirty' || saveState === 'error')) await save(doc);
    else if (savePromise) await savePromise;
    return true;
  } catch {
    return false;
  }
}

// Keep document cards in the chat in sync with renames and format changes.
export function syncCards(d) {
  document.querySelectorAll(`.doc-card[data-doc="${d.id}"]`).forEach(card => {
    card.querySelector('.dc-title').textContent = d.title;
    card.querySelector('.dc-meta').textContent = `${formatLabel(d.format)} · Tap to view and edit`;
    const badge = card.querySelector('.fmt-badge');
    badge.className = `fmt-badge fmt-${d.format}`;
    badge.textContent = { pdf: 'PDF', docx: 'DOC', xlsx: 'XLS' }[d.format];
  });
}

function setFormat(format) {
  doc.format = format;
  syncChrome();
  markDirty();
}

// ---------- editing events ----------

function onInput(e) {
  const el = e.target.closest?.('[data-path]');
  if (!el || !doc) return;
  const path = el.dataset.path;
  const now = Date.now();
  if (!burst || burst.path !== path || now - burst.time > 1500) pushHistory();
  burst = { path, time: now };
  setText(path, readText(el));
  delete el.dataset.display;
  if (path === 'title') $('studioTitle').textContent = doc.schema.title || 'Untitled document';
  if (path.includes('.t.r.')) el.parentElement.classList.toggle('formula', isFormula(getText(path)));
  markDirty();
}

function onFocusIn(e) {
  const el = e.target.closest?.('[data-path]');
  if (!el) return;
  $('studio').classList.add('editing');
  const p = el.dataset.path.split('.');
  if (p[2] === 't' && p[3] === 'r') lastCell = { sec: +p[1], r: +p[4], c: +p[5] };
  else if (p[2] === 't') lastCell = { sec: +p[1], r: -1, c: +p[4] };
  // Swap the rendered view (computed formula, bold text) for the raw source.
  if (el.dataset.display) {
    el.textContent = getText(el.dataset.path);
    delete el.dataset.display;
    setCaret(el, 'end');
  }
}

function onFocusOut(e) {
  const el = e.target.closest?.('[data-path]');
  if (el && el.isConnected && doc) {
    const path = el.dataset.path;
    const { html, differs } = displayFor(path, getText(path));
    if (differs) { el.innerHTML = html; el.dataset.display = '1'; }
    if (path.includes('.t.')) refreshTableDisplays(+path.split('.')[1], el);
  }
  setTimeout(syncEditingMode, 120);
}

// Formulas depend on other cells, so recompute the whole table after an edit.
function refreshTableDisplays(secIndex, except) {
  const section = $('paper').querySelector(`.p-section[data-sec="${secIndex}"]`);
  const table = doc.schema.sections[secIndex]?.table;
  if (!section || !table) return;
  const numCol = numericColumns(table);
  section.querySelectorAll('td .cell').forEach(cell => {
    const p = cell.dataset.path.split('.');
    const raw = table.rows[+p[4]]?.[+p[5]] ?? '';
    const td = cell.parentElement;
    td.classList.toggle('formula', isFormula(raw));
    td.classList.toggle('num', numCol[+p[5]]);
    if (cell === except || cell === document.activeElement) return;
    const shown = displayCell(raw, table, +p[5]);
    if (shown !== raw) { cell.textContent = shown; cell.dataset.display = '1'; }
  });
  section.querySelectorAll('th').forEach((th, c) => th.classList.toggle('num', numCol[c]));
}

function onPaste(e) {
  const el = e.target.closest?.('[data-path]');
  if (!el) return;
  e.preventDefault();
  let text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
  if (!/\.p\.\d+$/.test(el.dataset.path)) text = text.replace(/\s*\n+\s*/g, ' ');
  document.execCommand('insertText', false, text);
}

function onKeyDown(e) {
  shiftHeld = e.shiftKey;
  // Desktop fallback for browsers where beforeinput isn't cancelable.
  if (e.key === 'Enter' && !e.isComposing && !(e.shiftKey && isParagraph(e.target))) {
    const el = e.target.closest?.('[data-path]');
    if (el) { e.preventDefault(); handleEnter(el); }
  }
}

function isParagraph(el) {
  return /\.p\.\d+$/.test(el?.dataset?.path || '');
}

// beforeinput also fires for Android on-screen keyboards, where keydown
// reports "Unidentified" for Enter/Backspace.
function onBeforeInput(e) {
  const el = e.target.closest?.('[data-path]');
  if (!el) return;
  const t = e.inputType;
  if (t === 'historyUndo') { e.preventDefault(); undo(); return; }
  if (t === 'historyRedo') { e.preventDefault(); redo(); return; }
  if (t === 'insertParagraph' || (t === 'insertLineBreak' && !(shiftHeld && isParagraph(el)))) {
    e.preventDefault();
    handleEnter(el);
    return;
  }
  if (t === 'deleteContentBackward') {
    const sel = getSelection();
    if (sel.isCollapsed && caretOffset(el) === 0 && handleBackspaceAtStart(el)) e.preventDefault();
  }
}

let enterGuard = 0;
function handleEnter(el) {
  // keydown and beforeinput can both fire for one press.
  const now = Date.now();
  if (now - enterGuard < 50) return;
  enterGuard = now;

  const path = el.dataset.path;
  const p = path.split('.');
  if (path === 'title') return focusPath('subtitle');
  if (path === 'subtitle') {
    if (doc.schema.sections.length) focusPath('s.0.heading');
    else el.blur();
    return;
  }
  const si = +p[1];
  const sec = doc.schema.sections[si];
  if (p[2] === 'heading') {
    if (sec.paragraphs.length) return focusPath(`s.${si}.p.0`, 0);
    return mutate(() => { sec.paragraphs.push(''); }, { path: `s.${si}.p.0`, offset: 0 });
  }
  if (p[2] === 'p' || p[2] === 'b') {
    const j = +p[3];
    const list = p[2] === 'p' ? sec.paragraphs : sec.bullets;
    const text = readText(el);
    if (p[2] === 'b' && !text.trim()) {
      // Enter on an empty bullet ends the list.
      return mutate(() => { list.splice(j, 1); sec.paragraphs.push(''); }, { path: `s.${si}.p.${sec.paragraphs.length}`, offset: 0 });
    }
    const off = caretOffset(el) ?? text.length;
    return mutate(() => {
      list[j] = text.slice(0, off);
      list.splice(j + 1, 0, text.slice(off));
    }, { path: `s.${si}.${p[2]}.${j + 1}`, offset: 0 });
  }
  if (p[2] === 't') {
    const t = sec.table;
    const c = p[3] === 'h' ? +p[4] : +p[5];
    const nextRow = p[3] === 'h' ? 0 : +p[4] + 1;
    if (nextRow < t.rows.length) return focusPath(`s.${si}.t.r.${nextRow}.${c}`, 'end');
    return mutate(() => { t.rows.push(t.headers.map(() => '')); }, { path: `s.${si}.t.r.${nextRow}.${c}`, offset: 0 });
  }
}

function handleBackspaceAtStart(el) {
  const p = el.dataset.path.split('.');
  if (p[2] !== 'p' && p[2] !== 'b') return false;
  const si = +p[1];
  const j = +p[3];
  const sec = doc.schema.sections[si];
  const list = p[2] === 'p' ? sec.paragraphs : sec.bullets;
  const text = readText(el);
  if (j > 0) {
    const prevLen = list[j - 1].length;
    mutate(() => { list[j - 1] += text; list.splice(j, 1); }, { path: `s.${si}.${p[2]}.${j - 1}`, offset: prevLen });
    return true;
  }
  if (!text) {
    const focus = p[2] === 'b' && sec.paragraphs.length
      ? { path: `s.${si}.p.${sec.paragraphs.length - 1}`, offset: 'end' }
      : { path: `s.${si}.heading`, offset: 'end' };
    mutate(() => { list.splice(j, 1); }, focus);
    return true;
  }
  return false;
}

// ---------- section & table tools ----------

function onPaperClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !doc) return;
  const act = btn.dataset.act;
  const si = Number(btn.dataset.sec);
  if (act === 'add-section') {
    const i = doc.schema.sections.length;
    mutate(s => { s.sections.push({ heading: '', paragraphs: [''], bullets: [] }); }, { path: `s.${i}.heading`, offset: 0 });
  } else if (act === 'sec-menu') {
    sectionMenu(si);
  } else if (act.startsWith('row-') || act.startsWith('col-')) {
    tableTool(act, si);
  }
}

function sectionMenu(i) {
  const s = doc.schema.sections;
  const sec = s[i];
  showMenu([
    { icon: 'text', label: 'Add paragraph', onClick: () => mutate(() => { sec.paragraphs.push(''); }, { path: `s.${i}.p.${sec.paragraphs.length}`, offset: 0 }) },
    { icon: 'list', label: sec.bullets.length ? 'Add bullet point' : 'Add bullet list', onClick: () => mutate(() => { sec.bullets.push(''); }, { path: `s.${i}.b.${sec.bullets.length}`, offset: 0 }) },
    sec.table
      ? { icon: 'table', label: 'Remove table', danger: true, onClick: () => mutate(() => { delete sec.table; }) }
      : { icon: 'table', label: 'Add table', onClick: () => mutate(() => { sec.table = { headers: ['Item', 'Details', 'Amount'], rows: [['', '', ''], ['', '', '']] }; }, { path: `s.${i}.t.h.0`, offset: 'all' }) },
    { icon: 'plus', label: 'Add section below', onClick: () => mutate(() => { s.splice(i + 1, 0, { heading: '', paragraphs: [''], bullets: [] }); }, { path: `s.${i + 1}.heading`, offset: 0 }) },
    i > 0 && { icon: 'up', label: 'Move up', onClick: () => mutate(() => { [s[i - 1], s[i]] = [s[i], s[i - 1]]; }) },
    i < s.length - 1 && { icon: 'down', label: 'Move down', onClick: () => mutate(() => { [s[i + 1], s[i]] = [s[i], s[i + 1]]; }) },
    { icon: 'trash', label: 'Delete section', danger: true, onClick: () => {
      mutate(() => { s.splice(i, 1); });
      toast('Section deleted', { action: { label: 'Undo', onClick: undo } });
    } }
  ], { title: sec.heading || `Section ${i + 1}` });
}

function tableTool(act, si) {
  const t = doc.schema.sections[si]?.table;
  if (!t) return;
  const cell = lastCell && lastCell.sec === si ? lastCell : null;
  if (act === 'row-add') {
    const at = cell && cell.r >= 0 ? cell.r + 1 : t.rows.length;
    mutate(() => { t.rows.splice(at, 0, t.headers.map(() => '')); }, { path: `s.${si}.t.r.${at}.0`, offset: 0 });
    lastCell = { sec: si, r: at, c: 0 };
  } else if (act === 'col-add') {
    if (t.headers.length >= 20) return toast('Tables can have up to 20 columns.', { type: 'error' });
    const at = cell ? cell.c + 1 : t.headers.length;
    mutate(() => {
      t.headers.splice(at, 0, `Column ${t.headers.length + 1}`);
      t.rows.forEach(r => r.splice(at, 0, ''));
    }, { path: `s.${si}.t.h.${at}`, offset: 'all' });
    lastCell = { sec: si, r: -1, c: at };
  } else if (act === 'row-del') {
    if (!t.rows.length) return;
    const at = cell && cell.r >= 0 && cell.r < t.rows.length ? cell.r : t.rows.length - 1;
    mutate(() => { t.rows.splice(at, 1); });
    lastCell = null;
    toast(`Row ${at + 1} deleted`, { action: { label: 'Undo', onClick: undo } });
  } else if (act === 'col-del') {
    if (t.headers.length <= 1) return toast('A table needs at least one column. Use the section menu (⋮) to remove the whole table.', { type: 'error' });
    const at = cell && cell.c < t.headers.length ? cell.c : t.headers.length - 1;
    const name = t.headers[at] || `Column ${at + 1}`;
    mutate(() => { t.headers.splice(at, 1); t.rows.forEach(r => r.splice(at, 1)); });
    lastCell = null;
    toast(`“${name}” column deleted`, { action: { label: 'Undo', onClick: undo } });
  }
}

// ---------- export ----------

async function buildCurrent() {
  return buildDocument(cleanForSave(doc.schema), doc.format);
}

async function download() {
  if (!doc) return;
  const btn = $('studioDownload');
  setLoading(btn, true);
  try {
    const file = await buildCurrent();
    const how = await saveFile(file.blob, file.filename, file.mime);
    if (how === 'downloaded') toast(`Downloaded ${file.filename}`, { type: 'success' });
  } catch (err) {
    toast(err.message || 'Couldn’t create the file.', { type: 'error' });
  } finally {
    setLoading(btn, false);
  }
}

async function openExternally() {
  if (!doc) return;
  const btn = $('studioOpen');
  setLoading(btn, true);
  try {
    const file = await buildCurrent();
    await openFile(file.blob, file.filename, file.mime);
  } catch (err) {
    toast(err.message || 'Couldn’t open the file.', { type: 'error' });
  } finally {
    setLoading(btn, false);
  }
}

function moreMenu() {
  if (!doc) return;
  const target = doc;
  showMenu([
    { icon: 'pencil', label: 'Rename', onClick: () => focusPath('title', 'all') },
    { icon: 'copy', label: 'Copy text', onClick: async () => {
      try {
        await navigator.clipboard.writeText(DocSchema.toPlainText(cleanForSave(target.schema)));
        toast('Document text copied', { type: 'success' });
      } catch { toast('Couldn’t copy on this device.', { type: 'error' }); }
    } },
    { icon: 'file', label: 'Duplicate', onClick: async () => {
      await flushSave();
      try {
        const { document: copy } = await api(`/api/documents/${encodeURIComponent(target.id)}/duplicate`, { method: 'POST' });
        upsertDocumentSummary(copy);
        toast('Copy created', { type: 'success' });
        openStudio(copy.id);
      } catch (err) { toast(err.message, { type: 'error' }); }
    } },
    target.conversationId && { icon: 'chat', label: 'Go to chat', onClick: () => { closeStudio(); hooks.openConversation(target.conversationId); } },
    { icon: 'flag', label: 'Report AI content', onClick: () => reportContent({ documentId: target.id }) },
    { icon: 'trash', label: 'Delete document', danger: true, onClick: async () => {
      const ok = await confirmDialog({ title: 'Delete this document?', message: `“${target.schema.title}” will be permanently deleted.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        scheduleSave.cancel();
        saveState = 'saved';
        await api(`/api/documents/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
        state.documents = state.documents.filter(x => x.id !== target.id);
        emit('documents-changed');
        closeStudio();
        toast('Document deleted');
      } catch (err) { toast(err.message, { type: 'error' }); }
    } }
  ], { title: target.schema.title });
}

// ---------- AI edit ----------

async function aiEdit(text) {
  if (aiBusy || !doc) return;
  if (document.activeElement && $('paper').contains(document.activeElement)) document.activeElement.blur();
  // The server edits the saved copy, so make sure it has the latest edits.
  if (!(await flushSave())) {
    toast('Your latest edits aren’t saved yet. Check your connection and try again.', { type: 'error' });
    return;
  }
  const target = doc;
  aiBusy = true;
  $('aiEditForm').classList.add('busy');
  $('aiEditInput').blur();
  setStatus('AI is editing…');
  let result = null;
  let failure = null;
  try {
    await streamGenerate(
      { text, format: target.format, documentId: target.id, conversationId: target.conversationId || undefined },
      {
        onEvent: (event, data) => {
          if (event === 'meta' && data.conversationId && !target.conversationId) target.conversationId = data.conversationId;
          else if (event === 'status' && target === doc) setStatus(data.text);
          else if (event === 'result') result = data;
          else if (event === 'error') failure = data.message;
        }
      }
    );
  } catch (err) {
    failure = err.code === 'quota_exceeded' ? hooks.quotaMessage(err) : err.message;
    if (err.code === 'quota_exceeded') emit('usage-refresh');
  } finally {
    aiBusy = false;
    $('aiEditForm').classList.remove('busy');
  }

  if (failure || !result) {
    if (target === doc) setStatus(saveState === 'saved' ? 'All changes saved' : '');
    toast(failure || 'The AI didn’t return a result. Please try again.', { type: 'error', duration: 6000 });
    return;
  }

  $('aiEditInput').value = '';
  hooks.onAiExchange(target.conversationId, text, result);
  if (result.action === 'generate' && result.document) {
    if (result.usage) emit('usage-changed', result.usage);
    upsertDocumentSummary(result.document);
    syncCards(result.document);
    if (result.document.id === target.id) {
      if (target === doc) {
        burst = null;
        pushHistory();
      }
      target.schema = DocSchema.normalize(result.document.schema);
      target.format = result.document.format;
      target.title = result.document.title;
      if (target === doc && isStudioOpen()) {
        saveState = 'saved';
        render();
        syncChrome();
        setStatus('Updated by AI · Undo to revert');
      }
    }
    toast(result.message || 'Done', { type: 'success', duration: 4000, action: target === doc ? { label: 'Undo', onClick: undo } : undefined });
  } else {
    if (target === doc) setStatus('All changes saved');
    // The AI answered instead of editing (e.g. asked a clarifying question).
    const body = document.createElement('div');
    body.className = 'bubble-text';
    body.innerHTML = formatMessage(result.message || '');
    openSheet({ title: 'AI reply', body });
  }
}
