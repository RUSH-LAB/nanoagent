import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the sibling
// server route tests do, so these cases exercise the shipped handlers rather
// than a reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The /api/pins handlers read and persist to this file. The mocked loadJSON
// below answers only for this path, so any stray read surfaces as a thrown
// error instead of silently passing.
const PINS_FILE = path.join(PROJECT_ROOT, 'data', 'pins.json');

// Drive the real /api/pins handler over a mocked ctx. loadJSON returns the
// supplied document, saveJSON records every persist call, and json captures the
// (status, body) the handler hands back. sanitizeText is identity so the
// asserted text equals the input verbatim. No real filesystem, network, or git
// is ever touched.
async function runRoute({ method, body = {}, doc = { pins: [] }, rateLimitOk = true }) {
  const saved = [];
  let captured = null;
  const ctx = {
    rateLimit: () => rateLimitOk,
    readBody: async () => body,
    loadJSON: (fp) => {
      if (fp === PINS_FILE) return doc;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/pins';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, saved };
}

describe('GET /api/pins', () => {
  it('an empty doc returns 200 with an empty pins array (the data.pins || [] fallback)', async () => {
    const { captured, saved } = await runRoute({ method: 'GET', doc: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { pins: [] });
    assert.equal(saved.length, 0);
  });

  it('a populated doc echoes the stored pins array', async () => {
    const pins = [
      { path: '/docs/a', title: 'A', pinnedAt: '2020-01-01T00:00:00.000Z' },
      { path: '/docs/b', title: 'B', pinnedAt: '2020-01-02T00:00:00.000Z' },
    ];
    const { captured, saved } = await runRoute({ method: 'GET', doc: { pins } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { pins });
    assert.equal(saved.length, 0);
  });
});

describe('POST /api/pins guards', () => {
  it('a rate-limited POST returns 429 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      rateLimitOk: false,
      body: { path: '/docs/a' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(saved.length, 0);
  });

  it('a missing, empty, or non-string path returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'POST', body: {} });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid path' });
    assert.equal(missing.saved.length, 0);

    // An empty string is falsy, so it trips the same guard as a missing path.
    const empty = await runRoute({ method: 'POST', body: { path: '' } });
    assert.equal(empty.captured.status, 400);
    assert.deepEqual(empty.captured.body, { error: 'Missing or invalid path' });
    assert.equal(empty.saved.length, 0);

    // A non-string path (here a number) trips the typeof check.
    const nonString = await runRoute({ method: 'POST', body: { path: 42 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid path' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a path longer than 500 characters returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { path: 'p'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Path must be 500 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a title longer than 500 characters returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { path: '/docs/a', title: 't'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Title must be 500 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a duplicate path returns 200 Already pinned and does not save (idempotent)', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      doc: { pins: [{ path: '/docs/a', title: 'A' }] },
      body: { path: '/docs/a' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, message: 'Already pinned' });
    assert.equal(saved.length, 0);
  });

  it('a valid new pin returns 200, saves once, and defaults the title to the page path', async () => {
    // An empty doc also exercises the lazy `if (!data.pins) data.pins = []`
    // initialization before the push.
    const { captured, saved } = await runRoute({
      method: 'POST',
      doc: {},
      body: { path: '/docs/a' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, PINS_FILE);
    const stored = saved[0].data.pins;
    assert.equal(stored.length, 1);
    // Deterministic fields only: the title defaults to the page path when none
    // is given. pinnedAt is a clock value, so assert only that it is present.
    assert.equal(stored[0].path, '/docs/a');
    assert.equal(stored[0].title, '/docs/a');
    assert.equal(typeof stored[0].pinnedAt, 'string');
  });
});

describe('DELETE /api/pins guards', () => {
  it('a missing path returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({ method: 'DELETE', body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing path' });
    assert.equal(saved.length, 0);
  });

  it('returns 404 Not pinned when there are no pins or the path is absent', async () => {
    // No pins array at all yields the not-pinned response.
    const noPins = await runRoute({ method: 'DELETE', doc: {}, body: { path: '/docs/a' } });
    assert.equal(noPins.captured.status, 404);
    assert.deepEqual(noPins.captured.body, { error: 'Not pinned' });
    assert.equal(noPins.saved.length, 0);

    // A populated list without the path yields the same not-pinned response.
    const absent = await runRoute({
      method: 'DELETE',
      doc: { pins: [{ path: '/docs/other' }] },
      body: { path: '/docs/a' },
    });
    assert.equal(absent.captured.status, 404);
    assert.deepEqual(absent.captured.body, { error: 'Not pinned' });
    assert.equal(absent.saved.length, 0);
  });

  it('a present path returns 200, saves once, removes the matching pin and keeps the others', async () => {
    const { captured, saved } = await runRoute({
      method: 'DELETE',
      doc: { pins: [{ path: '/keep1' }, { path: '/drop' }, { path: '/keep2' }] },
      body: { path: '/drop' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, PINS_FILE);
    const remaining = saved[0].data.pins.map(p => p.path);
    assert.deepEqual(remaining, ['/keep1', '/keep2']);
  });
});
