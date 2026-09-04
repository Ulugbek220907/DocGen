const express = require('express');
const crypto = require('crypto');
const pool = require('./db-pool');
const { getPlan } = require('./plans');

const router = express.Router();
// Click posts application/x-www-form-urlencoded by default; accept JSON too
// since some Click integrations send that instead.
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// Click Merchant API (https://docs.click.uz/en/click-api-request/) — a
// two-phase Prepare (action=0) / Complete (action=1) callback, both signed
// with an MD5 hash of a fixed field concatenation. Error codes below are
// Click's own documented codes, not ours to change.
const ERR = {
  SIGN_FAILED: -1,
  WRONG_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  USER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  TRANSACTION_CANCELLED: -9
};

function expectedAmount() {
  return getPlan('pro').priceUzs;
}

function amountsMatch(a, b) {
  return Math.abs(parseFloat(a) - parseFloat(b)) < 0.01;
}

function verifySign(fields, signString, secret) {
  const expected = crypto.createHash('md5').update(fields.join('') + secret).digest('hex');
  return expected === signString;
}

router.post('/prepare', async (req, res) => {
  const secret = process.env.CLICK_SECRET_KEY;
  const b = req.body;
  const serviceId = process.env.CLICK_SERVICE_ID;

  if (!secret || !serviceId) {
    return res.json({ error: ERR.ACTION_NOT_FOUND, error_note: 'Not configured' });
  }

  const signOk = verifySign(
    [b.click_trans_id, b.service_id, b.merchant_trans_id, b.amount, b.action, b.sign_time],
    b.sign_string,
    secret
  );
  if (!signOk) {
    return res.json({ error: ERR.SIGN_FAILED, error_note: 'SIGN CHECK FAILED!' });
  }

  const userId = Number(b.merchant_trans_id);
  const { rows: userRows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (!userRows[0]) {
    return res.json({ error: ERR.USER_NOT_FOUND, error_note: 'User does not exist' });
  }

  if (!amountsMatch(b.amount, expectedAmount())) {
    return res.json({ error: ERR.WRONG_AMOUNT, error_note: 'Incorrect parameter amount' });
  }

  const { rows: existingRows } = await pool.query(
    'SELECT * FROM click_transactions WHERE click_trans_id = $1', [b.click_trans_id]
  );
  if (!existingRows[0]) {
    await pool.query(
      'INSERT INTO click_transactions (click_trans_id, merchant_trans_id, user_id, amount, status) VALUES ($1, $2, $3, $4, $5)',
      [b.click_trans_id, b.merchant_trans_id, userId, b.amount, 'prepared']
    );
  }

  return res.json({
    click_trans_id: b.click_trans_id,
    merchant_trans_id: b.merchant_trans_id,
    merchant_prepare_id: b.click_trans_id,
    error: 0,
    error_note: 'Success'
  });
});

router.post('/complete', async (req, res) => {
  const secret = process.env.CLICK_SECRET_KEY;
  const b = req.body;

  if (!secret) {
    return res.json({ error: ERR.ACTION_NOT_FOUND, error_note: 'Not configured' });
  }

  const signOk = verifySign(
    [b.click_trans_id, b.service_id, b.merchant_trans_id, b.merchant_prepare_id, b.amount, b.action, b.sign_time],
    b.sign_string,
    secret
  );
  if (!signOk) {
    return res.json({ error: ERR.SIGN_FAILED, error_note: 'SIGN CHECK FAILED!' });
  }

  const { rows } = await pool.query('SELECT * FROM click_transactions WHERE click_trans_id = $1', [b.click_trans_id]);
  const tx = rows[0];
  if (!tx) {
    return res.json({ error: ERR.TRANSACTION_NOT_FOUND, error_note: 'Transaction does not exist' });
  }

  if (Number(b.error) < 0) {
    await pool.query('UPDATE click_transactions SET status = $1 WHERE click_trans_id = $2', ['cancelled', b.click_trans_id]);
    return res.json({
      click_trans_id: b.click_trans_id,
      merchant_trans_id: b.merchant_trans_id,
      merchant_confirm_id: b.click_trans_id,
      error: 0,
      error_note: 'Success'
    });
  }

  if (tx.status === 'confirmed') {
    return res.json({
      click_trans_id: b.click_trans_id,
      merchant_trans_id: b.merchant_trans_id,
      merchant_confirm_id: b.click_trans_id,
      error: 0,
      error_note: 'Success'
    });
  }
  if (tx.status === 'cancelled') {
    return res.json({ error: ERR.TRANSACTION_CANCELLED, error_note: 'Transaction cancelled' });
  }

  const plan = getPlan('pro');
  const expiresAt = new Date(Date.now() + plan.periodDays * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE click_transactions SET status = $1 WHERE click_trans_id = $2', ['confirmed', b.click_trans_id]);
    await client.query('UPDATE users SET plan = $1, plan_expires_at = $2 WHERE id = $3', ['pro', expiresAt, tx.user_id]);
    await client.query(
      `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, status, current_period_end)
       VALUES ($1, 'click', $2, 'active', $3)`,
      [tx.user_id, String(tx.click_trans_id), expiresAt]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return res.json({
    click_trans_id: b.click_trans_id,
    merchant_trans_id: b.merchant_trans_id,
    merchant_confirm_id: b.click_trans_id,
    error: 0,
    error_note: 'Success'
  });
});

module.exports = router;
