// Shared test setup. Requires a real (throwaway) Postgres reachable via
// DATABASE_URL with schema.sql already applied — see README > Testing.
// Deliberately not mocking the database: the whole point is to catch the
// same class of bug the manual smoke-testing during development did.
const crypto = require('crypto');

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set to run the test suite (see README > Testing).`);
  }
}
requireEnv('DATABASE_URL');
requireEnv('JWT_SECRET');
if (!process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = 'sk-or-test-placeholder';
if (!process.env.ALLOWED_MODELS) process.env.ALLOWED_MODELS = 'google/gemini-3.7-flash';

const app = require('../server');
const pool = require('../db-pool');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function request(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
}

// Every test run gets its own throwaway users so parallel test files never
// collide on a UNIQUE(email) constraint.
function uniqueEmail(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}@example.com`;
}

async function registerUser(base, overrides = {}) {
  const email = overrides.email || uniqueEmail('test');
  const { status, body } = await request(base, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test User', email, password: 'password123', ...overrides })
  });
  if (status !== 201) throw new Error(`registerUser failed: ${JSON.stringify(body)}`);
  return { token: body.token, user: body.user, email };
}

module.exports = { startServer, request, uniqueEmail, registerUser, pool };
