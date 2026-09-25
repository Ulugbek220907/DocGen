const express = require('express');
const pool = require('./db-pool');
const requireAuth = require('./require-auth');
const DocSchema = require('./public/js/doc-schema');

const router = express.Router();
router.use(requireAuth);

const MAX_CONVERSATIONS = 100;

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [req.userId, MAX_CONVERSATIONS]
  );
  res.json({ conversations: rows.map(r => ({ id: r.id, title: r.title, updatedAt: r.updated_at })) });
});

router.get('/:id', async (req, res) => {
  const convo = await pool.query(
    'SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]
  );
  if (!convo.rows[0]) return res.status(404).json({ error: 'Chat not found.', code: 'not_found' });

  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.attachment_names, m.document_id,
            m.document_schema, m.document_format, m.file_info,
            d.title AS doc_title, d.format AS doc_format
       FROM messages m
       LEFT JOIN documents d ON d.id = m.document_id
      WHERE m.conversation_id = $1
      ORDER BY m.id`,
    [req.params.id]
  );

  res.json({
    id: convo.rows[0].id,
    title: convo.rows[0].title,
    messages: rows.map(m => {
      const msg = { id: m.id, role: m.role, content: m.content };
      if (m.attachment_names?.length) msg.attachmentNames = m.attachment_names;
      if (m.document_id) {
        msg.document = { id: m.document_id, title: m.doc_title, format: m.doc_format };
      } else if (m.document_schema) {
        // Messages saved before documents became first-class objects.
        msg.legacyDocument = {
          title: m.file_info?.filename || 'Document',
          format: m.document_format || m.file_info?.format || 'pdf',
          schema: DocSchema.normalize(m.document_schema)
        };
      }
      return msg;
    })
  });
});

router.patch('/:id', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
  if (!title) return res.status(400).json({ error: 'Title cannot be empty.', code: 'invalid_input' });
  const { rowCount } = await pool.query(
    'UPDATE conversations SET title = $1 WHERE id = $2 AND user_id = $3',
    [title, req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Chat not found.', code: 'not_found' });
  res.json({ ok: true, title });
});

// Deleting a chat keeps any documents it produced (they stay in the library).
router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
