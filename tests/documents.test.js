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

async function makeDoc(token, title, text = 'make a document') {
  resetAi();
  queueAi(sampleDoc(title));
  const gen = await generate(base, token, { text, format: 'pdf' });
  return gen.result;
}

test('library lists, searches and opens documents', async () => {
  const { token } = await registerUser(base);
  await makeDoc(token, 'Alpha Invoice');
  const beta = await makeDoc(token, 'Beta Letter');

  const list = await request(base, '/api/documents', { token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.documents.map(d => d.title), ['Beta Letter', 'Alpha Invoice'], 'newest first');
  assert.equal(list.body.documents[0].schema, undefined, 'list stays light');

  const search = await request(base, '/api/documents?q=alpha', { token });
  assert.deepEqual(search.body.documents.map(d => d.title), ['Alpha Invoice']);
  const body = await request(base, '/api/documents?q=services', { token });
  assert.equal(body.body.documents.length, 2, 'search looks inside the content too');
  const wild = await request(base, '/api/documents?q=%25', { token });
  assert.equal(wild.body.documents.length, 0, 'LIKE wildcards are escaped');

  const one = await request(base, `/api/documents/${beta.document.id}`, { token });
  assert.equal(one.body.document.schema.title, 'Beta Letter');
  assert.equal(one.body.document.schema.sections.length, 2);
});

test('manual edits are normalised and saved; title and format can change', async () => {
  const { token } = await registerUser(base);
  const { document: doc } = await makeDoc(token, 'Draft');
  const patch = await request(base, `/api/documents/${doc.id}`, {
    method: 'PATCH', token,
    body: { format: 'xlsx', schema: { title: 'Final', sections: [{ heading: 'One', paragraphs: ['Hi', 5], bullets: 'nope', table: { headers: ['A'], rows: [['1', '2']] } }], junk: true } }
  });
  assert.equal(patch.status, 200);
  const saved = patch.body.document;
  assert.equal(saved.title, 'Final');
  assert.equal(saved.format, 'xlsx');
  assert.deepEqual(saved.schema.sections[0].paragraphs, ['Hi', '5']);
  assert.deepEqual(saved.schema.sections[0].bullets, []);
  assert.deepEqual(saved.schema.sections[0].table.headers, ['A', ''], 'ragged table is squared up');
  assert.equal(saved.schema.junk, undefined);

  const rename = await request(base, `/api/documents/${doc.id}`, { method: 'PATCH', token, body: { title: 'Renamed' } });
  assert.equal(rename.body.document.title, 'Renamed');
  assert.equal(rename.body.document.schema.title, 'Renamed');

  const bad = await request(base, `/api/documents/${doc.id}`, { method: 'PATCH', token, body: { format: 'exe' } });
  assert.equal(bad.status, 400);
});

test('duplicate and delete', async () => {
  const { token } = await registerUser(base);
  const { document: doc } = await makeDoc(token, 'Original');
  const dup = await request(base, `/api/documents/${doc.id}/duplicate`, { method: 'POST', token });
  assert.equal(dup.status, 201);
  assert.equal(dup.body.document.title, 'Original (copy)');
  assert.notEqual(dup.body.document.id, doc.id);

  const del = await request(base, `/api/documents/${doc.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200);
  const gone = await request(base, `/api/documents/${doc.id}`, { token });
  assert.equal(gone.status, 404);
  const list = await request(base, '/api/documents', { token });
  assert.equal(list.body.documents.length, 1);
});

test('importing a document from an old chat links the message so it is imported once', async () => {
  const { token, user } = await registerUser(base);
  const { rows: [convo] } = await pool.query("INSERT INTO conversations (id, user_id, title) VALUES ('conv_legacy_' || md5(random()::text), $1, 'Old chat') RETURNING id", [user.id]);
  const { rows: [msg] } = await pool.query(
    "INSERT INTO messages (conversation_id, role, content, document_schema, document_format) VALUES ($1, 'assistant', 'Here you go', $2, 'docx') RETURNING id",
    [convo.id, JSON.stringify({ title: 'Legacy CV', sections: [{ heading: 'Skills', bullets: ['JS'] }] })]
  );

  const before = await request(base, `/api/conversations/${convo.id}`, { token });
  const legacyMsg = before.body.messages.find(m => m.id === msg.id);
  assert.equal(legacyMsg.legacyDocument.format, 'docx');
  assert.equal(legacyMsg.legacyDocument.schema.title, 'Legacy CV');

  const imported = await request(base, '/api/documents', {
    method: 'POST', token,
    body: { schema: legacyMsg.legacyDocument.schema, format: 'docx', conversationId: convo.id, messageId: msg.id }
  });
  assert.equal(imported.status, 201);

  const afterImport = await request(base, `/api/conversations/${convo.id}`, { token });
  const linked = afterImport.body.messages.find(m => m.id === msg.id);
  assert.equal(linked.document.id, imported.body.document.id);
  assert.equal(linked.legacyDocument, undefined);

  const empty = await request(base, '/api/documents', { method: 'POST', token, body: { schema: {} } });
  assert.equal(empty.status, 400);
});

test("other users' documents are invisible", async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const { document: doc } = await makeDoc(a.token, 'Secret');
  for (const [method, path] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/duplicate']]) {
    const r = await request(base, `/api/documents/${doc.id}${path}`, { method, token: b.token, body: method === 'PATCH' ? { title: 'pwned' } : undefined });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  const list = await request(base, '/api/documents', { token: b.token });
  assert.equal(list.body.documents.length, 0);
});
