// Every call to the backend goes through here: auth header, timeouts,
// cold-start handling and human-readable errors.
import { API_BASE } from './config.js';

const TOKEN_KEY = 'auth_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', field = null, data = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

const OFFLINE_MSG = 'You’re offline. Check your internet connection and try again.';
const UNREACHABLE_MSG = 'Can’t reach DocGen right now. Check your connection and try again.';

function networkError(err) {
  if (err?.name === 'AbortError') return new ApiError('The request took too long. Please try again.', { code: 'timeout' });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return new ApiError(OFFLINE_MSG, { code: 'offline' });
  return new ApiError(UNREACHABLE_MSG, { code: 'network' });
}

export async function api(path, { method = 'GET', body, timeout = 30000, signal, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  signal?.addEventListener('abort', () => controller.abort());

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok) {
    const message = data?.error || (res.status >= 500 ? 'The server had a problem. Please try again in a moment.' : `Request failed (${res.status}).`);
    const err = new ApiError(message, { status: res.status, code: data?.code || 'http_' + res.status, field: data?.field || null, data });
    if (res.status === 401 && auth && token && ['session_expired', 'unauthorized', 'account_deleted'].includes(err.code)) {
      onUnauthorized(err);
    }
    throw err;
  }
  return data;
}

// Render's free tier sleeps after 15 idle minutes and takes up to a minute
// to wake. Polls the health endpoint, reporting progress, until it answers.
export async function waitForServer(onProgress, { maxWaitMs = 90000 } = {}) {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await api('/api/health', { timeout: 20000, auth: false });
      return true;
    } catch (err) {
      const elapsed = Date.now() - start;
      if (err.code === 'offline') onProgress?.({ offline: true, elapsed });
      else onProgress?.({ waking: true, elapsed, attempt });
      if (elapsed > maxWaitMs) throw err;
      await new Promise(r => setTimeout(r, Math.min(1000 * attempt, 4000)));
    }
  }
}

// POST /api/generate and parse its server-sent events.
// onEvent(name, data) fires for meta/status/result/error.
export async function streamGenerate(body, { onEvent, signal }) {
  const token = getToken();
  let res;
  try {
    res = await fetch(API_BASE + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (signal?.aborted) throw new ApiError('Stopped.', { code: 'aborted' });
    throw networkError(err);
  }

  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    const err = new ApiError(data?.error || 'Generation failed. Please try again.', { status: res.status, code: data?.code || 'http_' + res.status, data });
    if (res.status === 401) onUnauthorized(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotResult = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        let dataStr = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }
        if (event === 'result' || event === 'error') gotResult = true;
        onEvent(event, data);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw new ApiError('Stopped.', { code: 'aborted' });
    throw new ApiError('The connection dropped before the answer finished. Please try again.', { code: 'network' });
  }
  if (!gotResult) throw new ApiError('The connection dropped before the answer finished. Please try again.', { code: 'network' });
}
