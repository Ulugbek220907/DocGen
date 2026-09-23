const express = require('express');
const crypto = require('crypto');
const pool = require('./db-pool');
const config = require('./config');
const { getPlan, grantProDays } = require('./plans');

const router = express.Router();
// Click posts application/x-www-form-urlencoded; accept JSON too.
router.use(express.urlencoded({ extended: false, limit: '50kb' }));
router.use(express.json({ limit: '50kb' }));

// Click Merchant API (SHOP API) — https://docs.click.uz/en/click-api-request/
// Two phases: Prepare (action=0) then Complete (action=1), each signed with
// an MD5 over a fixed field order. merchant_trans_id is our order id.
const ERR = {
  SUCCESS: 0,
  SIGN_FAILED: -1,
  WRONG_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  ORDER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  UPDATE_FAILED: -7,
  REQUEST_ERROR: -8,
  TRANSACTION_CANCELLED: -9
};

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function signOk(b, withPrepareId) {
  const secret = config.click.secretKey;
  if (!secret || typeof b.sign_string !== 'string') return false;
  const parts = [b.click_trans_id, b.service_id, secret, b.merchant_trans_id];
  if (withPrepareId) parts.push(b.merchant_prepare_id);
  parts.push(b.amount, b.action, b.sign_time);
  const expected = md5(parts.map(v => (v === undefined || v === null ? '' : String(v))).join(''));
  const given = b.sign_string.toLowerCase();
  return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

function amountsMatch(a, b) {
  return Math.abs(parseFloat(a) - parseFloat(b)) < 0.01;
}

function respond(res, b, error, note, extra = {}) {
  res.json({
    click_trans_id: b.click_trans_id !== undefined ? Number(b.click_trans_id) : undefined,
    merchant_trans_id: b.merchant_trans_id,
    error,
    error_note: note,
    ...extra
  });
}

router.post('/prepare', async (req, res) => {
  const b = req.body || {};
  if (!config.click.secretKey) return respond(res, b, ERR.REQUEST_ERROR, 'Not configured');
  if (!signOk(b, false)) return respond(res, b, ERR.SIGN_FAILED, 'SIGN CHECK FAILED!');
  if (String(b.action) !== '0') return respond(res, b, ERR.ACTION_NOT_FOUND, 'Action not found');
  if (String(b.service_id) !== String(config.click.serviceId)) return respond(res, b, ERR.REQUEST_ERROR, 'Error in request from click');

  const orderId = Number(b.merchant_trans_id);
  if (!Number.isInteger(orderId) || orderId <= 0) return respond(res, b, ERR.ORDER_NOT_FOUND, 'Order not found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order || order.provider !== 'click') { await client.query('ROLLBACK'); return respond(res, b, ERR.ORDER_NOT_FOUND, 'Order not found'); }
    if (order.status === 'paid') { await client.query('ROLLBACK'); return respond(res, b, ERR.ALREADY_PAID, 'Already paid'); }
    if (order.status === 'cancelled') { await client.query('ROLLBACK'); return respond(res, b, ERR.TRANSACTION_CANCELLED, 'Transaction cancelled'); }
    if (!amountsMatch(b.amount, order.amount_uzs)) { await client.query('ROLLBACK'); return respond(res, b, ERR.WRONG_AMOUNT, 'Incorrect parameter amount'); }

    await client.query(
      `INSERT INTO click_transactions (click_trans_id, merchant_trans_id, user_id, order_id, amount, status)
       VALUES ($1, $2, $3, $4, $5, 'prepared') ON CONFLICT (click_trans_id) DO NOTHING`,
      [b.click_trans_id, String(b.merchant_trans_id), order.user_id, order.id, b.amount]
    );
    await client.query('COMMIT');
    respond(res, b, ERR.SUCCESS, 'Success', { merchant_prepare_id: order.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[click] prepare', err);
    respond(res, b, ERR.UPDATE_FAILED, 'Failed to update order');
  } finally {
    client.release();
  }
});

router.post('/complete', async (req, res) => {
  const b = req.body || {};
  if (!config.click.secretKey) return respond(res, b, ERR.REQUEST_ERROR, 'Not configured');
  if (!signOk(b, true)) return respond(res, b, ERR.SIGN_FAILED, 'SIGN CHECK FAILED!');
  if (String(b.action) !== '1') return respond(res, b, ERR.ACTION_NOT_FOUND, 'Action not found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: txRows } = await client.query('SELECT * FROM click_transactions WHERE click_trans_id = $1 FOR UPDATE', [b.click_trans_id]);
    const tx = txRows[0];
    if (!tx || String(tx.order_id) !== String(b.merchant_prepare_id)) {
      await client.query('ROLLBACK');
      return respond(res, b, ERR.TRANSACTION_NOT_FOUND, 'Transaction does not exist');
    }
    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [tx.order_id]);
    const order = orderRows[0];

    if (order.status === 'paid') { await client.query('ROLLBACK'); return respond(res, b, ERR.ALREADY_PAID, 'Already paid'); }
    if (tx.status === 'cancelled' || order.status === 'cancelled') { await client.query('ROLLBACK'); return respond(res, b, ERR.TRANSACTION_CANCELLED, 'Transaction cancelled'); }

    // Click reports a failed payment by sending a negative error code here.
    if (Number(b.error) < 0) {
      await client.query("UPDATE click_transactions SET status = 'cancelled' WHERE click_trans_id = $1", [tx.click_trans_id]);
      await client.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [order.id]);
      await client.query('COMMIT');
      return respond(res, b, ERR.TRANSACTION_CANCELLED, 'Transaction cancelled');
    }

    if (!amountsMatch(b.amount, order.amount_uzs)) { await client.query('ROLLBACK'); return respond(res, b, ERR.WRONG_AMOUNT, 'Incorrect parameter amount'); }

    await client.query("UPDATE click_transactions SET status = 'confirmed' WHERE click_trans_id = $1", [tx.click_trans_id]);
    await client.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [order.id]);
    if (order.user_id) {
      const pro = getPlan('pro');
      const expiresAt = await grantProDays(client, order.user_id, pro.periodDays);
      await client.query(
        `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, status, current_period_end)
         VALUES ($1, 'click', $2, 'active', $3) ON CONFLICT (provider, provider_subscription_id) DO NOTHING`,
        [order.user_id, String(tx.click_trans_id), expiresAt]
      );
    }
    await client.query('COMMIT');
    respond(res, b, ERR.SUCCESS, 'Success', { merchant_confirm_id: order.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[click] complete', err);
    respond(res, b, ERR.UPDATE_FAILED, 'Failed to update order');
  } finally {
    client.release();
  }
});

module.exports = router;
