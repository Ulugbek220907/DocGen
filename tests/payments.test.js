const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, baseUrl, request, registerUser, pool } = require('./helpers');
const { verifyPaddleSignature } = require('../paddle-webhook');

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

async function userPlan(userId) {
  const { rows } = await pool.query('SELECT plan, plan_expires_at FROM users WHERE id = $1', [userId]);
  return rows[0];
}

// ---------------------------------------------------------------- billing

test('billing status shows usage, pricing and which payment methods are live', async () => {
  const { token } = await registerUser(base);
  const r = await request(base, '/api/billing/status', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan, 'free');
  assert.equal(r.body.limit, 10);
  assert.equal(r.body.remaining, 10);
  assert.deepEqual(r.body.payments, { paddle: false, payme: true, click: true });
  assert.equal(r.body.pricing.uzs, 49000);

  const paddle = await request(base, '/api/billing/checkout/paddle', { method: 'POST', token });
  assert.equal(paddle.status, 503, 'Paddle is off until its keys are set');
});

test('Payme checkout link encodes the order, amount in tiyin and return URL', async () => {
  const { token } = await registerUser(base);
  const r = await request(base, '/api/billing/checkout/payme', { method: 'POST', token, body: { lang: 'ru' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.url.startsWith('https://checkout.paycom.uz/'));
  const params = Buffer.from(r.body.url.slice('https://checkout.paycom.uz/'.length), 'base64').toString('utf8');
  assert.equal(params, `m=test-merchant;ac.order_id=${r.body.orderId};a=4900000;l=ru;c=https://docgen.example/?payment=return`);
});

// ---------------------------------------------------------------- Payme

const PAYME_AUTH = 'Basic ' + Buffer.from('Paycom:test-payme-key').toString('base64');
async function payme(method, params, auth = PAYME_AUTH) {
  const r = await request(base, '/webhooks/payme', { method: 'POST', headers: { Authorization: auth }, body: { jsonrpc: '2.0', id: 1, method, params } });
  assert.equal(r.status, 200, 'Payme always gets HTTP 200');
  return r.body;
}

test('Payme: wrong credentials are refused', async () => {
  const bad = await payme('CheckPerformTransaction', {}, 'Basic ' + Buffer.from('Paycom:wrong').toString('base64'));
  assert.equal(bad.error.code, -32504);
  const unknown = await payme('Nope', {});
  assert.equal(unknown.error.code, -32601);
});

test('Payme: full payment flow grants 30 days of Pro, is idempotent, and refunds take it back', async () => {
  const { token, user } = await registerUser(base);
  const { body: { orderId } } = await request(base, '/api/billing/checkout/payme', { method: 'POST', token });
  const amount = 4900000;
  const account = { order_id: String(orderId) };

  assert.equal((await payme('CheckPerformTransaction', { amount: amount - 100, account })).error.code, -31001, 'wrong amount');
  assert.equal((await payme('CheckPerformTransaction', { amount, account: { order_id: '999999999' } })).error.code, -31050, 'unknown order');
  assert.deepEqual((await payme('CheckPerformTransaction', { amount, account })).result, { allow: true });

  const txId = crypto.randomBytes(12).toString('hex');
  const created = await payme('CreateTransaction', { id: txId, time: Date.now(), amount, account });
  assert.equal(created.result.state, 1);
  const again = await payme('CreateTransaction', { id: txId, time: Date.now(), amount, account });
  assert.equal(again.result.create_time, created.result.create_time, 'same transaction returned on retry');

  const second = await payme('CreateTransaction', { id: crypto.randomBytes(12).toString('hex'), time: Date.now(), amount, account });
  assert.equal(second.error.code, -31050, 'only one active transaction per order');

  const performed = await payme('PerformTransaction', { id: txId });
  assert.equal(performed.result.state, 2);
  const performedAgain = await payme('PerformTransaction', { id: txId });
  assert.equal(performedAgain.result.perform_time, performed.result.perform_time, 'perform is idempotent');

  let plan = await userPlan(user.id);
  assert.equal(plan.plan, 'pro');
  const days = (new Date(plan.plan_expires_at) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days < 30.1, `about 30 days, got ${days}`);

  const check = await payme('CheckTransaction', { id: txId });
  assert.equal(check.result.state, 2);
  const statement = await payme('GetStatement', { from: Date.now() - 60000, to: Date.now() + 60000 });
  assert.ok(statement.result.transactions.some(t => t.id === txId && t.account.order_id === String(orderId)));

  const cancel = await payme('CancelTransaction', { id: txId, reason: 5 });
  assert.equal(cancel.result.state, -2);
  plan = await userPlan(user.id);
  assert.equal(plan.plan, 'free', 'refund removes the Pro time');

  assert.equal((await payme('PerformTransaction', { id: 'missing' })).error.code, -31003);
});

test('Payme: a created transaction can be cancelled before payment', async () => {
  const { token, user } = await registerUser(base);
  const { body: { orderId } } = await request(base, '/api/billing/checkout/payme', { method: 'POST', token });
  const txId = crypto.randomBytes(12).toString('hex');
  await payme('CreateTransaction', { id: txId, time: Date.now(), amount: 4900000, account: { order_id: String(orderId) } });
  const cancel = await payme('CancelTransaction', { id: txId, reason: 3 });
  assert.equal(cancel.result.state, -1);
  assert.equal((await payme('PerformTransaction', { id: txId })).error.code, -31008);
  assert.equal((await userPlan(user.id)).plan, 'free');
});

// ---------------------------------------------------------------- Click

function clickSign(b, withPrepare) {
  const parts = [b.click_trans_id, b.service_id, 'test-click-secret', b.merchant_trans_id];
  if (withPrepare) parts.push(b.merchant_prepare_id);
  parts.push(b.amount, b.action, b.sign_time);
  return crypto.createHash('md5').update(parts.join('')).digest('hex');
}

async function click(path, fields, withPrepare) {
  const body = { ...fields, sign_string: fields.sign_string || clickSign(fields, withPrepare) };
  const r = await request(base, `/webhooks/click/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  return r.body;
}

test('Click: prepare + complete grants Pro; bad signatures and amounts are refused', async () => {
  const { token, user } = await registerUser(base);
  const { body: { orderId } } = await request(base, '/api/billing/checkout/click', { method: 'POST', token });
  const clickTransId = String(crypto.randomInt(1e9));
  const common = { click_trans_id: clickTransId, service_id: '111', click_paydoc_id: '1', merchant_trans_id: String(orderId), sign_time: '2026-09-23 12:00:00', error: '0', error_note: 'Success' };

  const forged = await click('prepare', { ...common, amount: '49000.00', action: '0', sign_string: 'deadbeef' }, false);
  assert.equal(forged.error, -1);
  const cheap = await click('prepare', { ...common, amount: '1000.00', action: '0' }, false);
  assert.equal(cheap.error, -2);

  const prepared = await click('prepare', { ...common, amount: '49000.00', action: '0' }, false);
  assert.equal(prepared.error, 0);
  assert.equal(prepared.merchant_prepare_id, orderId);

  const done = await click('complete', { ...common, amount: '49000.00', action: '1', merchant_prepare_id: String(orderId) }, true);
  assert.equal(done.error, 0);
  assert.equal((await userPlan(user.id)).plan, 'pro');

  const twice = await click('complete', { ...common, amount: '49000.00', action: '1', merchant_prepare_id: String(orderId) }, true);
  assert.equal(twice.error, -4, 'already paid');
});

test('Click: a failed payment reported in complete cancels the order', async () => {
  const { token, user } = await registerUser(base);
  const { body: { orderId } } = await request(base, '/api/billing/checkout/click', { method: 'POST', token });
  const common = { click_trans_id: String(crypto.randomInt(1e9)), service_id: '111', merchant_trans_id: String(orderId), sign_time: '2026-09-23 12:00:00', amount: '49000.00' };
  await click('prepare', { ...common, action: '0', error: '0' }, false);
  const failed = await click('complete', { ...common, action: '1', error: '-5017', merchant_prepare_id: String(orderId) }, true);
  assert.equal(failed.error, -9);
  assert.equal((await userPlan(user.id)).plan, 'free');
});

// ---------------------------------------------------------------- Paddle

function paddleHeader(raw, secret = 'pdl_ntfset_test_secret', ts = Math.floor(Date.now() / 1000)) {
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

test('Paddle signature verification: valid, rotated, tampered, stale', () => {
  const raw = '{"a":1}';
  const secret = 'pdl_ntfset_test_secret';
  assert.equal(verifyPaddleSignature(Buffer.from(raw), paddleHeader(raw), secret), true);
  const rotated = `${paddleHeader(raw)};h1=${'0'.repeat(64)}`;
  assert.equal(verifyPaddleSignature(Buffer.from(raw), rotated, secret), true, 'any matching h1 is accepted');
  assert.equal(verifyPaddleSignature(Buffer.from('{"a":2}'), paddleHeader(raw), secret), false);
  assert.equal(verifyPaddleSignature(Buffer.from(raw), paddleHeader(raw, secret, Math.floor(Date.now() / 1000) - 3600), secret), false);
  assert.equal(verifyPaddleSignature(Buffer.from(raw), undefined, secret), false);
});

test('Paddle webhook: subscription activates Pro and cancellation ends it', async () => {
  const { user } = await registerUser(base);
  const subId = `sub_${crypto.randomBytes(8).toString('hex')}`;
  const ends = new Date(Date.now() + 30 * 86400000).toISOString();
  const send = async (event) => {
    const raw = JSON.stringify(event);
    return request(base, '/webhooks/paddle', { method: 'POST', headers: { 'Paddle-Signature': paddleHeader(raw) }, body: raw });
  };

  const unsigned = await request(base, '/webhooks/paddle', { method: 'POST', body: '{}' });
  assert.equal(unsigned.status, 401);

  const activated = await send({ event_type: 'subscription.activated', data: { id: subId, status: 'active', customer_id: 'ctm_1', custom_data: { user_id: String(user.id) }, current_billing_period: { ends_at: ends } } });
  assert.equal(activated.status, 200);
  assert.equal((await userPlan(user.id)).plan, 'pro');

  // Later events may omit custom_data; the subscription id is enough.
  const canceled = await send({ event_type: 'subscription.canceled', data: { id: subId, status: 'canceled' } });
  assert.equal(canceled.status, 200);
  assert.equal((await userPlan(user.id)).plan, 'free');
});
