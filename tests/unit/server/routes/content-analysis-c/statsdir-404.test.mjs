import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the real route module the way the sibling
// route tests do (mirrors tests/next-statsdir-cache.test.mjs and
// tests/next-healthsummary-cache.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// GET /api/stats/directory wraps its recursive directory walk in
// cached('statsdir:' + dir, 30000, fn). The sibling suite
// (tests/next-statsdir-cache.test.mjs) pins the 200 success aggregate and the 400
// invalid-dir guard, but it has ZERO assertions for the 404 path. This suite closes
// that gap: it pins the CURRENT behavior of the outer catch at
// content-analysis-c.js:931 to 932, which returns HTTP 404
// {error: 'Directory not found'} when the recursive walk throws.
//
// The seam: the isValidDir 400 guard (line 898) sits OUTSIDE the try, so it must
// pass to reach the walk. Inside the try, the closure calls count(fullDir), whose
// first I/O is fs.readdirSync (line 912). When the requested directory does not
// exist, readdirSync throws; the throw escapes the cached closure (so nothing is
// memoized) and lands in the outer catch as a 404. The inner readFileSync try/catch
// (lines 918 to 923) is never reached, because readdirSync throws first.
//
// Determinism: the only effectful call before the throw is the injected
// fs.readdirSync. There is no Date, random, network, or process.env on this path, so
// the 404 reply is fully determined by the injected mock fs.

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// A mock fs modelling an absent directory: every readdirSync throws an ENOENT-style
// error (exactly what node's real fs does for a missing directory), which is what
// drives the handler into its outer catch. readFileSync is provided for parity with
// the real ctx but must never run on this path; both calls are counted so a test can
// prove readdirSync threw before any file was read.
function buildAbsentDirFs() {
  let readdirCalls = 0;
  let readCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get readCalls() { return readCalls; },
    readdirSync(d) {
      readdirCalls++;
      const e = new Error(`ENOENT: no such file or directory, scandir '${d}'`);
      e.code = 'ENOENT';
      throw e;
    },
    readFileSync(fp) {
      readCalls++;
      const e = new Error(`ENOENT: no such file or directory, open '${fp}'`);
      e.code = 'ENOENT';
      throw e;
    },
  };
}

// Pass-through cached(key, ttl, fn): runs fn immediately and memoizes nothing, so the
// walk executes on every call. The key and ttl are irrelevant to a single
// pass-through run, so they are intentionally ignored here.
const passThroughCached = (_key, _ttl, fn) => fn();

const acceptAll = () => true;

// Drive the real GET /api/stats/directory handler once for a given dir and return
// every json() reply it emitted, in order. Mirrors the sibling suite's runStatsDir
// invoker and its captured reply shape ({status, payload}); collecting an array
// (rather than a single capture) lets a test prove exactly one reply fired.
async function runStatsDir(dir, { fs, cached, isValidDir }) {
  const replies = [];
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    isValidDir,
    json: (_res, status, payload) => { replies.push({ status, payload }); },
  };
  const url = new URL(`http://localhost/api/stats/directory?dir=${encodeURIComponent(dir)}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/stats/directory', ctx);
  return replies;
}

describe('GET /api/stats/directory (absent directory, 404 path)', () => {
  it('returns 404 Directory not found when the recursive walk throws', async () => {
    const fs = buildAbsentDirFs();

    // doesNotReject proves the handler swallows the readdirSync throw in its outer
    // catch (replying 404) rather than letting the error escape to the caller. If the
    // try/catch were removed, runStatsDir would reject here and this would fail.
    let replies;
    await assert.doesNotReject(async () => {
      replies = await runStatsDir('content/does-not-exist', {
        fs,
        cached: passThroughCached,
        isValidDir: acceptAll,
      });
    });

    // Exactly one reply fired, and it is the 404 golden, pinned by its exact error
    // string via deepStrictEqual.
    assert.equal(replies.length, 1, 'exactly one reply was emitted');
    assert.deepStrictEqual(replies[0], { status: 404, payload: { error: 'Directory not found' } });

    // Never-reached proof: the success return (200) and the invalid-dir guard (400)
    // both lie off this path, so neither reply fired.
    assert.ok(!replies.some((r) => r.status === 200), 'no 200 success reply fired');
    assert.ok(!replies.some((r) => r.status === 400), 'no 400 guard reply fired (isValidDir passed)');

    // The walk started (at least one readdirSync ran) but threw before any file was
    // read, matching the seam: readdirSync (line 912) precedes readFileSync (line 919).
    assert.ok(fs.readdirCalls > 0, 'the recursive walk attempted at least one readdirSync');
    assert.equal(fs.readCalls, 0, 'readdirSync threw before any readFileSync ran');
  });

  it('does not memoize the failure: a repeat request re-walks and re-404s', async () => {
    const fs = buildAbsentDirFs();

    // A memoizing cached (mirrors the sibling suite) stores a value only after fn
    // returns. Because the walk throws, store.set is never reached, so the failure is
    // never cached and each request re-runs the walk. This pins the source comment
    // "only a successful scan is ever cached" (content-analysis-c.js:906).
    const store = new Map();
    const memoizing = (key, _ttl, fn) => {
      if (store.has(key)) return store.get(key);
      const value = fn();
      store.set(key, value);
      return value;
    };

    const first = await runStatsDir('content/does-not-exist', { fs, cached: memoizing, isValidDir: acceptAll });
    assert.deepStrictEqual(first, [{ status: 404, payload: { error: 'Directory not found' } }]);
    const readdirAfterFirst = fs.readdirCalls;
    assert.equal(store.size, 0, 'a thrown walk memoizes nothing');

    const second = await runStatsDir('content/does-not-exist', { fs, cached: memoizing, isValidDir: acceptAll });
    assert.deepStrictEqual(second, [{ status: 404, payload: { error: 'Directory not found' } }]);
    assert.ok(fs.readdirCalls > readdirAfterFirst, 'the repeat request re-walks (the failure was not cached)');
  });
});
