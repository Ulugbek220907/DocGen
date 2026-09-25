const express = require('express');
const crypto = require('crypto');
const pool = require('./db-pool');
const requireAuth = require('./require-auth');
const config = require('./config');
const ai = require('./ai');
const DocSchema = require('./public/js/doc-schema');
const { buildSystemPrompt, parseModelResponse, ModelOutputError } = require('./prompt');
const { getUsageStatus, recordGeneration } = require('./usage');
const { createLimiter, byUser } = require('./rate-limit');

const router = express.Router();

const MAX_TEXT = 8000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_TEXT = 20000;
const MAX_IMAGE_DATA_URL = 4 * 1024 * 1024;
const HISTORY_MESSAGES = 20;

const perMinute = createLimiter({ windowMs: 60 * 1000, max: 12, keyFn: byUser, message: 'You are sending messages too quickly. Please wait a few seconds.' });
const perDay = createLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 400, keyFn: byUser, message: 'Daily message limit reached. Please try again tomorrow.' });

class InputError extends Error {}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function validateBody(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > MAX_TEXT) throw new InputError(`Your message is too long (max ${MAX_TEXT} characters).`);

  const format = DocSchema.isFormat(body.format) ? body.format : 'pdf';

  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENTS) throw new InputError(`You can attach up to ${MAX_ATTACHMENTS} files at a time.`);

  const attachments = rawAttachments.map(a => {
    const name = String(a?.name || 'file').slice(0, 200);
    if (a?.kind === 'image') {
      if (!config.ai.vision) throw new InputError('Image attachments are not supported by the current AI model.');
      const dataUrl = String(a.dataUrl || '');
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) throw new InputError(`"${name}" is not a supported image.`);
      if (dataUrl.length > MAX_IMAGE_DATA_URL) throw new InputError(`"${name}" is too large.`);
      return { kind: 'image', name, dataUrl };
    }
    const content = String(a?.text || '');
    return { kind: 'text', name, text: content.slice(0, MAX_ATTACHMENT_TEXT), truncated: content.length > MAX_ATTACHMENT_TEXT };
  });

  if (!text && attachments.length === 0) throw new InputError('Type a message or attach a file.');

  return {
    text,
    format,
    attachments,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
    documentId: typeof body.documentId === 'string' ? body.documentId : null
  };
}

function userContentForModel(input) {
  let text = input.text;
  for (const a of input.attachments.filter(x => x.kind === 'text')) {
    text += `\n\n--- Attached file: ${a.name}${a.truncated ? ' (truncated)' : ''} ---\n${a.text}\n--- end of ${a.name} ---`;
  }
  const images = input.attachments.filter(x => x.kind === 'image');
  if (!text.trim() && images.length) text = 'Please look at the attached image(s).';
  if (!images.length) return text;
  return [
    { type: 'text', text },
    ...images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } }))
  ];
}

// Consecutive messages from the same role are merged — some OpenAI-compatible
// providers reject them, and a failed request mid-conversation would
// otherwise leave two user messages in a row.
function toModelHistory(rows) {
  const out = [];
  for (const row of rows) {
    const role = row.role === 'assistant' ? 'assistant' : 'user';
    let content = row.content || '';
    if (row.attachment_names?.length) content += `\n[Attached: ${row.attachment_names.join(', ')}]`;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  return out;
}

function progressReporter(send) {
  let last = 0;
  let stage = '';
  return (textSoFar) => {
    let next = stage;
    if (!stage && /"action"\s*:\s*"reply"/.test(textSoFar)) next = 'reply';
    else if (!stage && /"action"\s*:\s*"generate"/.test(textSoFar)) next = 'plan';
    else if (stage === 'plan' && /"sections"\s*:/.test(textSoFar)) next = 'write';

    const now = Date.now();
    if (next !== stage) {
      stage = next;
      last = now;
      if (stage === 'reply') send('status', { text: 'Writing a reply…' });
      if (stage === 'plan') send('status', { text: 'Planning your document…' });
      if (stage === 'write') send('status', { text: 'Writing the content…' });
    } else if (stage === 'write' && now - last > 700) {
      last = now;
      const words = textSoFar.split(/\s+/).length;
      send('status', { text: `Writing the content… ${words} words`, progress: words });
    }
  };
}

async function runModel(messages, { send, signal }) {
  let nudge = null;
  for (let attempt = 1; ; attempt++) {
    const convo = nudge ? [...messages, { role: 'user', content: nudge }] : messages;
    try {
      const { text, finishReason } = await ai.streamChat({ messages: convo, onDelta: progressReporter(send), signal });
      if (finishReason === 'length') {
        throw new ModelOutputError('The answer was cut off because it was too long.');
      }
      return parseModelResponse(text);
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof ModelOutputError && attempt < 3) {
        send('status', { text: 'Polishing the result…' });
        nudge = /cut off/.test(err.message)
          ? 'Your previous answer was cut off because it was too long. Answer again with the complete json, keeping the document more concise so it fits.'
          : `Your previous answer was invalid (${err.message}). Answer again with ONLY one valid json object in the required format, with the complete content filled in.`;
        continue;
      }
      if (err instanceof ai.AiError && err.retryable && attempt < 3) {
        send('status', { text: 'The AI is busy, retrying…' });
        await new Promise(r => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw err;
    }
  }
}

function publicDocument(row) {
  return {
    id: row.id,
    title: row.title,
    format: row.format,
    schema: row.schema,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

router.post('/', requireAuth, perMinute, perDay, async (req, res) => {
  let input;
  try {
    input = validateBody(req.body || {});
  } catch (err) {
    if (err instanceof InputError) return res.status(400).json({ error: err.message, code: 'invalid_input' });
    throw err;
  }

  const usage = await getUsageStatus(req.userId);
  if (!usage) return res.status(401).json({ error: 'Your account no longer exists. Please sign in again.', code: 'unauthorized' });
  if (usage.remaining !== Infinity && usage.remaining <= 0) {
    return res.status(402).json({
      error: `You’ve used all ${usage.limit} free documents for this month.`,
      code: 'quota_exceeded',
      upgradeRequired: true,
      limit: usage.limit,
      resetsAt: usage.resetsAt
    });
  }

  // --- conversation and the document being worked on ---
  let conversationId = input.conversationId;
  if (conversationId) {
    const { rows } = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'That chat no longer exists.', code: 'not_found' });
  }

  let targetDoc = null;
  if (input.documentId) {
    const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [input.documentId, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'That document no longer exists.', code: 'not_found' });
    targetDoc = rows[0];
    if (!conversationId && targetDoc.conversation_id) {
      const owned = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [targetDoc.conversation_id, req.userId]);
      if (owned.rows[0]) conversationId = targetDoc.conversation_id;
    }
  } else if (conversationId) {
    const { rows } = await pool.query(
      'SELECT * FROM documents WHERE conversation_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 1',
      [conversationId, req.userId]
    );
    targetDoc = rows[0] || null;
  }

  let history = [];
  const newConversation = !conversationId;
  if (conversationId) {
    const { rows } = await pool.query(
      'SELECT role, content, attachment_names FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2',
      [conversationId, HISTORY_MESSAGES]
    );
    history = toModelHistory(rows.reverse());
  } else {
    conversationId = newId('conv');
    const title = (input.text || input.attachments[0]?.name || 'New chat').replace(/\s+/g, ' ').slice(0, 80);
    await pool.query('INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, $3)', [conversationId, req.userId, title]);
  }

  const displayText = input.text || (input.attachments.length ? 'Attached file(s)' : '');
  await pool.query(
    'INSERT INTO messages (conversation_id, role, content, attachment_names) VALUES ($1, $2, $3, $4)',
    [conversationId, 'user', displayText, input.attachments.length ? input.attachments.map(a => a.name) : null]
  );

  const modelMessages = [
    { role: 'system', content: buildSystemPrompt({ defaultFormat: input.format, currentDocument: targetDoc ? { format: targetDoc.format, schema: targetDoc.schema } : null, userText: input.text }) },
    ...history,
    { role: 'user', content: userContentForModel(input) }
  ];

  // --- stream progress to the client as server-sent events ---
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);

  send('meta', { conversationId });
  send('status', { text: 'Thinking…' });

  try {
    const result = await runModel(modelMessages, { send, signal: controller.signal });

    if (result.action === 'reply') {
      const { rows } = await pool.query(
        'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id',
        [conversationId, 'assistant', result.message]
      );
      await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      send('result', { action: 'reply', message: result.message, messageId: rows[0].id, conversationId });
    } else {
      const isUpdate = !!targetDoc && (!!input.documentId || result.target === 'update');
      const explicit = isUpdate ? DocSchema.detectConversion(input.text) : DocSchema.detectExplicitFormat(input.text);
      const format = explicit || (isUpdate ? targetDoc.format : input.format);
      const title = result.document.title;

      let docRow;
      if (isUpdate) {
        const { rows } = await pool.query(
          `UPDATE documents SET title = $1, format = $2, schema = $3, updated_at = now()
            WHERE id = $4 AND user_id = $5 RETURNING *`,
          [title, format, JSON.stringify(result.document), targetDoc.id, req.userId]
        );
        docRow = rows[0];
      } else {
        const { rows } = await pool.query(
          `INSERT INTO documents (id, user_id, conversation_id, title, format, schema)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [newId('doc'), req.userId, conversationId, title, format, JSON.stringify(result.document)]
        );
        docRow = rows[0];
      }

      await recordGeneration(req.userId);

      const message = result.message || (isUpdate ? `Updated “${title}”.` : `Here's your ${format.toUpperCase()}: “${title}”.`);
      const { rows: msgRows } = await pool.query(
        'INSERT INTO messages (conversation_id, role, content, document_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [conversationId, 'assistant', message, docRow.id]
      );
      // A chat that starts with a document is named after it ("Monthly Budget"
      // reads better in the history than the first message).
      let conversationTitle = null;
      if (newConversation) {
        conversationTitle = title.slice(0, 120);
        await pool.query('UPDATE conversations SET title = $1, updated_at = now() WHERE id = $2', [conversationTitle, conversationId]);
      } else {
        await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      }

      const usageAfter = await getUsageStatus(req.userId);
      send('result', {
        action: 'generate',
        updated: isUpdate,
        message,
        suggestions: result.suggestions,
        document: publicDocument(docRow),
        messageId: msgRows[0].id,
        conversationId,
        conversationTitle,
        usage: {
          plan: usageAfter.plan,
          usageCount: usageAfter.usageCount,
          limit: usageAfter.limit === Infinity ? null : usageAfter.limit,
          remaining: usageAfter.remaining === Infinity ? null : usageAfter.remaining
        }
      });
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[generate] failed:', err.message);
      const message = err instanceof ai.AiError || err instanceof ModelOutputError
        ? `${err.message} Please try again.`
        : 'Something went wrong while generating. Please try again.';
      send('error', { message, code: 'generation_failed' });
    }
  } finally {
    clearInterval(heartbeat);
    send('done', {});
    res.end();
  }
});

module.exports = router;
module.exports.publicDocument = publicDocument;
