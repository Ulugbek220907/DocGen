// Shared test setup. Requires a real (throwaway) Postgres reachable via
// DATABASE_URL — see README > Testing. The database is deliberately not
// mocked; the two external services (the AI model and Google's token
// verification) are stubbed so tests are fast, free and deterministic.
const crypto = require('crypto');

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set to run the test suite (see README > Testing).`);
  }
}
requireEnv('DATABASE_URL');
requireEnv('JWT_SECRET');

// Fixed credentials for the payment webhooks under test. Set before any app
// module reads config.js.
Object.assign(process.env, {
  AI_API_KEY: 'test-key',
  AI_BASE_URL: 'https://ai.invalid',
  AI_MODEL: 'test-model',
  PAYME_MERCHANT_ID: 'test-merchant',
  PAYME_KEY: 'test-payme-key',
  CLICK_SERVICE_ID: '111',
  CLICK_MERCHANT_ID: '222',
  CLICK_SECRET_KEY: 'test-click-secret',
  PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_test_secret',
  GOOGLE_CLIENT_IDS: 'test-web-client.apps.googleusercontent.com',
  PUBLIC_URL: 'https://docgen.example'
});
delete process.env.PADDLE_CLIENT_TOKEN;
delete process.env.PADDLE_PRICE_ID;
delete process.env.PADDLE_API_KEY;

const app = require('../server');
const pool = require('../db-pool');
const ai = require('../ai');
const google = require('../google-verify');

// ---------- AI stub ----------
// Each call to the model takes the next queued response (a JSON object is
// serialised; a string is returned as-is to simulate broken output).
const aiQueue = [];
const aiCalls = [];
ai.streamChat = async ({ messages, onDelta }) => {
  aiCalls.push(messages);
  if (!aiQueue.length) throw new Error('AI stub: no response queued');
  const next = aiQueue.shift();
  if (next instanceof Error) throw next;
  const text = typeof next === 'string' ? next : JSON.stringify(next);
  onDelta?.(text);
  return { text, finishReason: 'stop' };
};
function queueAi(...responses) { aiQueue.push(...responses); }
function resetAi() { aiQueue.length = 0; aiCalls.length = 0; }

// ---------- Google stub ----------
// Tokens look like "google:<sub>:<email>:<verified>".
google.verifyGoogleIdToken = async (idToken) => {
  const [prefix, sub, email, verified] = String(idToken).split(':');
  if (prefix !== 'google') throw new Error('bad token');
  return { sub, email, emailVerified: verified !== 'false', name: 'Google User', picture: 'https://example.com/a.png' };
};

let schemaReady = null;
async function startServer() {
  if (!schemaReady) schemaReady = app.ensureSchema();
  await schemaReady;
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

// A random client IP per request keeps the per-IP login limiter from
// tripping across unrelated tests (the app trusts one proxy hop).
function randomIp() {
  return `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
}

async function request(base, path, { method = 'GET', body, token, headers = {}, ip } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || randomIp(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

// POST /api/generate and collect its server-sent events.
async function generate(base, token, payload) {
  const res = await request(base, '/api/generate', { method: 'POST', token, body: payload });
  if (res.status !== 200) return { status: res.status, body: res.body, events: [] };
  const events = [];
  for (const chunk of res.text.split('\n\n')) {
    let event = 'message';
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) events.push({ event, data: JSON.parse(data) });
  }
  const result = events.find(e => e.event === 'result')?.data || null;
  const error = events.find(e => e.event === 'error')?.data || null;
  return { status: 200, events, result, error };
}

function uniqueEmail(prefix = 'test') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}@example.com`;
}

async function registerUser(base, overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const { status, body } = await request(base, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Test User', email, password: 'password123', ...overrides }
  });
  if (status !== 201) throw new Error(`registerUser failed: ${JSON.stringify(body)}`);
  return { token: body.token, user: body.user, email };
}

const sampleDoc = (title = 'Test Invoice', extra = {}) => ({
  action: 'generate',
  target: 'new',
  format: 'pdf',
  message: `Here is ${title}.`,
  suggestions: ['Add a logo'],
  document: {
    title,
    sections: [
      { heading: 'Details', paragraphs: ['Invoice for services.'], bullets: ['Due in 14 days'] },
      { heading: 'Items', paragraphs: [], bullets: [], table: { headers: ['Item', 'Qty', 'Price', 'Amount'], rows: [['Design', '2', '100', '=B2*C2']] } }
    ]
  },
  ...extra
});

module.exports = {
  app, pool, startServer, baseUrl, request, generate, uniqueEmail, registerUser,
  queueAi, resetAi, aiCalls, sampleDoc, randomIp
};
