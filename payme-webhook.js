const express = require('express');
const pool = require('./db-pool');
const { getPlan } = require('./plans');

const router = express.Router();
router.use(express.json());

// Payme Merchant API (https://developer.help.paycom.uz/en/) — a single
// JSON-RPC 2.0 endpoint, one method per request, authenticated with HTTP
// Basic Auth using "Paycom" as the username and the merchant key as the
// password. Every response/error shape below follows that spec exactly —
// Payme's own servers retry/behave differently if the shape is off.

const ERR = {
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  UNABLE_TO_PERFORM: -31008,
  USER_NOT_FOUND: -31050, // merchant-reserved range (-31099..-31050)
  INSUFFICIENT_PRIVILEGE: -32504
};

const TRANSACTION_TIMEOUT_MS = 12 * 60 * 60 * 1000; // Payme's standard 12h window

function expectedAmountTiyin() {
  return Math.round(getPlan('pro').priceUzs * 100);
}

function rpcError(id, code, message, data) {
  return { error: { code, message: { en: message, ru: message, uz: message }, data }, id };
}
function rpcResult(id, result) {
  return { result, id };
}

function checkAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [login, key] = decoded.split(':');
  return login === 'Paycom' && key === process.env.PAYME_KEY && !!process.env.PAYME_KEY;
}

router.post('/', async (req, res) => {
  const { method, params, id } = req.body || {};

  if (!checkAuth(req)) {
    return res.json(rpcError(id, ERR.INSUFFICIENT_PRIVILEGE, 'Insufficient privilege to perform this method.'));
  }

  try {
    switch (method) {
      case 'CheckPerformTransaction': return res.json(await checkPerformTransaction(id, params));
      case 'CreateTransaction': return res.json(await createTransaction(id, params));
      case 'PerformTransaction': return res.json(await performTransaction(id, params));
      case 'CancelTransaction': return res.json(await cancelTransaction(id, params));
      case 'CheckTransaction': return res.json(await checkTransaction(id, params));
      case 'GetStatement': return res.json(await getStatement(id, params));
      default:
        return res.json(rpcError(id, -32601, 'Method not found.'));
    }
  } catch (err) {
    console.error('[payme-webhook]', method, err);
    return res.json(rpcError(id, -32400, 'System error.'));
  }
});

async function findUser(userId) {
  if (!userId) return null;
  const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [Number(userId)]);
  return rows[0] || null;
}

async function checkPerformTransaction(id, params) {
  const userId = params?.account?.user_id;
  const user = await findUser(userId);
  if (!user) return rpcError(id, ERR.USER_NOT_FOUND, 'User not found.', 'user_id');
  if (params.amount !== expectedAmountTiyin()) {
    return rpcError(id, ERR.INVALID_AMOUNT, 'Incorrect amount.');
  }
  return rpcResult(id, { allow: true });
}

async function createTransaction(id, params) {
  const { rows } = await pool.query('SELECT * FROM payme_transactions WHERE id = $1', [params.id]);
  const existing = rows[0];

  if (existing) {
    if (existing.state !== 1) {
      return rpcError(id, ERR.UNABLE_TO_PERFORM, 'Transaction is not pending.');
    }
    if (Date.now() - Number(existing.create_time) > TRANSACTION_TIMEOUT_MS) {
      await pool.query('UPDATE payme_transactions SET state = -1, cancel_time = $1, reason = 4 WHERE id = $2', [Date.now(), params.id]);
      return rpcError(id, ERR.UNABLE_TO_PERFORM, 'Transaction expired.');
    }
    return rpcResult(id, { create_time: Number(existing.create_time), transaction: existing.id, state: 1 });
  }

  const userId = params?.account?.user_id;
  const user = await findUser(userId);
  if (!user) return rpcError(id, ERR.USER_NOT_FOUND, 'User not found.', 'user_id');
  if (params.amount !== expectedAmountTiyin()) {
    return rpcError(id, ERR.INVALID_AMOUNT, 'Incorrect amount.');
  }

  const createTime = Date.now();
  await pool.query(
    'INSERT INTO payme_transactions (id, user_id, amount, state, create_time) VALUES ($1, $2, $3, 1, $4)',
    [params.id, userId, params.amount, createTime]
  );
  return rpcResult(id, { create_time: createTime, transaction: params.id, state: 1 });
}

async function performTransaction(id, params) {
  const { rows } = await pool.query('SELECT * FROM payme_transactions WHERE id = $1', [params.id]);
  const tx = rows[0];
  if (!tx) return rpcError(id, ERR.TRANSACTION_NOT_FOUND, 'Transaction not found.');

  if (tx.state === 2) {
    // Already performed — Payme may retry this call, respond idempotently.
    return rpcResult(id, { transaction: tx.id, perform_time: Number(tx.perform_time), state: 2 });
  }
  if (tx.state !== 1) {
    return rpcError(id, ERR.UNABLE_TO_PERFORM, 'Transaction is not in a performable state.');
  }
  if (Date.now() - Number(tx.create_time) > TRANSACTION_TIMEOUT_MS) {
    await pool.query('UPDATE payme_transactions SET state = -1, cancel_time = $1, reason = 4 WHERE id = $2', [Date.now(), params.id]);
    return rpcError(id, ERR.UNABLE_TO_PERFORM, 'Transaction expired.');
  }

  const performTime = Date.now();
  const plan = getPlan('pro');
  const expiresAt = new Date(Date.now() + plan.periodDays * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE payme_transactions SET state = 2, perform_time = $1 WHERE id = $2', [performTime, params.id]);
    await client.query('UPDATE users SET plan = $1, plan_expires_at = $2 WHERE id = $3', ['pro', expiresAt, tx.user_id]);
    await client.query(
      `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, status, current_period_end)
       VALUES ($1, 'payme', $2, 'active', $3)`,
      [tx.user_id, tx.id, expiresAt]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return rpcResult(id, { transaction: tx.id, perform_time: performTime, state: 2 });
}

async function cancelTransaction(id, params) {
  const { rows } = await pool.query('SELECT * FROM payme_transactions WHERE id = $1', [params.id]);
  const tx = rows[0];
  if (!tx) return rpcError(id, ERR.TRANSACTION_NOT_FOUND, 'Transaction not found.');

  if (tx.state === -1 || tx.state === -2) {
    return rpcResult(id, { transaction: tx.id, cancel_time: Number(tx.cancel_time), state: tx.state });
  }

  const cancelTime = Date.now();
  const newState = tx.state === 2 ? -2 : -1;

  await pool.query(
    'UPDATE payme_transactions SET state = $1, cancel_time = $2, reason = $3 WHERE id = $4',
    [newState, cancelTime, params.reason ?? null, params.id]
  );

  if (newState === -2) {
    // Was already performed (plan granted) — a cancel now means a refund, revoke access.
    await pool.query('UPDATE users SET plan = $1 WHERE id = $2', ['free', tx.user_id]);
  }

  return rpcResult(id, { transaction: tx.id, cancel_time: cancelTime, state: newState });
}

async function checkTransaction(id, params) {
  const { rows } = await pool.query('SELECT * FROM payme_transactions WHERE id = $1', [params.id]);
  const tx = rows[0];
  if (!tx) return rpcError(id, ERR.TRANSACTION_NOT_FOUND, 'Transaction not found.');
  return rpcResult(id, {
    create_time: Number(tx.create_time),
    perform_time: Number(tx.perform_time),
    cancel_time: Number(tx.cancel_time),
    transaction: tx.id,
    state: tx.state,
    reason: tx.reason
  });
}

async function getStatement(id, params) {
  const { rows } = await pool.query(
    'SELECT * FROM payme_transactions WHERE create_time BETWEEN $1 AND $2 ORDER BY create_time',
    [params.from, params.to]
  );
  return rpcResult(id, {
    transactions: rows.map(tx => ({
      id: tx.id,
      time: Number(tx.create_time),
      amount: Number(tx.amount),
      account: { user_id: String(tx.user_id) },
      create_time: Number(tx.create_time),
      perform_time: Number(tx.perform_time),
      cancel_time: Number(tx.cancel_time),
      transaction: tx.id,
      state: tx.state,
      reason: tx.reason
    }))
  });
}

module.exports = router;
