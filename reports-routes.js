const express = require('express');
const pool = require('./db-pool');
const requireAuth = require('./require-auth');
const { createLimiter, byUser } = require('./rate-limit');

const router = express.Router();
router.use(requireAuth);

const limiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: byUser, message: 'Too many reports. Please try again later.' });

// Lets users flag AI output as offensive, harmful or wrong. Only content the
// user owns can be reported, and a snapshot of it is kept for review.
router.post('/', limiter, async (req, res) => {
  const body = req.body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
  if (!reason) return res.status(400).json({ error: 'Please say what is wrong.', code: 'invalid_input' });

  let snapshot = null;
  let messageId = null;
  let documentId = null;
  if (Number.isInteger(body.messageId)) {
    const { rows } = await pool.query(
      `SELECT m.id, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $1 AND c.user_id = $2 AND m.role = 'assistant'`,
      [body.messageId, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Message not found.', code: 'not_found' });
    messageId = rows[0].id;
    snapshot = rows[0].content;
  } else if (typeof body.documentId === 'string') {
    const { rows } = await pool.query('SELECT id, schema FROM documents WHERE id = $1 AND user_id = $2', [body.documentId, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found.', code: 'not_found' });
    documentId = rows[0].id;
    snapshot = JSON.stringify(rows[0].schema).slice(0, 100000);
  } else {
    return res.status(400).json({ error: 'Nothing to report.', code: 'invalid_input' });
  }

  await pool.query(
    'INSERT INTO content_reports (user_id, message_id, document_id, reason, content_snapshot) VALUES ($1, $2, $3, $4, $5)',
    [req.userId, messageId, documentId, reason, snapshot]
  );
  console.warn(`[report] user ${req.userId} reported ${messageId ? `message ${messageId}` : `document ${documentId}`}: ${reason.slice(0, 200)}`);
  res.status(201).json({ ok: true, message: 'Thanks — we’ll review it.' });
});

module.exports = router;
