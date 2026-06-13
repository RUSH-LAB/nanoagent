import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// discussions.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Drive a discussions message handler with a minimal mocked ctx. `body` is what
// the handler receives from `await readBody(req)`; `saveJSON` records the
// document that would be persisted so each test can assert on it. loadJSON is
// stubbed to an in-memory `data` and saveJSON captures it, matching the existing
// next-discussions-*.test.mjs harness.
async function invoke({ method, pathname, body = {}, data }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saved = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => data,
    saveJSON: (_file, d) => { saved = d; },
    rateLimit: () => true,
    readBody: async () => body,
    sanitizeText: (s) => s,
    DISCUSSIONS_FILE: '/tmp/discussions-msgs-cache-test.json',
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, saved };
}

// A fresh store per test so POST / PATCH / DELETE never share mutable state.
function makeData() {
  return {
    channels: { general: { name: 'General', topic: 'Chat' } },
    messages: {
      general: [
        { id: 'm0', author: 'alice', text: 'first' },
        { id: 'm1', author: 'bob', text: 'second' },
      ],
    },
  };
}

const PATH = '/api/discussions/general/messages';

describe('POST /api/discussions/:channelId/messages appends via the cached channel array', () => {
  it('returns 201 and appends the message to the persisted channel', async () => {
    const data = makeData();
    const { captured, saved } = await invoke({
      method: 'POST',
      pathname: PATH,
      body: { author: 'carol', text: 'third' },
      data,
    });
    assert.equal(captured.status, 201);
    assert.equal(captured.payload.message.author, 'carol');
    assert.equal(captured.payload.message.text, 'third');
    // The persisted channel now ends with the appended message.
    assert.equal(saved.messages.general.length, 3);
    assert.equal(saved.messages.general[2].text, 'third');
    assert.deepEqual(saved.messages.general[2], captured.payload.message);
  });
});

describe('PATCH /api/discussions/:channelId/messages edits via the cached channel array', () => {
  it('returns 200 and updates the existing message text', async () => {
    const data = makeData();
    const { captured, saved } = await invoke({
      method: 'PATCH',
      pathname: PATH,
      body: { messageId: 'm1', text: 'second (edited)' },
      data,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.message.text, 'second (edited)');
    // The persisted message reflects the edit and gains an editedAt stamp.
    const stored = saved.messages.general.find(m => m.id === 'm1');
    assert.equal(stored.text, 'second (edited)');
    assert.ok(stored.editedAt);
    // The untouched message keeps its original text.
    assert.equal(saved.messages.general.find(m => m.id === 'm0').text, 'first');
  });

  it('returns 404 when the message id is not in the channel', async () => {
    const data = makeData();
    const { captured } = await invoke({
      method: 'PATCH',
      pathname: PATH,
      body: { messageId: 'missing', text: 'x' },
      data,
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Message not found');
  });
});

describe('DELETE /api/discussions/:channelId/messages removes via the cached channel array', () => {
  it('returns 200 and removes the message from the persisted channel', async () => {
    const data = makeData();
    const { captured, saved } = await invoke({
      method: 'DELETE',
      pathname: PATH,
      body: { messageId: 'm0' },
      data,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    // The persisted channel drops the deleted message, keeping the rest in order.
    assert.equal(saved.messages.general.length, 1);
    assert.equal(saved.messages.general.find(m => m.id === 'm0'), undefined);
    assert.equal(saved.messages.general[0].id, 'm1');
  });

  it('returns 404 when the message id is not in the channel', async () => {
    const data = makeData();
    const { captured } = await invoke({
      method: 'DELETE',
      pathname: PATH,
      body: { messageId: 'missing' },
      data,
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Message not found');
  });
});

describe('discussions.js caches data.messages[channelId] per handler', () => {
  it('declares const channelMessages = data.messages[channelId] in the source', () => {
    const src = readFileSync(new URL('../server/routes/discussions.js', import.meta.url), 'utf8');
    assert.ok(src.includes('const channelMessages = data.messages[channelId]'));
  });
});
