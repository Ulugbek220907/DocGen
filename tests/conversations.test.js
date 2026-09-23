const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, baseUrl, request, generate, registerUser, pool, queueAi, resetAi, sampleDoc } = require('./helpers');

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

test('a conversation keeps its messages and links to the documents it made', async () => {
  resetAi();
  const { token } = await registerUser(base);
  queueAi({ action: 'reply', message: 'Sure — what kind?', suggestions: [] });
  const first = await generate(base, token, { text: 'I need a letter' });
  const id = first.result.conversationId;
  queueAi(sampleDoc('Cover Letter'));
  await generate(base, token, { text: 'a cover letter', conversationId: id, attachments: [{ kind: 'text', name: 'cv.txt', text: 'my cv' }] });

  const list = await request(base, '/api/conversations', { token });
  assert.equal(list.body.conversations.length, 1);

  const convo = await request(base, `/api/conversations/${id}`, { token });
  assert.equal(convo.status, 200);
  assert.deepEqual(convo.body.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(convo.body.messages[2].attachmentNames, ['cv.txt']);
  assert.equal(convo.body.messages[3].document.title, 'Cover Letter');
  assert.equal(convo.body.messages[3].document.format, 'pdf');
});

test('rename and delete; deleting a chat keeps its documents', async () => {
  resetAi();
  const { token } = await registerUser(base);
  queueAi(sampleDoc('Keeper'));
  const gen = await generate(base, token, { text: 'make it' });
  const id = gen.result.conversationId;

  const rename = await request(base, `/api/conversations/${id}`, { method: 'PATCH', token, body: { title: 'Renamed chat' } });
  assert.equal(rename.status, 200);
  const empty = await request(base, `/api/conversations/${id}`, { method: 'PATCH', token, body: { title: ' ' } });
  assert.equal(empty.status, 400);

  const del = await request(base, `/api/conversations/${id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200);
  const gone = await request(base, `/api/conversations/${id}`, { token });
  assert.equal(gone.status, 404);

  const docs = await request(base, '/api/documents', { token });
  assert.equal(docs.body.documents.length, 1);
  assert.equal(docs.body.documents[0].conversationId, null);

  // The orphaned document can still be edited with AI (a new chat is made).
  queueAi(sampleDoc('Keeper v2', { target: 'update' }));
  const edit = await generate(base, token, { text: 'polish it', documentId: docs.body.documents[0].id });
  assert.equal(edit.result.document.title, 'Keeper v2');
  assert.ok(edit.result.conversationId);
});

test("other users' chats are invisible", async () => {
  resetAi();
  const a = await registerUser(base);
  const b = await registerUser(base);
  queueAi({ action: 'reply', message: 'hi', suggestions: [] });
  const gen = await generate(base, a.token, { text: 'hello' });
  const id = gen.result.conversationId;
  assert.equal((await request(base, `/api/conversations/${id}`, { token: b.token })).status, 404);
  assert.equal((await request(base, `/api/conversations/${id}`, { method: 'PATCH', token: b.token, body: { title: 'x' } })).status, 404);
  await request(base, `/api/conversations/${id}`, { method: 'DELETE', token: b.token });
  assert.equal((await request(base, `/api/conversations/${id}`, { token: a.token })).status, 200, 'delete by another user is a no-op');
});

test('AI replies and documents can be reported; only your own content', async () => {
  resetAi();
  const a = await registerUser(base);
  const b = await registerUser(base);
  queueAi(sampleDoc('Report me'));
  const gen = await generate(base, a.token, { text: 'make a doc' });

  const noReason = await request(base, '/api/reports', { method: 'POST', token: a.token, body: { messageId: gen.result.messageId } });
  assert.equal(noReason.status, 400);
  const msg = await request(base, '/api/reports', { method: 'POST', token: a.token, body: { messageId: gen.result.messageId, reason: 'Offensive or harmful' } });
  assert.equal(msg.status, 201);
  const doc = await request(base, '/api/reports', { method: 'POST', token: a.token, body: { documentId: gen.result.document.id, reason: 'Inaccurate' } });
  assert.equal(doc.status, 201);
  const foreign = await request(base, '/api/reports', { method: 'POST', token: b.token, body: { messageId: gen.result.messageId, reason: 'x' } });
  assert.equal(foreign.status, 404);

  const { rows } = await pool.query('SELECT reason, content_snapshot FROM content_reports WHERE user_id = $1 ORDER BY id', [a.user.id]);
  assert.equal(rows.length, 2);
  assert.match(rows[0].content_snapshot, /Report me/);
});
