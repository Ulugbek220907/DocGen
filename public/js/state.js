// App-wide state plus a tiny event bus so modules stay decoupled.
function read(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
export function persist(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export const state = {
  config: { googleClientId: null, vision: true, plans: null },
  user: null,
  billing: null,
  conversations: [],
  documents: [],
  documentsLoaded: false,
  currentConversationId: null,
  format: read('format', 'pdf'),
  theme: read('theme', 'system'),
  generating: false
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  listeners.get(event)?.forEach(fn => {
    try { fn(payload); } catch (err) { console.error(`[${event}]`, err); }
  });
}

// Keep the library list in sync when any module creates/edits a document.
export function upsertDocumentSummary(doc) {
  const summary = { id: doc.id, title: doc.title, format: doc.format, conversationId: doc.conversationId, updatedAt: doc.updatedAt || new Date().toISOString() };
  const i = state.documents.findIndex(d => d.id === doc.id);
  if (i !== -1) state.documents.splice(i, 1);
  state.documents.unshift(summary);
  emit('documents-changed');
}
