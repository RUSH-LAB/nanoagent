import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load it the way the sibling ctx-injection suites
// do (next-recommendv2-cache) and reuse their ctx-mocking shape. This drives
// POST /api/recommendations/add directly with a recording invalidateCache, an
// in-memory bibliography read, and a noop write, so there is no network and no
// real filesystem touched.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/research-tools.js');

const PROJECT_ROOT = '/proj';

// Invoke the recommendations/add handler with a mocked ctx and capture both the
// response handed to json(res, status, payload) and an ordered event log so a
// test can prove the stats cache is invalidated AFTER the bibliography write.
async function invoke({ body, ctx = {} }) {
  const pathname = '/api/recommendations/add';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };

  let captured = null;
  const events = [];
  const invalidateCalls = [];

  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => body,
    rateLimit: () => true,
    sanitizeText: s => s,
    invalidateCache(tag) { invalidateCalls.push(tag); events.push(`invalidate:${tag}`); },
    fs: {
      readFileSync: () => '{}',
      writeFileSync: () => { events.push('write'); },
    },
    path,
    PROJECT_ROOT,
    ...ctx,
  };

  await routes(req, res, url, pathname, fullCtx);
  return { captured, events, invalidateCalls };
}

describe('POST /api/recommendations/add invalidates the stats cache', () => {
  it('returns 201 and invalidates the "stats" cache after a successful write', async () => {
    const { captured, events, invalidateCalls } = await invoke({
      body: { title: 'A New Paper', authors: ['Jane Doe'], year: 2024 },
    });

    assert.equal(captured.status, 201);
    assert.equal(captured.payload.success, true);
    assert.equal(typeof captured.payload.key, 'string');

    // The core invariant the fix establishes: the handler must invalidate the
    // 30s content-stats cache so GET /api/stats does not report a stale
    // references count. Pre-fix this assertion fails (no invalidation happens).
    assert.ok(invalidateCalls.includes('stats'), "expected invalidateCache('stats') to be called");

    // It must invalidate AFTER the bibliography write, mirroring the import-bibtex
    // sibling, so a write that throws never reports a fresh cache.
    assert.deepEqual(events, ['write', 'invalidate:stats']);
  });

  it('does not invalidate the cache when the request is rejected (no write)', async () => {
    // A missing title is a 400 before any write; the cache must not be touched on
    // a failure path, proving the invalidation is tied to a real write.
    const { captured, events, invalidateCalls } = await invoke({
      body: { authors: ['Jane Doe'], year: 2024 },
    });

    assert.equal(captured.status, 400);
    assert.equal(invalidateCalls.length, 0, 'no invalidation on the rejected path');
    assert.deepEqual(events, [], 'neither a write nor an invalidation happens on a 400');
  });
});
