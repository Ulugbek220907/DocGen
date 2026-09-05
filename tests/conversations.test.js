const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, uniqueEmail, registerUser } = require('./helpers');

test('conversations: CRUD, ownership isolation, and document schema round-trip', async (t) => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  t.after(() => server.close());

  const { token } = await registerUser(base, { email: uniqueEmail('conv') });
  const auth = { Authorization: `Bearer ${token}` };

  let conversationId;

  await t.test('creates a conversation', async () => {
    const { status, body } = await request(base, '/api/conversations', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Invoice for Acme' })
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    conversationId = body.id;
  });

  await t.test('appears in the list, most recent first', async () => {
    const { status, body } = await request(base, '/api/conversations', { headers: auth });
    assert.equal(status, 200);
    assert.ok(body.conversations.some(c => c.id === conversationId));
  });

  await t.test('stores messages, including the document schema needed to rebuild a download', async () => {
    await request(base, `/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ role: 'user', content: 'Make an invoice for $500' })
    });
    await request(base, `/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        role: 'assistant',
        content: '[Generated PDF document: invoice.pdf]',
        fileInfo: { filename: 'invoice.pdf', format: 'pdf' },
        documentSchema: { title: 'Invoice', sections: [{ heading: '', paragraphs: ['Amount: $500'] }] },
        format: 'pdf'
      })
    });

    const { status, body } = await request(base, `/api/conversations/${conversationId}`, { headers: auth });
    assert.equal(status, 200);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[1].fileInfo.filename, 'invoice.pdf');
    assert.equal(body.messages[1].documentFormat, 'pdf');
    assert.deepEqual(body.messages[1].documentSchema.sections[0].paragraphs, ['Amount: $500']);
  });

  await t.test('rejects an invalid message role', async () => {
    const { status } = await request(base, `/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ role: 'system', content: 'nope' })
    });
    assert.equal(status, 400);
  });

  await t.test("another user can't read, post to, or delete this conversation", async () => {
    const { token: otherToken } = await registerUser(base, { email: uniqueEmail('conv-other') });
    const otherAuth = { Authorization: `Bearer ${otherToken}` };

    const get = await request(base, `/api/conversations/${conversationId}`, { headers: otherAuth });
    assert.equal(get.status, 404);

    const post = await request(base, `/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: otherAuth,
      body: JSON.stringify({ role: 'user', content: 'sneaky' })
    });
    assert.equal(post.status, 404);

    await request(base, `/api/conversations/${conversationId}`, { method: 'DELETE', headers: otherAuth });
    const stillThere = await request(base, `/api/conversations/${conversationId}`, { headers: auth });
    assert.equal(stillThere.status, 200); // the other user's delete was a silent no-op, not a real delete
  });

  await t.test('the owner can delete it', async () => {
    const del = await request(base, `/api/conversations/${conversationId}`, { method: 'DELETE', headers: auth });
    assert.equal(del.status, 200);

    const get = await request(base, `/api/conversations/${conversationId}`, { headers: auth });
    assert.equal(get.status, 404);
  });

  await t.test('every conversations endpoint requires auth', async () => {
    const noAuth = await request(base, '/api/conversations');
    assert.equal(noAuth.status, 401);
  });
});
