import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Invoke a discussions route handler with a minimal mocked ctx and capture the
// response that the handler hands to `json(res, status, payload)`.
async function invoke({ method = 'GET', pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
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

// A small store with one real channel. `channelId` in every read handler is
// `decodeURIComponent(parts[3])`, so a request for `__proto__` or `constructor`
// hands a prototype key to the existence check.
const data = {
  channels: { general: { name: 'General', topic: 'Chat' } },
  messages: {
    general: [
      { id: 'm0', author: 'alice', text: 'hello world' },
      { id: 'm1', author: 'bob', text: 'second message' },
    ],
  },
};
const ctx = { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/discussions-hasown-test.json' };

describe('GET /api/discussions/:channelId/messages prototype-key guard', () => {
  // With the old truthy check `!data.channels[channelId]`, a prototype key
  // resolves to an inherited member, bypasses the 404, and then
  // `all.slice(...)` throws because `data.messages[channelId]` is not an array.
  // The read handlers have no try/catch, so the request would hang. The
  // own-property check now returns a clean 404 for every prototype key.
  for (const key of ['__proto__', 'constructor']) {
    it(`returns 404 for the "${key}" channel without throwing`, async () => {
      const r = await invoke({ pathname: `/api/discussions/${key}/messages`, ctx });
      assert.equal(r.status, 404);
      assert.equal(r.payload.error, 'Channel not found');
    });
  }
});

describe('GET /api/discussions/:channelId/messages/search prototype-key guard', () => {
  it('returns 404 for the "__proto__" channel without throwing', async () => {
    const r = await invoke({
      pathname: '/api/discussions/__proto__/messages/search',
      search: '?q=hello',
      ctx,
    });
    assert.equal(r.status, 404);
    assert.equal(r.payload.error, 'Channel not found');
  });
});

describe('real channels are unchanged by the guard', () => {
  it('returns the identical messages payload for a real channel', async () => {
    const r = await invoke({ pathname: '/api/discussions/general/messages', ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      messages: [
        { id: 'm0', author: 'alice', text: 'hello world' },
        { id: 'm1', author: 'bob', text: 'second message' },
      ],
      total: 2,
    });
  });

  it('search still matches messages in a real channel', async () => {
    const r = await invoke({
      pathname: '/api/discussions/general/messages/search',
      search: '?q=hello',
      ctx,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      results: [{ id: 'm0', author: 'alice', text: 'hello world' }],
      total: 1,
    });
  });
});
