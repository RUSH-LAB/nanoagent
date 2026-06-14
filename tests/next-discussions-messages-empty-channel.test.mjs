import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Invoke a discussions route handler with a minimal mocked ctx and capture the
// response the handler hands to `json(res, status, payload)`. Mirrors the helper
// in tests/next-discussions-channel-hasown-guard.test.mjs.
async function invoke({ method = 'GET', pathname, ctx = {} }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    ...ctx,
  };
  await discussionsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

// Build a ctx whose loadJSON returns the given in-memory discussions store. The
// GET messages handler reads only loadJSON(DISCUSSIONS_FILE) plus the captured
// json, so this is the entire surface the handler touches.
function ctxFor(store) {
  return { loadJSON: () => store, DISCUSSIONS_FILE: '/tmp/discussions-empty-channel-test.json' };
}

// Characterization test for the empty-channel fallback in the GET messages
// handler (server/routes/discussions.js, near line 70). It computes
//   const all = (data.messages || {})[channelId] || [];
// then returns {messages: paginated, total: all.length}. The own-property 404
// guard already has coverage for a populated real channel and for prototype
// keys, but neither existing case reaches the `|| []` empty fallback: a channel
// that EXISTS in data.channels yet has no array in data.messages. Both empty
// shapes below resolve `all` to a fresh [] and must yield {messages: [], total: 0}.
describe('GET /api/discussions/:channelId/messages empty-channel fallback', () => {
  it('returns {messages: [], total: 0} when the channel exists but has no messages key', async () => {
    // The channel is present in data.channels, so the own-property guard passes
    // (no 404), but data.messages is a real object with no entry for it. Another
    // channel carries messages to prove the fallback keys on this channel rather
    // than firing only when the whole messages object is empty.
    const store = {
      channels: { general: { name: 'General', topic: 'Chat' } },
      messages: { announcements: [{ id: 'a0', author: 'sys', text: 'welcome' }] },
    };
    const r = await invoke({ pathname: '/api/discussions/general/messages', ctx: ctxFor(store) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { messages: [], total: 0 });
  });

  it('returns {messages: [], total: 0} when the messages object is absent entirely', async () => {
    // No `messages` property at all, so the `data.messages || {}` guard fires
    // before the keyed lookup. The channel still exists, so the request reaches
    // the empty fallback rather than the 404 branch.
    const store = {
      channels: { general: { name: 'General', topic: 'Chat' } },
    };
    const r = await invoke({ pathname: '/api/discussions/general/messages', ctx: ctxFor(store) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { messages: [], total: 0 });
  });

  it('positive control: a populated channel still returns its messages so the empty case is not vacuous', async () => {
    const store = {
      channels: { general: { name: 'General', topic: 'Chat' } },
      messages: {
        general: [
          { id: 'm0', author: 'alice', text: 'hello world' },
          { id: 'm1', author: 'bob', text: 'second message' },
        ],
      },
    };
    const r = await invoke({ pathname: '/api/discussions/general/messages', ctx: ctxFor(store) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      messages: [
        { id: 'm0', author: 'alice', text: 'hello world' },
        { id: 'm1', author: 'bob', text: 'second message' },
      ],
      total: 2,
    });
  });
});
