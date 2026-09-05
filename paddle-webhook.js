const express = require('express');
const crypto = require('crypto');
const pool = require('./db-pool');
const { getPlan } = require('./plans');

const router = express.Router();

// Paddle needs the raw, unparsed body to verify the signature — this must be
// mounted BEFORE the app-wide express.json() in server.js, or the body will
// already be consumed/re-serialized by then and the signature check breaks.
router.use(express.raw({ type: 'application/json' }));

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

// https://developer.paddle.com/webhooks/signature-verification
// Header looks like: "ts=1671552777;h1=<hex hmac>"
function verifyPaddleSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(';').map(p => p.split('=')));
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const signedPayload = `${ts}:${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(h1, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

router.post('/', async (req, res) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[paddle-webhook] PADDLE_WEBHOOK_SECRET is not set — rejecting.');
    return res.status(500).send('Not configured');
  }

  const valid = verifyPaddleSignature(req.body, req.headers['paddle-signature'], secret);
  if (!valid) return res.status(401).send('Invalid signature');

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  try {
    await handlePaddleEvent(event);
    res.status(200).send('ok');
  } catch (err) {
    console.error('[paddle-webhook] handler error:', err);
    // Paddle retries on non-2xx, which is what we want for a transient DB error.
    res.status(500).send('error');
  }
});

async function handlePaddleEvent(event) {
  const type = event.event_type;
  const data = event.data || {};

  if (type === 'subscription.activated' || type === 'subscription.updated') {
    const userId = data.custom_data?.user_id;
    if (!userId) {
      console.warn('[paddle-webhook] subscription event with no custom_data.user_id — skipping', data.id);
      return;
    }

    const isActive = data.status === 'active' || data.status === 'trialing';
    const periodEnd = data.current_billing_period?.ends_at || null;

    await pool.query(
      `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, provider_customer_id, status, current_period_end)
       VALUES ($1, 'paddle', $2, $3, $4, $5)
       ON CONFLICT (provider, provider_subscription_id) DO UPDATE
         SET status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
      [userId, data.id, data.customer_id, data.status, periodEnd]
    );

    if (isActive) {
      await pool.query('UPDATE users SET plan = $1, plan_expires_at = $2 WHERE id = $3', ['pro', periodEnd, userId]);
    }
  } else if (type === 'subscription.canceled' || type === 'subscription.paused') {
    const userId = data.custom_data?.user_id;
    await pool.query(
      `UPDATE subscriptions SET status = $1, updated_at = now() WHERE provider = 'paddle' AND provider_subscription_id = $2`,
      [data.status, data.id]
    );
    if (userId) {
      await pool.query('UPDATE users SET plan = $1 WHERE id = $2', ['free', userId]);
    }
  }
  // Other event types (transaction.*, customer.*) aren't needed for plan gating.
}

module.exports = router;
