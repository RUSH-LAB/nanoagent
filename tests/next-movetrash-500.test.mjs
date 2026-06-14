import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load the real route module via createRequire the way the sibling
// files.js suites do (next-filesstats-500, next-files-mutation-error-branches), so this
// characterization test drives the genuine DELETE /api/file (move to trash) handler instead
// of a reimplementation.
//
// It pins that handler's OUTER CATCH. After the pre-try guards (rate limit at files.js:81,
// the `?path=` query param at :82, isValidFilePath at :83) the handler opens a try at :85.
// Inside it the not-found guard `fs.existsSync(fullPath)` (:86) clears, then the move runs:
// `fs.mkdirSync(trashSubDir, {recursive: true})` (:92) followed by
// `fs.renameSync(fullPath, trashFullPath)` (:94). A throw from EITHER fs mutation lands in
// the bindingless outer catch (:97), which returns
// `json(res, 500, {error: 'Failed to move file to trash: the file may be locked or the trash
// directory is not writable'})` (:98). The catch has no error binding, so the body is a
// fixed string with no err.message leak. The success projection `{success: true, trashPath}`
// returned at :96, and the `invalidateCache('search')` at :95, are then never reached.
//
// The path arrives as the positional `url` argument's `?path=` query param (the handler
// reads `url.searchParams.get('path')` at :82, not anything off ctx, and there is no
// readBody), so there is no 'Invalid JSON' precedence rung here. The timestamp builder at
// :87 only names the trashed file and runs
// AFTER the existsSync guard, so it never affects the 500 golden. The handler moves a file
// with fs.renameSync only; there is no embedding, vector, or semantic retrieval, so this
// ADD-ONLY test is constraint compliant.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');
const { isValidFilePath } = require('../server/server-utils.js');

const PROJECT_ROOT = '/virtual-root';
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');

// The exact reply the outer catch emits, captured in the {status, body} shape the json()
// stub below records. BOTH 500 seams (renameSync throws, mkdirSync throws) must produce it.
const GOLDEN_500 = {
  status: 500,
  body: { error: 'Failed to move file to trash: the file may be locked or the trash directory is not writable' },
};

// The distinctness reply for the not-found branch (:86), proving the 500 golden is a
// different rung from the 404.
const GOLDEN_404 = { status: 404, body: { error: 'File not found' } };

// A recording fs covering exactly the three methods the delete handler reaches inside its
// try: existsSync (:86), mkdirSync (:92) and renameSync (:94). `exists` answers the
// not-found guard, and either mutation can be told to throw (`throwOn`) to steer the try
// into its catch. Each method counts its calls so a test can prove which fs steps ran: e.g.
// renameSync never runs when mkdirSync throws first, and neither mutation runs on the 404
// branch. The mutating methods are otherwise no-ops, so no real filesystem move ever happens.
function makeFs({ exists, throwOn }) {
  const calls = { existsSync: 0, mkdirSync: 0, renameSync: 0 };
  const fs = {
    existsSync(p) { calls.existsSync++; return exists(p); },
    mkdirSync() {
      calls.mkdirSync++;
      if (throwOn === 'mkdirSync') throw new Error('EACCES: permission denied, mkdir');
    },
    renameSync() {
      calls.renameSync++;
      if (throwOn === 'renameSync') throw new Error('EBUSY: resource busy or locked, rename');
    },
  };
  return { fs, calls };
}

// Drive the real DELETE /api/file handler over a mocked ctx, capturing every json() write
// and every invalidateCache() call. Mirrors the invokeRoute helper in
// next-files-mutation-error-branches: a real URL carrying ?path=, a socket so the rate-limit
// key resolves, the REAL isValidFilePath from server-utils so the :83 guard is cleared by
// production's own validator, and rateLimit returning true so the :81 gate passes. The path
// 'content/note.md' is a genuinely valid content path, so isValidFilePath returns true.
async function runDelete({ fs }) {
  const replies = [];
  const invalidated = [];
  const pathname = '/api/file';
  const url = new URL(`http://localhost${pathname}?path=content/note.md`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const ctx = {
    path,
    PROJECT_ROOT,
    TRASH_DIR,
    isValidFilePath,
    rateLimit: () => true,
    invalidateCache(key) { invalidated.push(key); },
    json(_res, status, body) { const r = { status, body }; replies.push(r); res.writableEnded = true; return r; },
    fs,
  };
  await filesRoutes(req, res, url, pathname, ctx);
  return { replies, invalidated };
}

describe('DELETE /api/file (move to trash) outer catch returns 500', () => {
  it('maps a throw from fs.renameSync (after mkdirSync succeeds) straight into the 500 reply', async () => {
    const { fs, calls } = makeFs({ exists: () => true, throwOn: 'renameSync' });
    const { replies, invalidated } = await runDelete({ fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the exact
    // fixed-string body, so any err.message leak from the (bindingless) catch would fail it.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The seam: existsSync cleared the not-found guard, mkdirSync ran once and succeeded, and
    // renameSync ran once and threw.
    assert.equal(calls.existsSync, 1);
    assert.equal(calls.mkdirSync, 1);
    assert.equal(calls.renameSync, 1);

    // Never-reached proof: no reply carries the success 200 projection at :96 (status 200, a
    // `success` flag, or a `trashPath`), and invalidateCache('search') at :95 never fired.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'success' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'trashPath' in r.body), false);
    assert.deepStrictEqual(invalidated, []);
  });

  it('maps a throw from fs.mkdirSync (renameSync never reached) into the SAME 500 reply', async () => {
    const { fs, calls } = makeFs({ exists: () => true, throwOn: 'mkdirSync' });
    const { replies, invalidated } = await runDelete({ fs });

    // Byte-identical to the renameSync seam above, even though the move never started.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The seam: mkdirSync ran once and threw before renameSync at :94 could run, so no file
    // was moved, yet the reply matches the renameSync-throw seam exactly.
    assert.equal(calls.existsSync, 1);
    assert.equal(calls.mkdirSync, 1);
    assert.equal(calls.renameSync, 0);

    // Same never-reached proof on this seam.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'success' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'trashPath' in r.body), false);
    assert.deepStrictEqual(invalidated, []);
  });

  it('is distinct from the not-found 404 branch when existsSync is false (no move attempted)', async () => {
    const { fs, calls } = makeFs({ exists: () => false, throwOn: null });
    const { replies, invalidated } = await runDelete({ fs });

    // The not-found guard at :86 fires its own 404 before any move, proving the 500 golden is
    // a distinct rung from the 404 and not a catch-all swallowing the missing-file case.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_404);
    assert.notDeepStrictEqual(replies[0], GOLDEN_500);

    // existsSync ran once and returned false; neither mutation was attempted and nothing was
    // invalidated.
    assert.equal(calls.existsSync, 1);
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
    assert.deepStrictEqual(invalidated, []);
  });
});
