const express = require('express');
const crypto = require('crypto');
const pool = require('./db-pool');
const requireAuth = require('./require-auth');

const router = express.Router();
router.use(requireAuth);

// Matches the cap the old localStorage version used, so the sidebar behaves
// the same either way.
const MAX_CONVERSATIONS = 40;

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
      [req.userId, MAX_CONVERSATIONS]
    );
    res.json({ conversations: rows.map(r => ({ id: r.id, title: r.title, updatedAt: r.updated_at })) });
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Could not load conversation history.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const title = (req.body?.title || 'New conversation').slice(0, 200);
    const id = 'conv_' + crypto.randomBytes(12).toString('hex');
    await pool.query('INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, $3)', [id, req.userId, title]);
    res.status(201).json({ id, title });
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Could not start a new conversation.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const convo = await pool.query(
      'SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!convo.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });

    const messages = await pool.query(
      'SELECT role, content, attachment_names, file_info, document_schema, document_format FROM messages WHERE conversation_id = $1 ORDER BY id',
      [req.params.id]
    );

    res.json({
      id: convo.rows[0].id,
      title: convo.rows[0].title,
      messages: messages.rows.map(m => ({
        role: m.role,
        content: m.content,
        attachmentNames: m.attachment_names || undefined,
        fileInfo: m.file_info || undefined,
        documentSchema: m.document_schema || undefined,
        documentFormat: m.document_format || undefined
      }))
    });
  } catch (err) {
    console.error('Get conversation error:', err);
    res.status(500).json({ error: 'Could not load that conversation.' });
  }
});

router.post('/:id/messages', async (req, res) => {
  try {
    const convo = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!convo.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });

    const { role, content, attachmentNames, fileInfo, documentSchema, format } = req.body || {};
    if (role !== 'user' && role !== 'assistant') {
      return res.status(400).json({ error: 'Invalid message role.' });
    }

    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, attachment_names, file_info, document_schema, document_format)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.params.id,
        role,
        content || '',
        attachmentNames && attachmentNames.length ? attachmentNames : null,
        fileInfo ? JSON.stringify(fileInfo) : null,
        documentSchema ? JSON.stringify(documentSchema) : null,
        format || null
      ]
    );
    await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Save message error:', err);
    res.status(500).json({ error: 'Could not save that message.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete conversation error:', err);
    res.status(500).json({ error: 'Could not delete that conversation.' });
  }
});

module.exports = router;
