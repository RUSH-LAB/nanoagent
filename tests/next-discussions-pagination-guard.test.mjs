import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');
const { numericParam } = discussionsRoutes;

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

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof discussionsRoutes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });

  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 200, 1000), 200);
    assert.equal(numericParam('', 200, 1000), 200);
  });

  it('returns the default for non-numeric values instead of NaN', () => {
    assert.equal(numericParam('abc', 200, 1000), 200);
    assert.ok(!Number.isNaN(numericParam('abc', 200, 1000)), 'never yields NaN');
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('50', 200, 1000), 50);
    assert.equal(numericParam('0', 200, 1000), 0);
  });

  it('clamps valid numeric values above the cap to 1000', () => {
    assert.equal(numericParam('5000', 200, 1000), 1000);
    assert.equal(numericParam('1000', 200, 1000), 1000);
  });
});

describe('GET /api/discussions/:channelId/messages pagination guard', () => {
  // 250 identifiable messages: more than the default page (200) so the default
  // and the non-numeric fallback are both observable and distinguishable from
  // the broken NaN path, which slices to an empty page.
  const messages = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, text: `message ${i}` }));
  const data = {
    channels: { general: { name: 'General' } },
    messages: { general: messages },
  };
  const ctx = { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/discussions-guard-test.json' };
  const call = search => invoke({ pathname: '/api/discussions/general/messages', search, ctx });

  it('absent limit and offset return the default-sized page from the start', async () => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.messages.length, 200, 'default limit is 200');
    assert.equal(r.payload.messages[0].id, 'm0', 'default offset is 0');
  });

  it('valid limit is honored', async () => {
    const r = await call('?limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.messages.length, 10);
    assert.equal(r.payload.messages[0].id, 'm0');
  });

  it('valid offset is honored', async () => {
    const r = await call('?offset=5&limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.messages.length, 10);
    assert.equal(r.payload.messages[0].id, 'm5');
    assert.equal(r.payload.messages[9].id, 'm14');
  });

  it('over-cap limit clamps to 1000 (returns the whole list, never breaks)', async () => {
    const r = await call('?limit=5000');
    assert.equal(r.status, 200);
    assert.equal(r.payload.messages.length, 250, 'clamped limit still covers all 250 messages');
  });

  it('non-numeric limit falls back to the default instead of emptying the page', async () => {
    const r = await call('?limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.messages.length, 200, 'guarded to default 200, not an empty NaN slice');
    assert.equal(r.payload.messages[0].id, 'm0');
  });

  it('non-numeric offset falls back to 0 instead of emptying the page', async () => {
    const r = await call('?offset=abc&limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.messages.length, 10, 'guarded to offset 0, not an empty NaN slice');
    assert.equal(r.payload.messages[0].id, 'm0');
  });
});
