const express = require('express');
const crypto = require('crypto');
const pool = require('./db-pool');
const config = require('./config');

const router = express.Router();

// Paddle needs the raw, unparsed body to verify the signature — mounted
// BEFORE the app-wide express.json() in server.js.
router.use(express.raw({ type: '*/*', limit: '1mb' }));

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

// https://developer.paddle.com/webhooks/signature-verification
// Header: "ts=1671552777;h1=<hex>[;h1=<hex>]" — more than one h1 while a
// secret is being rotated.
function verifyPaddleSignature(rawBody, header, secret) {
  if (!header || !secret || !Buffer.isBuffer(rawBody)) return false;
  let ts = null;
  const signatures = [];
  for (const part of header.split(';')) {
    const [k, v] = part.split('=');
    if (k === 'ts') ts = v;
    if (k === 'h1' && v) signatures.push(v);
  }
  if (!ts || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody.toString('utf8')}`).digest();
  return signatures.some(sig => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

router.post('/', async (req, res) => {
  if (!config.paddle.webhookSecret) {
    console.error('[paddle-webhook] PADDLE_WEBHOOK_SECRET is not set — rejecting.');
    return res.status(503).send('Not configured');
  }
  if (!verifyPaddleSignature(req.body, req.headers['paddle-signature'], config.paddle.webhookSecret)) {
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  try {
    await handleEvent(event);
    res.status(200).send('ok');
  } catch (err) {
    console.error('[paddle-webhook] handler error:', err);
    res.status(500).send('error'); // Paddle retries non-2xx
  }
});

async function resolveUserId(data) {
  const fromCustom = Number(data.custom_data?.user_id);
  if (Number.isInteger(fromCustom) && fromCustom > 0) return fromCustom;
  // Fall back to a subscription we already know about.
  const { rows } = await pool.query(
    "SELECT user_id FROM subscriptions WHERE provider = 'paddle' AND provider_subscription_id = $1",
    [data.id]
  );
  return rows[0]?.user_id || null;
}

async function handleEvent(event) {
  const type = event.event_type || '';
  if (!type.startsWith('subscription.')) return; // transaction.* etc. aren't needed for plan gating
  const data = event.data || {};
  const userId = await resolveUserId(data);
  const status = data.status;
  const periodEnd = data.current_billing_period?.ends_at || null;

  await pool.query(
    `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, provider_customer_id, status, current_period_end)
     VALUES ($1, 'paddle', $2, $3, $4, $5)
     ON CONFLICT (provider, provider_subscription_id) DO UPDATE
       SET status = EXCLUDED.status,
           current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
           user_id = COALESCE(subscriptions.user_id, EXCLUDED.user_id),
           updated_at = now()`,
    [userId, data.id, data.customer_id || null, status || 'unknown', periodEnd]
  );

  if (!userId) {
    console.warn('[paddle-webhook] subscription event with no resolvable user:', data.id);
    return;
  }

  if (status === 'active' || status === 'trialing') {
    await pool.query("UPDATE users SET plan = 'pro', plan_expires_at = $1 WHERE id = $2", [periodEnd, userId]);
  } else if (status === 'past_due') {
    // Paddle is retrying the charge; keep access until the paid period ends.
  } else if (status === 'canceled' || status === 'paused') {
    await pool.query("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = $1 AND plan = 'pro'", [userId]);
  }
}

module.exports = router;
module.exports.verifyPaddleSignature = verifyPaddleSignature;
