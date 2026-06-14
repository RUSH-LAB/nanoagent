import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the real module via createRequire the way the
// sibling outer-catch suite does (next-delfolder-500, same module) and reuse the mocked
// ctx idiom of next-graphtrash-mutation-guards (which already pins THIS handler's
// 400 / 404 / 409 guard ladder and success path). This add-only characterization test is
// the missing 500 capstone for POST /api/trash/restore: it pins that handler's OUTER CATCH.
//
// The try opens at graph-trash-files.js:212. After clearing the rateLimit (429), the
// missing / non-string trashPath (400), the traversal-or-absolute (400), the
// within-.trash (400), the existsSync not-found (404), the TRASH_NAME_RE format (400),
// the isValidFilePath (400), and the already-exists (409) guards, it calls
// fs.mkdirSync(dir, {recursive: true}) (graph-trash-files.js:232) then
// fs.renameSync(fullTrashPath, fullOriginalPath) (:233). Any error whose message is not
// 'Invalid JSON' lands at the catch tail and returns json(res, 500, {error: 'Restore
// failed'}) (graph-trash-files.js:241). On success the try would invalidate the search and
// stats caches (:236 / :237) and return json(res, 200, {success: true, restoredPath})
// (:238), which these seams prove is never emitted.
//
// The catch's FIRST branch (graph-trash-files.js:240) returns json(res, 400, {error:
// 'Invalid request'}) when err.message === 'Invalid JSON', so a readBody that throws
// 'Invalid JSON' is mapped to the 400 and takes precedence over the 500. The last case
// pins that precedence: the 500 is reached only by a genuine restore failure.
//
// Each case drives the real handler over a mocked ctx (recording fs, stubbed
// isValidFilePath / rateLimit / readBody / invalidateCache), so no real filesystem,
// network, or git is ever touched. The handler reads no clock, randomness, or network, so
// every assertion is deterministic.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/virtual-root';
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');

// A valid trash path of the shape '.trash/<subdir>/<timestamp>_<originalname>'. Its
// basename matches TRASH_NAME_RE, so the handler clears the format guard, resolves the
// original path to 'content/foo.md', and reaches the mkdirSync + renameSync ops. This is
// the fixture proven by next-graphtrash-mutation-guards for this same handler.
const TRASH_PATH = '.trash/content/2024-01-01T00-00-00-000Z_foo.md';

// The exact reply the catch tail emits on a genuine restore failure, in the {status, body}
// shape captured by the json() stub below (graph-trash-files.js:241).
const GOLDEN_500 = { status: 500, body: { error: 'Restore failed' } };

// The reply the catch's first branch emits when readBody throws 'Invalid JSON'
// (graph-trash-files.js:240), taking precedence over the 500.
const GOLDEN_400 = { status: 400, body: { error: 'Invalid request' } };

// The keys the success projection would carry, json(res, 200, {success: true,
// restoredPath}) at graph-trash-files.js:238. The never-reached proof asserts neither
// surfaces in any reply on a failing seam.
const SUCCESS_KEYS = ['success', 'restoredPath'];

// A recording fs whose two mutating methods count their calls and optionally throw, so a
// seam can place the failure at renameSync (after a successful mkdirSync) or at mkdirSync
// itself. existsSync returns true for the trashed file at /virtual-root/.trash/content/...
// (it lives under .trash/, clearing the :220 not-found guard) and false for the restore
// destination at /virtual-root/content/foo.md (it sits outside .trash/, clearing the :230
// already-exists guard); the '.trash' substring cleanly selects the two guard outcomes by
// the path passed in, and each probe is counted so reachability is provable.
function makeFs({ mkdirThrows = false, renameThrows = false } = {}) {
  const calls = { existsSync: 0, mkdirSync: 0, renameSync: 0 };
  const fs = {
    existsSync(p) {
      calls.existsSync++;
      return p.includes('.trash');
    },
    mkdirSync() {
      calls.mkdirSync++;
      if (mkdirThrows) throw new Error('EACCES: permission denied, mkdir');
    },
    renameSync() {
      calls.renameSync++;
      if (renameThrows) throw new Error('EXDEV: cross-device link not permitted, rename');
    },
  };
  return { fs, calls };
}

// Drive the real POST /api/trash/restore handler over a mocked ctx. The caller supplies the
// readBody and fs seams that steer the single try into its catch. Every json(res, status,
// payload) write is captured in `replies` and every invalidateCache(key) call in
// `invalidateCalls`, so a test can assert the failing reply is the ONLY one and that the
// success tail (cache invalidation + 200 projection) never fired. The guards upstream of
// the mutating ops are all cleared here: rateLimit returns true (else a 429 fires first),
// isValidFilePath returns true (else 400), and the REAL node path module is used so the
// trashPath normalizes within .trash/ and resolves to a valid original path. Only the ctx
// fields this route reads are supplied; the rest stay undefined because this path never
// touches them.
async function runRestore({ readBody, fs }) {
  const replies = [];
  const invalidateCalls = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    rateLimit: () => true,
    readBody,
    isValidFilePath: () => true,
    invalidateCache: (key) => { invalidateCalls.push(key); },
    path,
    PROJECT_ROOT,
    TRASH_DIR,
    fs,
  };
  const pathname = '/api/trash/restore';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, invalidateCalls };
}

describe('POST /api/trash/restore outer catch returns 500 Restore failed', () => {
  it('maps a genuine renameSync failure into the 500 reply (mkdirSync succeeded first)', async () => {
    const { fs, calls } = makeFs({ renameThrows: true });
    const { replies, invalidateCalls } = await runRestore({
      readBody: async () => ({ trashPath: TRASH_PATH }),
      fs,
    });

    // The single reply is the catch tail's 500; deepStrictEqual pins both the status and
    // the exact error body.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Non-vacuous reachability: both existsSync guards were probed, the directory was
    // created, and execution genuinely reached renameSync exactly once.
    assert.equal(calls.existsSync, 2);
    assert.equal(calls.mkdirSync, 1);
    assert.equal(calls.renameSync, 1);

    // Never-reached proof: renameSync threw before the success tail, so neither cache was
    // invalidated and no 200 / {success, restoredPath} projection fired.
    assert.deepStrictEqual(invalidateCalls, []);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)), false);
  });

  it('maps a genuine mkdirSync failure into the same 500 reply (renameSync never reached)', async () => {
    const { fs, calls } = makeFs({ mkdirThrows: true });
    const { replies, invalidateCalls } = await runRestore({
      readBody: async () => ({ trashPath: TRASH_PATH }),
      fs,
    });

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // mkdirSync threw, so renameSync was never reached; both existsSync guards still ran.
    assert.equal(calls.existsSync, 2);
    assert.equal(calls.mkdirSync, 1);
    assert.equal(calls.renameSync, 0);

    assert.deepStrictEqual(invalidateCalls, []);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)), false);
  });

  it('maps a readBody Invalid JSON throw into the 400 reply, taking precedence over the 500', async () => {
    const { fs, calls } = makeFs();
    const { replies, invalidateCalls } = await runRestore({
      readBody: async () => { throw new Error('Invalid JSON'); },
      fs,
    });

    // The catch's first branch returns the 400, not the generic 500.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_400);

    // The throw happened at readBody, before any fs work, so no guard or mutating op ran.
    assert.equal(calls.existsSync, 0);
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);

    // Precedence + never-reached proof: no 500, no 200, and neither cache was invalidated.
    assert.deepStrictEqual(invalidateCalls, []);
    assert.equal(replies.some((r) => r.status === 500), false);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)), false);
  });
});
