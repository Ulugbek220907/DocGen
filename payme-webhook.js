const express = require('express');
const pool = require('./db-pool');
const config = require('./config');
const { getPlan, grantProDays } = require('./plans');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

// Payme Merchant API — https://developer.help.paycom.uz/metody-merchant-api/
// Behaviour mirrors Payme's own reference implementation
// (github.com/PaycomUZ/paycom-integration-php-template), which is what
// Payme's sandbox checker tests against. The Payme cabinet must be
// configured with a single account field named "order_id".

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32400,
  INSUFFICIENT_PRIVILEGE: -32504,
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  COULD_NOT_CANCEL: -31007,
  COULD_NOT_PERFORM: -31008,
  INVALID_ACCOUNT: -31050
};

const TIMEOUT_MS = 43200000; // 12 hours
const STATE = { CREATED: 1, COMPLETED: 2, CANCELLED: -1, CANCELLED_AFTER_COMPLETE: -2 };
const REASON_TIMEOUT = 4;

class PaymeError extends Error {
  constructor(code, message, data) {
    super(typeof message === 'string' ? message : message.en);
    this.code = code;
    this.localized = typeof message === 'string' ? { ru: message, uz: message, en: message } : message;
    this.data = data;
  }
}

const MSG = {
  orderNotFound: { ru: 'Неверный код заказа.', uz: 'Buyurtma raqami noto‘g‘ri.', en: 'Incorrect order code.' },
  otherTx: { ru: 'Для этого заказа уже есть активная транзакция.', uz: 'Bu buyurtma uchun faol tranzaksiya mavjud.', en: 'There is another active/completed transaction for this order.' }
};

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ') || !config.payme.key) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  return sep > 0 && decoded.slice(0, sep) === 'Paycom' && decoded.slice(sep + 1) === config.payme.key;
}

async function loadOrderForPayment(client, params) {
  const orderId = Number(params?.account?.order_id);
  if (!Number.isInteger(orderId) || orderId <= 0) throw new PaymeError(ERR.INVALID_ACCOUNT, MSG.orderNotFound, 'order_id');
  const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const order = rows[0];
  if (!order || order.provider !== 'payme') throw new PaymeError(ERR.INVALID_ACCOUNT, MSG.orderNotFound, 'order_id');
  if (!Number.isInteger(params.amount) || params.amount !== Number(order.amount_uzs) * 100) {
    throw new PaymeError(ERR.INVALID_AMOUNT, 'Incorrect amount.');
  }
  if (order.status !== 'pending') throw new PaymeError(ERR.COULD_NOT_PERFORM, 'Order state is invalid.');
  return order;
}

function isExpired(tx) {
  return tx.state === STATE.CREATED && Date.now() - Number(tx.create_time) > TIMEOUT_MS;
}

async function cancelTx(client, tx, reason, newState) {
  const now = Date.now();
  await client.query('UPDATE payme_transactions SET state = $1, cancel_time = $2, reason = $3 WHERE id = $4', [newState, now, reason, tx.id]);
  if (tx.order_id) await client.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [tx.order_id]);
  return now;
}

const methods = {
  async CheckPerformTransaction(client, params) {
    const order = await loadOrderForPayment(client, params);
    const { rows } = await client.query('SELECT 1 FROM payme_transactions WHERE order_id = $1 AND state IN (1, 2)', [order.id]);
    if (rows[0]) throw new PaymeError(ERR.COULD_NOT_PERFORM, MSG.otherTx);
    return { allow: true };
  },

  async CreateTransaction(client, params) {
    const order = await loadOrderForPayment(client, params);

    const other = await client.query(
      'SELECT id FROM payme_transactions WHERE order_id = $1 AND state IN (1, 2) AND id <> $2',
      [order.id, String(params.id)]
    );
    if (other.rows[0]) throw new PaymeError(ERR.INVALID_ACCOUNT, MSG.otherTx, 'order_id');

    const { rows } = await client.query('SELECT * FROM payme_transactions WHERE id = $1', [String(params.id)]);
    const found = rows[0];
    if (found) {
      if (found.state !== STATE.CREATED) throw new PaymeError(ERR.COULD_NOT_PERFORM, 'Transaction found, but is not active.');
      if (isExpired(found)) {
        await cancelTx(client, found, REASON_TIMEOUT, STATE.CANCELLED);
        throw new PaymeError(ERR.COULD_NOT_PERFORM, 'Transaction is expired.');
      }
      return { create_time: Number(found.create_time), transaction: found.id, state: found.state, receivers: null };
    }

    if (Date.now() - Number(params.time) >= TIMEOUT_MS) {
      throw new PaymeError(ERR.INVALID_ACCOUNT, 'Since create time of the transaction passed 12 hours.', 'time');
    }

    const createTime = Date.now();
    await client.query(
      `INSERT INTO payme_transactions (id, user_id, order_id, amount, state, create_time, payme_time)
       VALUES ($1, $2, $3, $4, 1, $5, $6)`,
      [String(params.id), order.user_id, order.id, params.amount, createTime, Number(params.time)]
    );
    return { create_time: createTime, transaction: String(params.id), state: STATE.CREATED, receivers: null };
  },

  async PerformTransaction(client, params) {
    const { rows } = await client.query('SELECT * FROM payme_transactions WHERE id = $1 FOR UPDATE', [String(params.id)]);
    const tx = rows[0];
    if (!tx) throw new PaymeError(ERR.TRANSACTION_NOT_FOUND, 'Transaction not found.');

    if (tx.state === STATE.COMPLETED) {
      return { transaction: tx.id, perform_time: Number(tx.perform_time), state: tx.state };
    }
    if (tx.state !== STATE.CREATED) throw new PaymeError(ERR.COULD_NOT_PERFORM, 'Could not perform this operation.');
    if (isExpired(tx)) {
      await cancelTx(client, tx, REASON_TIMEOUT, STATE.CANCELLED);
      throw new PaymeError(ERR.COULD_NOT_PERFORM, 'Transaction is expired.');
    }

    const performTime = Date.now();
    await client.query('UPDATE payme_transactions SET state = 2, perform_time = $1 WHERE id = $2', [performTime, tx.id]);
    await client.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [tx.order_id]);
    if (tx.user_id) {
      const pro = getPlan('pro');
      const expiresAt = await grantProDays(client, tx.user_id, pro.periodDays);
      await client.query(
        `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, status, current_period_end)
         VALUES ($1, 'payme', $2, 'active', $3) ON CONFLICT (provider, provider_subscription_id) DO NOTHING`,
        [tx.user_id, tx.id, expiresAt]
      );
    }
    return { transaction: tx.id, perform_time: performTime, state: STATE.COMPLETED };
  },

  async CancelTransaction(client, params) {
    const { rows } = await client.query('SELECT * FROM payme_transactions WHERE id = $1 FOR UPDATE', [String(params.id)]);
    const tx = rows[0];
    if (!tx) throw new PaymeError(ERR.TRANSACTION_NOT_FOUND, 'Transaction not found.');

    if (tx.state === STATE.CANCELLED || tx.state === STATE.CANCELLED_AFTER_COMPLETE) {
      return { transaction: tx.id, cancel_time: Number(tx.cancel_time), state: tx.state };
    }

    const reason = Number.isInteger(params.reason) ? params.reason : null;
    if (tx.state === STATE.CREATED) {
      const cancelTime = await cancelTx(client, tx, reason, STATE.CANCELLED);
      return { transaction: tx.id, cancel_time: cancelTime, state: STATE.CANCELLED };
    }

    // Refund of a completed payment: take back the Pro time it bought.
    const cancelTime = await cancelTx(client, tx, reason, STATE.CANCELLED_AFTER_COMPLETE);
    if (tx.user_id) {
      const pro = getPlan('pro');
      await client.query(
        `UPDATE users SET plan_expires_at = plan_expires_at - make_interval(days => $2) WHERE id = $1 AND plan_expires_at IS NOT NULL`,
        [tx.user_id, pro.periodDays]
      );
      await client.query("UPDATE users SET plan = 'free' WHERE id = $1 AND (plan_expires_at IS NULL OR plan_expires_at <= now())", [tx.user_id]);
      await client.query("UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE provider = 'payme' AND provider_subscription_id = $1", [tx.id]);
    }
    return { transaction: tx.id, cancel_time: cancelTime, state: STATE.CANCELLED_AFTER_COMPLETE };
  },

  async CheckTransaction(client, params) {
    const { rows } = await client.query('SELECT * FROM payme_transactions WHERE id = $1', [String(params.id)]);
    const tx = rows[0];
    if (!tx) throw new PaymeError(ERR.TRANSACTION_NOT_FOUND, 'Transaction not found.');
    return {
      create_time: Number(tx.create_time),
      perform_time: Number(tx.perform_time),
      cancel_time: Number(tx.cancel_time),
      transaction: tx.id,
      state: tx.state,
      reason: tx.reason === null ? null : Number(tx.reason)
    };
  },

  async GetStatement(client, params) {
    const from = Number(params.from);
    const to = Number(params.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new PaymeError(ERR.INVALID_ACCOUNT, 'Incorrect period.', 'from');
    }
    const { rows } = await client.query(
      'SELECT * FROM payme_transactions WHERE COALESCE(payme_time, create_time) BETWEEN $1 AND $2 ORDER BY COALESCE(payme_time, create_time)',
      [from, to]
    );
    return {
      transactions: rows.map(tx => ({
        id: tx.id,
        time: Number(tx.payme_time || tx.create_time),
        amount: Number(tx.amount),
        account: { order_id: tx.order_id ? String(tx.order_id) : null },
        create_time: Number(tx.create_time),
        perform_time: Number(tx.perform_time),
        cancel_time: Number(tx.cancel_time),
        transaction: tx.id,
        state: tx.state,
        reason: tx.reason === null ? null : Number(tx.reason),
        receivers: null
      }))
    };
  }
};

router.post('/', async (req, res) => {
  const body = req.body || {};
  const id = body.id ?? null;
  const reply = (payload) => res.status(200).json({ jsonrpc: '2.0', id, ...payload });
  const error = (code, localized, data) => reply({ error: { code, message: localized, data } });

  if (!authorized(req)) {
    return error(ERR.INSUFFICIENT_PRIVILEGE, { ru: 'Недостаточно привилегий.', uz: 'Ruxsat yo‘q.', en: 'Insufficient privilege to perform this method.' });
  }
  if (typeof body.method !== 'string' || typeof body.params !== 'object' || body.params === null) {
    return error(ERR.INVALID_REQUEST, { ru: 'Неверный запрос.', uz: 'Noto‘g‘ri so‘rov.', en: 'Invalid JSON-RPC object.' });
  }
  const handler = methods[body.method];
  if (!handler) {
    return error(ERR.METHOD_NOT_FOUND, { ru: 'Метод не найден.', uz: 'Metod topilmadi.', en: 'Method not found.' }, body.method);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client, body.params);
    await client.query('COMMIT');
    reply({ result });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PaymeError) {
      // Cancellations caused by timeout must stick even though we report an error.
      if (/expired/i.test(err.message)) {
        try {
          await client.query('BEGIN');
          const { rows } = await client.query('SELECT * FROM payme_transactions WHERE id = $1 FOR UPDATE', [String(body.params.id)]);
          if (rows[0] && rows[0].state === STATE.CREATED) await cancelTx(client, rows[0], REASON_TIMEOUT, STATE.CANCELLED);
          await client.query('COMMIT');
        } catch { await client.query('ROLLBACK').catch(() => {}); }
      }
      return error(err.code, err.localized, err.data);
    }
    console.error('[payme]', body.method, err);
    error(ERR.INTERNAL, { ru: 'Системная ошибка.', uz: 'Tizim xatosi.', en: 'System error.' });
  } finally {
    client.release();
  }
});

module.exports = router;
