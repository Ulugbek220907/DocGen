const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { startServer, baseUrl, request, uniqueEmail, registerUser, pool, queueAi, resetAi, generate, sampleDoc } = require('./helpers');

let server;
let base;

before(async () => {
  server = await startServer();
  base = baseUrl(server);
});
after(async () => {
  server.close();
  await pool.end();
});

test('register validates each field and reports which one is wrong', async () => {
  let r = await request(base, '/api/auth/register', { method: 'POST', body: { email: uniqueEmail(), password: 'password123' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'name');

  r = await request(base, '/api/auth/register', { method: 'POST', body: { name: 'A', email: 'not-an-email', password: 'password123' } });
  assert.equal(r.body.field, 'email');

  r = await request(base, '/api/auth/register', { method: 'POST', body: { name: 'A', email: uniqueEmail(), password: 'short' } });
  assert.equal(r.body.field, 'password');
  assert.equal(r.body.code, 'weak_password');
});

test('register then login; duplicate email is rejected with a helpful message', async () => {
  const email = uniqueEmail();
  const { user } = await registerUser(base, { email: email.toUpperCase() });
  assert.equal(user.email, email, 'email is normalised to lowercase');
  assert.equal(user.hasPassword, true);

  const dup = await request(base, '/api/auth/register', { method: 'POST', body: { name: 'B', email, password: 'password123' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'email_taken');

  const ok = await request(base, '/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  const bad = await request(base, '/api/auth/login', { method: 'POST', body: { email, password: 'wrongpass1' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'invalid_credentials');

  const unknown = await request(base, '/api/auth/login', { method: 'POST', body: { email: uniqueEmail(), password: 'wrongpass1' } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, bad.body.error, 'no user enumeration');
});

test('GET /me validates the token and refreshes it once it is a day old', async () => {
  const { token, user } = await registerUser(base);
  const fresh = await request(base, '/api/auth/me', { token });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.user.id, user.id);
  assert.equal(fresh.body.token, undefined, 'no refresh for a fresh token');

  const old = jwt.sign({ userId: user.id, iat: Math.floor(Date.now() / 1000) - 2 * 86400 }, process.env.JWT_SECRET, { expiresIn: '60d' });
  const refreshed = await request(base, '/api/auth/me', { token: old });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.token, 'old token gets a fresh one');

  const expired = jwt.sign({ userId: user.id, iat: Math.floor(Date.now() / 1000) - 100 }, process.env.JWT_SECRET, { expiresIn: 1 });
  await new Promise(r => setTimeout(r, 1100));
  const exp = await request(base, '/api/auth/me', { token: expired });
  assert.equal(exp.status, 401);
  assert.equal(exp.body.code, 'session_expired');

  const garbage = await request(base, '/api/auth/me', { token: 'not-a-jwt' });
  assert.equal(garbage.status, 401);
});

test('PATCH /me renames the user', async () => {
  const { token } = await registerUser(base);
  const r = await request(base, '/api/auth/me', { method: 'PATCH', token, body: { name: '  Aziz  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, 'Aziz');
  const empty = await request(base, '/api/auth/me', { method: 'PATCH', token, body: { name: '  ' } });
  assert.equal(empty.status, 400);
});

test('Google sign-in creates an account, then signs the same account in', async () => {
  const email = uniqueEmail('g');
  const sub = crypto.randomUUID();
  const first = await request(base, '/api/auth/google', { method: 'POST', body: { idToken: `google:${sub}:${email}:true` } });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.equal(first.body.user.googleLinked, true);
  assert.equal(first.body.user.hasPassword, false);

  const second = await request(base, '/api/auth/google', { method: 'POST', body: { idToken: `google:${sub}:${email}:true` } });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.user.id, first.body.user.id);

  // Password login on a Google-only account explains what to do instead.
  const pw = await request(base, '/api/auth/login', { method: 'POST', body: { email, password: 'whatever12' } });
  assert.equal(pw.body.code, 'use_google');

  // And registering with that email says it's a Google account.
  const reg = await request(base, '/api/auth/register', { method: 'POST', body: { name: 'X', email, password: 'password123' } });
  assert.equal(reg.status, 409);
  assert.match(reg.body.error, /Google/);
});

test('Google sign-in links to an existing email account only when Google verified the email', async () => {
  const { user, email } = await registerUser(base);

  const unverified = await request(base, '/api/auth/google', { method: 'POST', body: { idToken: `google:${crypto.randomUUID()}:${email}:false` } });
  assert.equal(unverified.status, 409, 'unverified Google email must not take over the account');

  const verified = await request(base, '/api/auth/google', { method: 'POST', body: { idToken: `google:${crypto.randomUUID()}:${email}:true` } });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.id, user.id);
  assert.equal(verified.body.user.googleLinked, true);
  assert.equal(verified.body.user.hasPassword, true);
});

test('Google sign-in rejects missing or invalid credentials', async () => {
  const missing = await request(base, '/api/auth/google', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
  const invalid = await request(base, '/api/auth/google', { method: 'POST', body: { idToken: 'forged' } });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.code, 'google_invalid');
});

test('password reset works once, with a token that expires', async () => {
  const { user, email } = await registerUser(base);
  const generic = await request(base, '/api/auth/forgot-password', { method: 'POST', body: { email } });
  assert.equal(generic.status, 200);
  const unknown = await request(base, '/api/auth/forgot-password', { method: 'POST', body: { email: uniqueEmail() } });
  assert.equal(unknown.body.message, generic.body.message, 'same answer for unknown emails');

  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query('UPDATE users SET reset_token_hash = $1, reset_token_expires_at = now() + interval \'1 hour\' WHERE id = $2', [hash, user.id]);

  const weak = await request(base, '/api/auth/reset-password', { method: 'POST', body: { token, password: 'short' } });
  assert.equal(weak.status, 400);
  const ok = await request(base, '/api/auth/reset-password', { method: 'POST', body: { token, password: 'newpassword1' } });
  assert.equal(ok.status, 200);
  const again = await request(base, '/api/auth/reset-password', { method: 'POST', body: { token, password: 'newpassword2' } });
  assert.equal(again.body.code, 'reset_invalid', 'token is single-use');

  const login = await request(base, '/api/auth/login', { method: 'POST', body: { email, password: 'newpassword1' } });
  assert.equal(login.status, 200);
});

test('deleting the account removes all user data but keeps payment records', async () => {
  resetAi();
  const { token, user } = await registerUser(base);
  queueAi(sampleDoc('Doomed'));
  const gen = await generate(base, token, { text: 'make an invoice', format: 'pdf' });
  assert.equal(gen.result.action, 'generate');
  const order = await pool.query("INSERT INTO orders (user_id, provider, plan, amount_uzs, status) VALUES ($1, 'payme', 'pro', 49000, 'paid') RETURNING id", [user.id]);

  const del = await request(base, '/api/auth/account', { method: 'DELETE', token });
  assert.equal(del.status, 200);

  const users = await pool.query('SELECT 1 FROM users WHERE id = $1', [user.id]);
  assert.equal(users.rowCount, 0);
  const docs = await pool.query('SELECT 1 FROM documents WHERE user_id = $1', [user.id]);
  assert.equal(docs.rowCount, 0);
  const convos = await pool.query('SELECT 1 FROM conversations WHERE user_id = $1', [user.id]);
  assert.equal(convos.rowCount, 0);
  const kept = await pool.query('SELECT user_id FROM orders WHERE id = $1', [order.rows[0].id]);
  assert.equal(kept.rowCount, 1, 'order kept for tax records');
  assert.equal(kept.rows[0].user_id, null, 'but unlinked from the deleted user');

  const me = await request(base, '/api/auth/me', { token });
  assert.equal(me.status, 401);
  assert.equal(me.body.code, 'account_deleted');
});

test('login attempts are rate limited per IP', async () => {
  const ip = '203.0.113.77';
  let last;
  for (let i = 0; i < 21; i++) {
    last = await request(base, '/api/auth/login', { method: 'POST', ip, body: { email: 'x@example.com', password: 'wrongpass1' } });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'rate_limited');
  assert.ok(last.headers.get('retry-after'));
});
