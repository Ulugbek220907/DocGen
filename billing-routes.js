const express = require('express');
const requireAuth = require('./require-auth');
const { getUsageStatus } = require('./usage');
const { getPlan } = require('./plans');

const router = express.Router();

router.get('/status', requireAuth, async (req, res) => {
  try {
    const status = await getUsageStatus(req.userId);
    if (!status) return res.status(404).json({ error: 'User not found.' });
    res.json({
      ...status,
      limit: status.limit === Infinity ? null : status.limit,
      remaining: status.remaining === Infinity ? null : status.remaining
    });
  } catch (err) {
    console.error('Billing status error:', err);
    res.status(500).json({ error: 'Could not load billing status.' });
  }
});

// Worldwide: Paddle is the Merchant of Record, so all we hand the client is
// the (non-secret) price id + client-side token it needs to open Paddle.js's
// own checkout overlay — no server-side charge happens here, the webhook
// (paddle-webhook.js) is what actually grants the plan once Paddle confirms
// payment.
router.post('/checkout/paddle', requireAuth, (req, res) => {
  const priceId = process.env.PADDLE_PRICE_ID || null;
  const clientToken = process.env.PADDLE_CLIENT_TOKEN || null;
  const environment = process.env.PADDLE_ENVIRONMENT || null; // 'sandbox' while testing
  res.json({ priceId, clientToken, environment });
});

// Uzbekistan: Payme and Click don't have a client-side SDK like Paddle's —
// the browser is simply redirected to a checkout URL built from documented
// query params. The account/transaction param carries our user id so the
// matching webhook (payme-webhook.js / click-webhook.js) can credit the
// right account once the provider confirms payment.
router.post('/checkout/payme', requireAuth, (req, res) => {
  const merchantId = process.env.PAYME_MERCHANT_ID;
  if (!merchantId) return res.json({ url: null });

  const amountTiyin = Math.round(getPlan('pro').priceUzs * 100);
  const params = `m=${merchantId};ac.user_id=${req.userId};a=${amountTiyin}`;
  const encoded = Buffer.from(params, 'utf8').toString('base64');
  res.json({ url: `https://checkout.paycom.uz/${encoded}` });
});

router.post('/checkout/click', requireAuth, (req, res) => {
  const serviceId = process.env.CLICK_SERVICE_ID;
  const merchantId = process.env.CLICK_MERCHANT_ID;
  if (!serviceId || !merchantId) return res.json({ url: null });

  const amount = getPlan('pro').priceUzs;
  const returnUrl = `${req.protocol}://${req.get('host')}/`;
  const params = new URLSearchParams({
    service_id: serviceId,
    merchant_id: merchantId,
    amount: amount.toFixed(2),
    transaction_param: String(req.userId),
    return_url: returnUrl
  });
  res.json({ url: `https://my.click.uz/services/pay?${params.toString()}` });
});

module.exports = router;
