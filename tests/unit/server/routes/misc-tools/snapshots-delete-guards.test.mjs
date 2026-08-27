import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling write-guard suite does (next-misc-filetarget-write-guards.test.mjs) so
// these cases exercise the shipped DELETE /api/snapshots handler rather than a
// reimplementation. The handler runs over a fully mocked ctx: no real
// filesystem, network, or git is ever touched.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The handler loads and persists the snapshot store at this path, mirroring
// server/index.js (path.join(PROJECT_ROOT, 'data', 'snapshots.json')). The mocked
// loadJSON answers only for this exact path, so a stray read surfaces as a thrown
// error instead of silently passing; the same constant is handed to the handler
// through ctx, so the guard and the handler agree on the store path.
const SNAPSHOTS_FILE = path.join(PROJECT_ROOT, 'data', 'snapshots.json');

// Drive DELETE /api/snapshots over a mocked ctx. rateLimit records every call
// (key and limit) and returns the per-call toggle, so a rate-limited request can
// prove both the key shape and that the body was never read; isValidFilePath is a
// per-call toggle; readBody returns the supplied body and counts its own calls;
// loadJSON returns a fresh deep copy of `store`, a faithful stand-in for a fresh
// disk read that also decouples the recorded saved store from the input seed so
// the empty-key drop is observable on the saved object; saveJSON records every
// persist call; json captures the (status, body) handed back.
async function runRoute({
  body = {},
  store = {},
  rateLimitOk = true,
  validPath = true,
  throwOnReadBody = false,
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadJSONCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    isValidFilePath: () => validPath,
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === SNAPSHOTS_FILE) return JSON.parse(JSON.stringify(store));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    path,
    PROJECT_ROOT,
    SNAPSHOTS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/snapshots';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadJSONCount, rateLimitCalls };
}

describe('DELETE /api/snapshots rate limit', () => {
  it('a rate-limited DELETE returns 429, never reads the body, never loads, never saves, and uses the snapshots-delete key with limit 30', async () => {
    const { captured, saved, readBodyCount, loadJSONCount, rateLimitCalls } = await runRoute({
      rateLimitOk: false,
      body: { path: 'content/a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(loadJSONCount, 0);
    assert.equal(saved.length, 0);
    // Pin the per-handler rate-limit identity: the key is scoped to the socket
    // address with a limit of 30. This snapshots-delete key is unique to this
    // handler, distinguishing it from the snapshots and snapshots-restore
    // handlers that share the same 429 and 400 strings.
    assert.equal(rateLimitCalls.length, 1);
    assert.deepEqual(rateLimitCalls[0], { key: 'snapshots-delete:127.0.0.1', limit: 30 });
  });
});

describe('DELETE /api/snapshots path validation', () => {
  it('a path rejected by isValidFilePath returns 400 Invalid path, reads the body, never loads, never saves', async () => {
    // The body is read first; only then is the extracted path validated, so a
    // rejected path reaches the dedicated Invalid path branch before the store
    // is ever loaded.
    const { captured, saved, readBodyCount, loadJSONCount } = await runRoute({
      validPath: false,
      body: { path: '../etc/passwd', snapshotId: 's1' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid path' });
    assert.equal(readBodyCount, 1, 'the body is read before the path is validated');
    assert.equal(loadJSONCount, 0, 'the store is not loaded once the path is rejected');
    assert.equal(saved.length, 0);
  });
});

describe('DELETE /api/snapshots snapshotId validation', () => {
  it('a missing snapshotId returns 400 snapshotId is required, reads the body, never loads, never saves', async () => {
    const { captured, saved, readBodyCount, loadJSONCount } = await runRoute({ body: { path: 'content/a.md' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'snapshotId is required' });
    assert.equal(readBodyCount, 1, 'the body is read before snapshotId is validated');
    assert.equal(loadJSONCount, 0);
    assert.equal(saved.length, 0);
  });

  it('a non-string snapshotId (42) returns 400 snapshotId is required, reads the body, never loads, never saves', async () => {
    // 42 is truthy so it clears the falsy check, but typeof 42 !== 'string'
    // trips the dedicated type guard. A numeric snapshotId is never coerced.
    const { captured, saved, readBodyCount, loadJSONCount } = await runRoute({ body: { path: 'content/a.md', snapshotId: 42 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'snapshotId is required' });
    assert.equal(readBodyCount, 1, 'the body is read before snapshotId is validated');
    assert.equal(loadJSONCount, 0);
    assert.equal(saved.length, 0);
  });
});

describe('DELETE /api/snapshots not-found branches', () => {
  it('a valid path absent from the store returns 404 No snapshots for this file, loads once, never saves', async () => {
    // The genuinely uncovered branch: the requested file key is missing from the
    // store, so the handler short-circuits before computing an index. A sibling
    // key is present to show the lookup is keyed on the requested path, not on an
    // empty store.
    const { captured, saved, loadJSONCount } = await runRoute({
      store: { 'content/other.md': [{ id: 'x1' }] },
      body: { path: 'content/a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'No snapshots for this file' });
    assert.equal(loadJSONCount, 1);
    assert.equal(saved.length, 0);
  });

  it('a present file with no matching snapshot id returns 404 Snapshot not found, loads once, never saves', async () => {
    const { captured, saved, loadJSONCount } = await runRoute({
      store: { 'content/a.md': [{ id: 's1' }, { id: 's2' }] },
      body: { path: 'content/a.md', snapshotId: 'nope' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Snapshot not found' });
    assert.equal(loadJSONCount, 1);
    assert.equal(saved.length, 0);
  });
});

describe('DELETE /api/snapshots success and persistence', () => {
  it('deleting one of several snapshots returns 200, saves once, and retains the key with the survivors', async () => {
    const store = { 'content/a.md': [{ id: 's1' }, { id: 's2' }] };
    const { captured, saved, loadJSONCount } = await runRoute({
      store,
      body: { path: 'content/a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(loadJSONCount, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, SNAPSHOTS_FILE);
    // s1 is spliced out; the key survives because s2 remains.
    assert.equal(Object.hasOwn(saved[0].data, 'content/a.md'), true);
    assert.deepEqual(saved[0].data, { 'content/a.md': [{ id: 's2' }] });
    // The deep-copy seed isolates the recorded save from the input store, so the
    // caller's seed is observably untouched by the in-place splice.
    assert.deepEqual(store, { 'content/a.md': [{ id: 's1' }, { id: 's2' }] });
  });

  it('deleting the last snapshot returns 200, saves once, and drops the now-empty key', async () => {
    const { captured, saved } = await runRoute({
      store: { 'content/a.md': [{ id: 's1' }] },
      body: { path: 'content/a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(saved.length, 1);
    // The array empties after the splice, so the key is deleted entirely rather
    // than left holding an empty array.
    assert.equal(Object.hasOwn(saved[0].data, 'content/a.md'), false);
    assert.deepEqual(saved[0].data, {});
  });
});

describe('DELETE /api/snapshots outer catch', () => {
  it('an outer throw (readBody fails) returns 400 Invalid request, never loads, never saves', async () => {
    const { captured, saved, loadJSONCount } = await runRoute({
      throwOnReadBody: true,
      body: { path: 'content/a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid request' });
    assert.equal(loadJSONCount, 0);
    assert.equal(saved.length, 0);
  });
});
