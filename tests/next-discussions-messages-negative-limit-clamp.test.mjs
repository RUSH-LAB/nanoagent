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

// One real channel with five messages. The page is computed as
// `all.slice(offset, offset + limit)` with offset floored at 0. A negative
// `limit` makes that `slice(0, negative)`, which counts from the END: pre-fix,
// `?limit=-1` returned the first four messages while `total` still reported 5.
// The limit is now lower-clamped at 0, so any negative limit yields an empty page.
const messages = [
  { id: 'm0', author: 'alice', text: 'first' },
  { id: 'm1', author: 'bob', text: 'second' },
  { id: 'm2', author: 'carol', text: 'third' },
  { id: 'm3', author: 'dave', text: 'fourth' },
  { id: 'm4', author: 'erin', text: 'fifth' },
];
const data = {
  channels: { general: { name: 'General', topic: 'Chat' } },
  messages: { general: messages },
};
const ctx = { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/discussions-neg-limit-test.json' };

describe('GET /api/discussions/:channelId/messages negative-limit clamp', () => {
  // Each of these would drop a non-empty tail pre-fix (slice(0, -1) keeps the
  // first four, slice(0, -3) the first two); post-fix every one is an empty page.
  for (const limit of ['-1', '-3', '-100']) {
    it(`returns an empty page for ?limit=${limit} with total unchanged`, async () => {
      const r = await invoke({
        pathname: '/api/discussions/general/messages',
        search: `?limit=${limit}`,
        ctx,
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload.messages, []);
      assert.equal(r.payload.total, messages.length);
    });
  }
});

describe('GET /api/discussions/:channelId/messages non-negative limits are unchanged', () => {
  it('returns the requested page for a valid positive limit', async () => {
    const r = await invoke({
      pathname: '/api/discussions/general/messages',
      search: '?limit=2',
      ctx,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.messages, messages.slice(0, 2));
    assert.equal(r.payload.total, messages.length);
  });

  it('returns every message when the limit is absent (default page size)', async () => {
    const r = await invoke({ pathname: '/api/discussions/general/messages', ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.messages, messages);
    assert.equal(r.payload.total, messages.length);
  });

  it('returns every message for an over-cap limit (clamped to the 1000 cap)', async () => {
    const r = await invoke({
      pathname: '/api/discussions/general/messages',
      search: '?limit=99999',
      ctx,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.messages, messages);
    assert.equal(r.payload.total, messages.length);
  });
});
