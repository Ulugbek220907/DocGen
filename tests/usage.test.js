const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, uniqueEmail, registerUser, pool } = require('./helpers');
const { checkAndConsumeQuota, getUsageStatus } = require('../usage');
const { getPlan } = require('../plans');

test('usage: free plan quota is enforced and resets monthly', async (t) => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  t.after(() => server.close());

  const { user } = await registerUser(base, { email: uniqueEmail('quota') });
  const limit = getPlan('free').monthlyDocs;

  await t.test('consumes quota up to the free limit, then blocks', async () => {
    for (let i = 0; i < limit; i++) {
      const result = await checkAndConsumeQuota(user.id);
      assert.equal(result.allowed, true, `call ${i + 1} of ${limit} should be allowed`);
    }
    const overLimit = await checkAndConsumeQuota(user.id);
    assert.equal(overLimit.allowed, false);
    assert.equal(overLimit.remaining, 0);
  });

  await t.test('getUsageStatus reflects the same state without consuming', async () => {
    const status = await getUsageStatus(user.id);
    assert.equal(status.usageCount, limit);
    assert.equal(status.remaining, 0);
    const again = await getUsageStatus(user.id);
    assert.equal(again.usageCount, limit); // read-only — didn't consume further
  });

  await t.test('a rolling month rollover resets the counter', async () => {
    await pool.query(
      "UPDATE users SET usage_reset_at = now() - interval '31 days' WHERE id = $1",
      [user.id]
    );
    const result = await checkAndConsumeQuota(user.id);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, limit - 1);
  });
});

test('usage: pro plan is unlimited and an expired plan reverts to free rules', async (t) => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  t.after(() => server.close());

  const { user } = await registerUser(base, { email: uniqueEmail('pro') });

  await t.test('an active pro plan never blocks', async () => {
    await pool.query(
      "UPDATE users SET plan = 'pro', plan_expires_at = now() + interval '30 days' WHERE id = $1",
      [user.id]
    );
    const limit = getPlan('free').monthlyDocs;
    for (let i = 0; i < limit + 5; i++) {
      const result = await checkAndConsumeQuota(user.id);
      assert.equal(result.allowed, true);
      assert.equal(result.plan, 'pro');
    }
  });

  await t.test('an expired pro plan is treated as free (webhook missed the renewal)', async () => {
    await pool.query(
      "UPDATE users SET plan = 'pro', plan_expires_at = now() - interval '1 day', monthly_usage_count = 0, usage_reset_at = now() WHERE id = $1",
      [user.id]
    );
    const limit = getPlan('free').monthlyDocs;
    for (let i = 0; i < limit; i++) {
      const result = await checkAndConsumeQuota(user.id);
      assert.equal(result.plan, 'free');
    }
    const overLimit = await checkAndConsumeQuota(user.id);
    assert.equal(overLimit.allowed, false);
  });
});

test('ai proxy: 402s with upgradeRequired once quota is exhausted', async (t) => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  t.after(() => server.close());

  const { token, user } = await registerUser(base, { email: uniqueEmail('proxy') });
  const limit = getPlan('free').monthlyDocs;
  await pool.query('UPDATE users SET monthly_usage_count = $1 WHERE id = $2', [limit, user.id]);

  const { status, body } = await request(base, '/api/generate/stream', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Request-Id': require('crypto').randomUUID() },
    body: JSON.stringify({ model: 'google/gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }], stream: false })
  });
  assert.equal(status, 402);
  assert.equal(body.error.upgradeRequired, true);
});

test('ai proxy: the same X-Request-Id is only charged once', async (t) => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  t.after(() => server.close());

  const { token, user } = await registerUser(base, { email: uniqueEmail('dedupe') });
  const requestId = require('crypto').randomUUID();
  const body = JSON.stringify({ model: 'google/gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }], stream: false });
  const headers = { Authorization: `Bearer ${token}`, 'X-Request-Id': requestId };

  // Both calls will fail upstream (no real OpenRouter key in tests) — what
  // matters is quota is only consumed once for the shared request id.
  await request(base, '/api/generate/stream', { method: 'POST', headers, body });
  await request(base, '/api/generate/stream', { method: 'POST', headers, body });

  const status = await getUsageStatus(user.id);
  assert.equal(status.usageCount, 1);
});
