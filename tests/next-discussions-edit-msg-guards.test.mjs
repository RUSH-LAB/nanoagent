import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load the REAL route module the way the sibling
// server route tests do, so these cases exercise the shipped PATCH edit handler
// instead of a reimplementation.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

const PATH = '/api/discussions/general/messages';

// A fresh store per test so no case pollutes another through shared mutable
// state. The 'general' channel exists and holds two messages.
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

// Drive the PATCH /api/discussions/:channelId/messages edit handler with a
// minimal mocked ctx. `body` is what the handler receives from
// `await readBody(req)`. The recorders capture the response payload, the
// persisted document, and how many times readBody / saveJSON ran, so each test
// can assert both the status and the side effects. loadJSON is stubbed to an
// in-memory `data`, matching the existing next-discussions-*.test.mjs harness.
async function invoke({ method = 'PATCH', pathname = PATH, body = {}, data = makeData(), rateLimitOk = true } = {}) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saved = null;
  let saveCount = 0;
  let readBodyCount = 0;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => data,
    saveJSON: (_file, d) => { saved = d; saveCount += 1; },
    rateLimit: () => rateLimitOk,
    readBody: async () => { readBodyCount += 1; return body; },
    sanitizeText: (s) => s,
    DISCUSSIONS_FILE: '/tmp/discussions-edit-msg-guards-test.json',
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, saved, saveCount, readBodyCount };
}

describe('PATCH /api/discussions/:channelId/messages edit guards (current behavior)', () => {
  it('returns 429 and never reads the body or saves when rate limited', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      body: { messageId: 'm1', text: 'edited' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    // The rate-limit guard returns before the try block, so the body stays unread.
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 Invalid channel id and never reads the body for a malformed channel id', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      pathname: '/api/discussions/%E0%A4%A/messages',
      body: { messageId: 'm1', text: 'edited' },
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid channel id');
    // The decode guard runs before loadJSON and readBody, so the body stays unread.
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 404 Channel not found before reading the body for an unknown channel', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      pathname: '/api/discussions/ghost/messages',
      body: { messageId: 'm1', text: 'edited' },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Channel not found');
    // The channel-existence guard runs before readBody, so the body stays unread.
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 when messageId is omitted', async () => {
    const { captured, saveCount } = await invoke({ body: { text: 'edited' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid messageId');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when messageId is a non-string', async () => {
    const { captured, saveCount } = await invoke({ body: { messageId: 42, text: 'edited' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid messageId');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text is omitted', async () => {
    const { captured, saveCount } = await invoke({ body: { messageId: 'm1' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid text');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text is a non-string', async () => {
    const { captured, saveCount } = await invoke({ body: { messageId: 'm1', text: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid text');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text exceeds 5000 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { messageId: 'm1', text: 'a'.repeat(5001) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Message text must be 5000 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('accepts text of exactly 5000 characters and saves once (guard is > 5000)', async () => {
    const text = 'a'.repeat(5000);
    const { captured, saved, saveCount } = await invoke({ body: { messageId: 'm1', text } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(saveCount, 1);
    // The boundary-length text is persisted on the edited message.
    assert.equal(saved.messages.general.find(m => m.id === 'm1').text.length, 5000);
  });

  it('returns 404 No messages in channel when the channel has no message array', async () => {
    const { captured, saveCount } = await invoke({
      body: { messageId: 'm1', text: 'edited' },
      data: { channels: { general: { name: 'General' } }, messages: {} },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'No messages in channel');
    assert.equal(saveCount, 0);
  });

  it('returns 404 Message not found when the channel array has no matching message', async () => {
    const { captured, saveCount } = await invoke({ body: { messageId: 'missing', text: 'edited' } });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Message not found');
    assert.equal(saveCount, 0);
  });

  it('returns 200 and saves exactly once on a valid edit', async () => {
    const { captured, saved, saveCount } = await invoke({
      body: { messageId: 'm1', text: 'second (edited)' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.message.text, 'second (edited)');
    assert.equal(saveCount, 1);
    // The edit lands on the target message and leaves its sibling untouched.
    const stored = saved.messages.general.find(m => m.id === 'm1');
    assert.equal(stored.text, 'second (edited)');
    assert.equal(typeof stored.editedAt, 'string');
    assert.equal(saved.messages.general.find(m => m.id === 'm0').text, 'first');
  });
});
