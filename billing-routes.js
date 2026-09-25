const express = require('express');
const pool = require('./db-pool');
const config = require('./config');
const requireAuth = require('./require-auth');
const { getUsageStatus } = require('./usage');
const { getPlan } = require('./plans');

const router = express.Router();
router.use(requireAuth);

function paymentsAvailability() {
  return {
    paddle: !!(config.paddle.clientToken && config.paddle.priceId),
    payme: !!(config.payme.merchantId && config.payme.key),
    click: !!(config.click.serviceId && config.click.merchantId && config.click.secretKey)
  };
}

router.get('/status', async (req, res) => {
  const status = await getUsageStatus(req.userId);
  if (!status) return res.status(401).json({ error: 'This account no longer exists.', code: 'account_deleted' });
  const pro = getPlan('pro');
  res.json({
    plan: status.plan,
    planExpiresAt: status.planExpiresAt,
    usageCount: status.usageCount,
    limit: status.limit === Infinity ? null : status.limit,
    remaining: status.remaining === Infinity ? null : status.remaining,
    resetsAt: status.resetsAt,
    pricing: { usd: pro.priceUsd, uzs: pro.priceUzs, periodDays: pro.periodDays },
    payments: paymentsAvailability()
  });
});

function unavailable(res) {
  return res.status(503).json({ error: 'This payment method isn’t available yet. Please try another one.', code: 'payments_unavailable' });
}

// Worldwide: Paddle is the Merchant of Record. The browser opens Paddle's
// own checkout overlay; the plan is granted only when Paddle's signed
// webhook confirms payment (paddle-webhook.js).
router.post('/checkout/paddle', (req, res) => {
  if (!paymentsAvailability().paddle) return unavailable(res);
  res.json({
    priceId: config.paddle.priceId,
    clientToken: config.paddle.clientToken,
    environment: config.paddle.environment,
    customData: { user_id: String(req.userId) }
  });
});

async function createOrder(userId, provider) {
  const pro = getPlan('pro');
  const { rows } = await pool.query(
    'INSERT INTO orders (user_id, provider, plan, amount_uzs) VALUES ($1, $2, $3, $4) RETURNING id, amount_uzs',
    [userId, provider, 'pro', pro.priceUzs]
  );
  return rows[0];
}

// Uzbekistan: Payme and Click both work by redirecting to a hosted checkout
// for a specific order; their server-to-server callbacks then confirm it.
router.post('/checkout/payme', async (req, res) => {
  if (!paymentsAvailability().payme) return unavailable(res);
  const order = await createOrder(req.userId, 'payme');
  const lang = ['uz', 'ru', 'en'].includes(req.body?.lang) ? req.body.lang : 'uz';
  const params = [
    `m=${config.payme.merchantId}`,
    `ac.order_id=${order.id}`,
    `a=${order.amount_uzs * 100}`,
    `l=${lang}`,
    `c=${config.publicUrl}/?payment=return`
  ].join(';');
  res.json({ orderId: order.id, url: `${config.payme.checkoutUrl}/${Buffer.from(params, 'utf8').toString('base64')}` });
});

router.post('/checkout/click', async (req, res) => {
  if (!paymentsAvailability().click) return unavailable(res);
  const order = await createOrder(req.userId, 'click');
  const qs = new URLSearchParams({
    service_id: config.click.serviceId,
    merchant_id: config.click.merchantId,
    amount: Number(order.amount_uzs).toFixed(2),
    transaction_param: String(order.id),
    return_url: `${config.publicUrl}/?payment=return`
  });
  res.json({ orderId: order.id, url: `https://my.click.uz/services/pay?${qs.toString()}` });
});

module.exports = router;
module.exports.paymentsAvailability = paymentsAvailability;
