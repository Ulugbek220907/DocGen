const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, uniqueEmail, registerUser } = require('./helpers');

test('auth: register, login, /me, and validation', async (t) => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  t.after(() => server.close());

  await t.test('rejects a short password', async () => {
    const { status, body } = await request(base, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'A', email: uniqueEmail('short'), password: '123' })
    });
    assert.equal(status, 400);
    assert.match(body.error, /at least 8 characters/);
  });

  await t.test('rejects an invalid email', async () => {
    const { status, body } = await request(base, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'A', email: 'not-an-email', password: 'password123' })
    });
    assert.equal(status, 400);
    assert.match(body.error, /valid email/);
  });

  await t.test('registers a new account and returns a usable token', async () => {
    const { token, user } = await registerUser(base);
    assert.ok(token);
    assert.equal(user.plan, undefined); // publicUser() intentionally doesn't leak billing fields

    const me = await request(base, '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, user.email);
  });

  await t.test('rejects a duplicate email', async () => {
    const email = uniqueEmail('dupe');
    await registerUser(base, { email });
    const { status, body } = await request(base, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Again', email, password: 'password123' })
    });
    assert.equal(status, 409);
    assert.match(body.error, /already exists/);
  });

  await t.test('logs in with correct credentials, rejects wrong password', async () => {
    const email = uniqueEmail('login');
    await registerUser(base, { email, password: 'correct-password' });

    const good = await request(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-password' })
    });
    assert.equal(good.status, 200);
    assert.ok(good.body.token);

    const bad = await request(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrong-password' })
    });
    assert.equal(bad.status, 401);
  });

  await t.test('/me without a token is rejected', async () => {
    const { status } = await request(base, '/api/auth/me');
    assert.equal(status, 401);
  });
});

test('auth: password reset', async (t) => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  t.after(() => server.close());
  const { pool } = require('./helpers');

  await t.test('forgot-password gives the same response for real and fake emails', async () => {
    const email = uniqueEmail('reset');
    await registerUser(base, { email });

    const real = await request(base, '/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    const fake = await request(base, '/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('nobody') })
    });
    assert.equal(real.status, 200);
    assert.equal(fake.status, 200);
    assert.equal(real.body.message, fake.body.message);
  });

  await t.test('reset-password rejects a bogus token', async () => {
    const { status, body } = await request(base, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: 'not-a-real-token', password: 'newpassword123' })
    });
    assert.equal(status, 400);
    assert.match(body.error, /invalid or has expired/);
  });

  await t.test('a valid, unexpired token resets the password and is single-use', async () => {
    const email = uniqueEmail('reset2');
    const { user } = await registerUser(base, { email, password: 'old-password' });

    const rawToken = 'test-token-' + user.id;
    const tokenHash = require('crypto').createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      'UPDATE users SET reset_token_hash = $1, reset_token_expires_at = now() + interval \'1 hour\' WHERE id = $2',
      [tokenHash, user.id]
    );

    const reset = await request(base, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, password: 'new-password-456' })
    });
    assert.equal(reset.status, 200);

    const loginOld = await request(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'old-password' })
    });
    assert.equal(loginOld.status, 401);

    const loginNew = await request(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'new-password-456' })
    });
    assert.equal(loginNew.status, 200);

    // Token is consumed — using it again must fail even though it was valid a moment ago.
    const reused = await request(base, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, password: 'yet-another-789' })
    });
    assert.equal(reused.status, 400);
  });

  await t.test('an expired token is rejected', async () => {
    const email = uniqueEmail('expired');
    const { user } = await registerUser(base, { email });

    const rawToken = 'expired-token-' + user.id;
    const tokenHash = require('crypto').createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      "UPDATE users SET reset_token_hash = $1, reset_token_expires_at = now() - interval '1 hour' WHERE id = $2",
      [tokenHash, user.id]
    );

    const { status } = await request(base, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, password: 'irrelevant123' })
    });
    assert.equal(status, 400);
  });
});
