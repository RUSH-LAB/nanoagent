import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the real module via createRequire the way
// the sibling outer-catch suites do (next-byauthor-500), so this characterization
// test drives the genuine DELETE /api/folder handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH (graph-trash-files.js:377 through :379). The try
// opens at graph-trash-files.js:363; after clearing the rateLimit (429), isValidDir
// (400), root-directory (400), existsSync (404), statSync (400), and readdirSync (400)
// guards, it calls fs.rmdirSync(fullPath) (graph-trash-files.js:375). Any error other
// than 'Invalid JSON' lands at the catch tail and returns json(res, 500, {error:
// 'Delete failed'}) (graph-trash-files.js:379). On success the try would return
// json(res, 200, {success: true}) (graph-trash-files.js:376), which these seams prove
// is never emitted.
//
// The catch's FIRST branch (graph-trash-files.js:378) returns json(res, 400, {error:
// 'Invalid request'}) when err.message === 'Invalid JSON', so a readBody that throws
// 'Invalid JSON' is mapped to the 400 and takes precedence over the 500. The second
// seam pins that precedence: the 500 is reached only by a genuine delete failure.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the catch tail emits on a genuine delete failure, in the
// {status, body} shape captured by the json() stub below (graph-trash-files.js:379).
const GOLDEN_500 = { status: 500, body: { error: 'Delete failed' } };

// The reply the catch's first branch emits when readBody throws 'Invalid JSON'
// (graph-trash-files.js:378), taking precedence over the 500.
const GOLDEN_400 = { status: 400, body: { error: 'Invalid request' } };

// The only key the success projection returns, json(res, 200, {success: true}) at
// graph-trash-files.js:376. The never-reached proof asserts it surfaces in no reply.
const SUCCESS_KEYS = ['success'];

// Drive the real DELETE /api/folder handler over a mocked ctx. The caller supplies
// the readBody and fs seams that steer the single try into its catch. Every
// json(res, status, payload) write is captured in `replies` so a test can assert the
// failing reply is the ONLY one and the success projection never fired. The guards
// upstream of the delete are all cleared here: rateLimit returns true (else a 429
// fires first), isValidDir returns true (else 400 'Invalid path'), and the REAL node
// path module is used so path.normalize('content/empty-dir') is not 'content' (else
// 400 'Cannot delete the root content directory'). Only the ctx fields this route
// reads are supplied; the rest stay undefined because this path never touches them.
async function runDeleteFolder({ readBody, fs }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    rateLimit: () => true,
    readBody,
    isValidDir: () => true,
    path,
    PROJECT_ROOT,
    fs,
  };
  const pathname = '/api/folder';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

function freshCalls() {
  return { existsSync: 0, statSync: 0, readdirSync: 0, rmdirSync: 0 };
}

// Seam (500): every guard cleared, so execution reaches the delete and rmdirSync
// throws. Any thrown message other than 'Invalid JSON' reaches the catch tail and
// returns the 500, so the exact 'EPERM' text below is illustrative, not asserted.
// existsSync/statSync/readdirSync return the guard-clearing values; each call is
// counted so the test can prove execution genuinely reached rmdirSync rather than
// short-circuiting earlier.
function deleteFailFs(calls) {
  return {
    existsSync() { calls.existsSync++; return true; },
    statSync() { calls.statSync++; return { isDirectory: () => true }; },
    readdirSync() { calls.readdirSync++; return []; },
    rmdirSync() { calls.rmdirSync++; throw new Error('EPERM: operation not permitted'); },
  };
}

// Seam (400): readBody throws 'Invalid JSON' at the top of the try, before any fs
// work, so every fs method must stay unreached. Each one counts its call (and throws)
// so a wrongly-taken path is caught by both the call-count assertion and the golden.
function unreachedFs(calls) {
  return {
    existsSync() { calls.existsSync++; throw new Error('existsSync must stay unreached on the Invalid JSON seam'); },
    statSync() { calls.statSync++; throw new Error('statSync must stay unreached on the Invalid JSON seam'); },
    readdirSync() { calls.readdirSync++; throw new Error('readdirSync must stay unreached on the Invalid JSON seam'); },
    rmdirSync() { calls.rmdirSync++; throw new Error('rmdirSync must stay unreached on the Invalid JSON seam'); },
  };
}

describe('DELETE /api/folder outer catch returns 500 Delete failed', () => {
  it('maps a genuine rmdirSync failure into the 500 reply', async () => {
    const calls = freshCalls();
    const { replies } = await runDeleteFolder({
      readBody: async () => ({ path: 'content/empty-dir' }),
      fs: deleteFailFs(calls),
    });

    // The single reply is the catch tail's 500; deepStrictEqual pins both the status
    // and the exact error body.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Non-vacuous reachability: every guard was cleared and execution genuinely
    // reached the delete call exactly once.
    assert.equal(calls.existsSync, 1);
    assert.equal(calls.statSync, 1);
    assert.equal(calls.readdirSync, 1);
    assert.equal(calls.rmdirSync, 1);

    // Never-reached proof: the json(res, 200, {success: true}) success projection
    // never fired; no reply carries a 200 status or the 'success' key.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)), false);
  });

  it('maps a readBody Invalid JSON throw into the 400 reply, taking precedence over the 500', async () => {
    const calls = freshCalls();
    const { replies } = await runDeleteFolder({
      readBody: async () => { throw new Error('Invalid JSON'); },
      fs: unreachedFs(calls),
    });

    // The catch's first branch returns the 400, not the generic 500.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_400);

    // The throw happened at readBody, before any fs work, so the delete seam and its
    // guards stayed unreached.
    assert.equal(calls.existsSync, 0);
    assert.equal(calls.statSync, 0);
    assert.equal(calls.readdirSync, 0);
    assert.equal(calls.rmdirSync, 0);

    // Precedence + never-reached proof: no reply is the 500 'Delete failed' and the
    // 200 success projection never fired.
    assert.equal(replies.some((r) => r.status === 500), false);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)), false);
  });
});
