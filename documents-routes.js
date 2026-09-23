const express = require('express');
const crypto = require('crypto');
const pool = require('./db-pool');
const requireAuth = require('./require-auth');
const DocSchema = require('./public/js/doc-schema');
const { publicDocument } = require('./generate-routes');

const router = express.Router();
router.use(requireAuth);

// Library listing: newest first, optional text search over title and body.
router.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const params = [req.userId];
  let where = 'user_id = $1';
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, m => '\\' + m)}%`);
    where += ` AND (title ILIKE $2 OR schema::text ILIKE $2)`;
  }
  const { rows } = await pool.query(
    `SELECT id, title, format, conversation_id, created_at, updated_at
       FROM documents WHERE ${where}
      ORDER BY updated_at DESC LIMIT 200`,
    params
  );
  res.json({
    documents: rows.map(r => ({
      id: r.id,
      title: r.title,
      format: r.format,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  });
});

async function loadOwned(req, res) {
  const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Document not found.', code: 'not_found' });
    return null;
  }
  return rows[0];
}

router.get('/:id', async (req, res) => {
  const doc = await loadOwned(req, res);
  if (doc) res.json({ document: publicDocument(doc) });
});

// Manual edits from the editor. Any subset of title/format/schema.
router.patch('/:id', async (req, res) => {
  const doc = await loadOwned(req, res);
  if (!doc) return;

  const body = req.body || {};
  let schema = doc.schema;
  if (body.schema !== undefined) {
    schema = DocSchema.normalize(body.schema);
  }
  if (typeof body.title === 'string' && body.title.trim()) {
    schema = { ...schema, title: body.title.trim().slice(0, 300) };
  }
  let format = doc.format;
  if (body.format !== undefined) {
    if (!DocSchema.isFormat(body.format)) return res.status(400).json({ error: 'Unknown format.', code: 'invalid_input' });
    format = body.format;
  }

  const { rows } = await pool.query(
    `UPDATE documents SET title = $1, format = $2, schema = $3, updated_at = now()
      WHERE id = $4 AND user_id = $5 RETURNING *`,
    [schema.title, format, JSON.stringify(schema), doc.id, req.userId]
  );
  res.json({ document: publicDocument(rows[0]) });
});

// Saves a document that exists only client-side — used to move documents
// from chats made before the library existed into the library.
router.post('/', async (req, res) => {
  const body = req.body || {};
  const schema = DocSchema.normalize(body.schema);
  if (!DocSchema.hasContent(schema)) return res.status(400).json({ error: 'The document is empty.', code: 'invalid_input' });
  const format = DocSchema.isFormat(body.format) ? body.format : 'pdf';
  let conversationId = null;
  if (typeof body.conversationId === 'string') {
    const { rows } = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [body.conversationId, req.userId]);
    conversationId = rows[0]?.id || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO documents (id, user_id, conversation_id, title, format, schema)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [`doc_${crypto.randomBytes(12).toString('hex')}`, req.userId, conversationId, schema.title, format, JSON.stringify(schema)]
  );
  // Point the old chat message at the new library copy so it isn't imported twice.
  if (conversationId && Number.isInteger(body.messageId)) {
    await pool.query(
      'UPDATE messages SET document_id = $1 WHERE id = $2 AND conversation_id = $3 AND document_id IS NULL',
      [rows[0].id, body.messageId, conversationId]
    );
  }
  res.status(201).json({ document: publicDocument(rows[0]) });
});

router.post('/:id/duplicate', async (req, res) => {
  const doc = await loadOwned(req, res);
  if (!doc) return;
  const schema = { ...doc.schema, title: `${doc.title} (copy)`.slice(0, 300) };
  const { rows } = await pool.query(
    `INSERT INTO documents (id, user_id, conversation_id, title, format, schema)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [`doc_${crypto.randomBytes(12).toString('hex')}`, req.userId, doc.conversation_id, schema.title, doc.format, JSON.stringify(schema)]
  );
  res.status(201).json({ document: publicDocument(rows[0]) });
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Document not found.', code: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
