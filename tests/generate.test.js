const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, baseUrl, request, generate, registerUser, pool, queueAi, resetAi, aiCalls, sampleDoc } = require('./helpers');
const { AiError } = require('../ai');

let server;
let base;

before(async () => {
  server = await startServer();
  base = baseUrl(server);
});
after(async () => {
  server.close();
  await pool.end();
});
beforeEach(() => resetAi());

async function usageCount(userId) {
  const { rows } = await pool.query('SELECT monthly_usage_count FROM users WHERE id = $1', [userId]);
  return rows[0].monthly_usage_count;
}

test('requires sign-in', async () => {
  const r = await request(base, '/api/generate', { method: 'POST', body: { text: 'hi' } });
  assert.equal(r.status, 401);
});

test('rejects empty and oversized input before calling the AI', async () => {
  const { token } = await registerUser(base);
  const empty = await generate(base, token, { text: '  ' });
  assert.equal(empty.status, 400);
  const long = await generate(base, token, { text: 'x'.repeat(8001) });
  assert.equal(long.status, 400);
  const badImage = await generate(base, token, { text: 'hi', attachments: [{ kind: 'image', name: 'a.png', dataUrl: 'data:text/html;base64,AAAA' }] });
  assert.equal(badImage.status, 400);
  assert.equal(aiCalls.length, 0);
});

test('a chat reply is free; a generated document is saved and counted', async () => {
  const { token, user } = await registerUser(base);

  queueAi({ action: 'reply', message: 'Hello! What should we make?', suggestions: [] });
  const reply = await generate(base, token, { text: 'hello', format: 'pdf' });
  assert.equal(reply.result.action, 'reply');
  assert.ok(reply.events.find(e => e.event === 'meta').data.conversationId);
  assert.equal(await usageCount(user.id), 0, 'replies do not use quota');

  const conversationId = reply.result.conversationId;
  queueAi(sampleDoc('Invoice #7'));
  const gen = await generate(base, token, { text: 'make an invoice', format: 'docx', conversationId });
  assert.equal(gen.result.action, 'generate');
  assert.equal(gen.result.document.title, 'Invoice #7');
  assert.equal(gen.result.document.format, 'docx', 'uses the selected format');
  assert.equal(gen.result.document.conversationId, conversationId);
  assert.equal(gen.result.usage.usageCount, 1);
  assert.equal(gen.result.usage.remaining, 9);
  assert.equal(await usageCount(user.id), 1);

  // The model saw the earlier exchange as history.
  const lastCall = aiCalls[aiCalls.length - 1];
  assert.ok(lastCall.some(m => m.role === 'assistant' && m.content.includes('What should we make')));
});

test('a new chat that starts with a document is named after it', async () => {
  const { token } = await registerUser(base);
  queueAi(sampleDoc('Monthly Budget'));
  const gen = await generate(base, token, { text: 'make a small budget spreadsheet for me please', format: 'xlsx' });
  assert.equal(gen.result.conversationTitle, 'Monthly Budget');
  const list = await request(base, '/api/conversations', { token });
  assert.equal(list.body.conversations[0].title, 'Monthly Budget');
});

test('an explicit format in the message wins over the selected one', async () => {
  const { token } = await registerUser(base);
  queueAi(sampleDoc('Report'));
  const gen = await generate(base, token, { text: 'make me a sales report as an excel file', format: 'pdf' });
  assert.equal(gen.result.document.format, 'xlsx');
});

test('editing with documentId updates the same document and sends it to the AI', async () => {
  const { token } = await registerUser(base);
  queueAi(sampleDoc('Quote'));
  const first = await generate(base, token, { text: 'make a quote', format: 'pdf' });
  const docId = first.result.document.id;

  queueAi(sampleDoc('Quote v2', { target: 'update' }));
  const edit = await generate(base, token, { text: 'rename it to v2', documentId: docId });
  assert.equal(edit.result.updated, true);
  assert.equal(edit.result.document.id, docId);
  assert.equal(edit.result.document.title, 'Quote v2');
  assert.equal(edit.result.document.format, 'pdf', 'keeps the document format');
  const system = aiCalls[aiCalls.length - 1][0].content;
  assert.match(system, /CURRENT DOCUMENT/);
  assert.match(system, /"Quote"/);

  const list = await request(base, '/api/documents', { token });
  assert.equal(list.body.documents.length, 1);
});

test('invalid model output is retried; the user is only charged for the final document', async () => {
  const { token, user } = await registerUser(base);
  queueAi('this is not json at all', sampleDoc('Recovered'));
  const gen = await generate(base, token, { text: 'make a letter' });
  assert.equal(gen.result.document.title, 'Recovered');
  assert.equal(aiCalls.length, 2);
  assert.equal(await usageCount(user.id), 1);
});

test('AI failures surface as a friendly error event and cost nothing', async () => {
  const { token, user } = await registerUser(base);
  queueAi(new AiError('The AI service is out of credit.', { status: 402, retryable: false }));
  const gen = await generate(base, token, { text: 'make a letter' });
  assert.equal(gen.result, null);
  assert.match(gen.error.message, /credit/);
  assert.equal(await usageCount(user.id), 0);
});

test('free quota: the 11th document in a month is refused with 402', async () => {
  const { token, user } = await registerUser(base);
  await pool.query('UPDATE users SET monthly_usage_count = 10 WHERE id = $1', [user.id]);
  const r = await generate(base, token, { text: 'one more please' });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'quota_exceeded');
  assert.equal(r.body.limit, 10);
  assert.ok(r.body.resetsAt);
  assert.equal(aiCalls.length, 0);

  // Pro users are not limited.
  await pool.query("UPDATE users SET plan = 'pro', plan_expires_at = now() + interval '10 days' WHERE id = $1", [user.id]);
  queueAi(sampleDoc('Pro doc'));
  const ok = await generate(base, token, { text: 'one more please' });
  assert.equal(ok.result.action, 'generate');
  assert.equal(ok.result.usage.remaining, null);

  // An expired Pro plan falls back to free.
  await pool.query("UPDATE users SET plan_expires_at = now() - interval '1 day' WHERE id = $1", [user.id]);
  const back = await generate(base, token, { text: 'and another' });
  assert.equal(back.status, 402);
});

test("can't use another user's chat or document", async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  queueAi(sampleDoc('Private'));
  const gen = await generate(base, a.token, { text: 'make a doc' });
  const other = await generate(base, b.token, { text: 'edit it', documentId: gen.result.document.id });
  assert.equal(other.status, 404);
  const otherChat = await generate(base, b.token, { text: 'hi', conversationId: gen.result.conversationId });
  assert.equal(otherChat.status, 404);
});

test('text attachments are passed to the model', async () => {
  const { token } = await registerUser(base);
  queueAi(sampleDoc('From CSV'));
  await generate(base, token, { text: 'turn this into a table', attachments: [{ kind: 'text', name: 'data.csv', text: 'a,b\n1,2' }] });
  const userMsg = aiCalls[0][aiCalls[0].length - 1];
  assert.match(userMsg.content, /data\.csv/);
  assert.match(userMsg.content, /a,b/);
});

test('the language of the message is stated to the model', async () => {
  const { detectLanguage } = require('../prompt');
  assert.equal(detectLanguage('Family budget for October in UZS with totals for each month'), 'English');
  assert.equal(detectLanguage('Menga oktyabr oyi uchun oilaviy byudjet tayyorlab bering'), 'Uzbek (Latin script)');
  assert.equal(detectLanguage('Сделай счёт на оплату для клиента'), 'Russian');
  assert.equal(detectLanguage('CV'), null);

  const { token } = await registerUser(base);
  queueAi(sampleDoc('Budget'));
  await generate(base, token, { text: 'Make a family budget for October in UZS please' });
  assert.match(aiCalls[0][0].content, /latest message is in English/);
});
