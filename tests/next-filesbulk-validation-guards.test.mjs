import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-adminbulk-invalidate, next-analysis-admin-recent-guard)
// and reuse their ctx-mocking shape. POST /api/files/bulk validates its body through a
// short guard ladder before the per-item delete/move loop:
//   1. rateLimit false for files-bulk:<addr> (limit 10) -> 429 before the try, body unread
//   2. !action || !Array.isArray(paths) || paths.length === 0 -> 400 Missing action or paths
//   3. action not in {delete, move}              -> 400 action must be "delete" or "move"
//   4. action === 'move' && !isValidDir(targetDir) -> 400 Invalid target directory
//   5. (success path: per-item loop + invalidateCache when processed > 0, then 200)
//   6. any throw inside the try                  -> 400 Invalid request
// The success path (step 5) is already pinned by tests/next-adminbulk-invalidate.test.mjs,
// so this add-only suite characterizes the early-validation guards that test leaves
// uncovered. It drives the handler over a mocked ctx (no real filesystem, network, or
// git) and asserts deterministic status, payload, and which helpers each guard touches.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

const PROJECT_ROOT = '/fake/root';
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');

// Minimal call-recording spy: `fn.calls` is the array of argument lists and the
// optional `impl` supplies the return value (undefined when omitted). Lets each case
// assert both "called once with X" and "never called" without a mocking library.
function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = [];
  return fn;
}

// Drive POST /api/files/bulk with a mocked ctx and return the captured json()
// response. The socket address is fixed at 127.0.0.1 so the rate-limit key resolves to
// `files-bulk:127.0.0.1`. Defaults are inert (every guard helper passes); each case
// overrides only the helpers it needs to probe. Mirrors invokeBulk in
// tests/next-adminbulk-invalidate.test.mjs.
async function invokeBulk(ctx = {}) {
  const pathname = '/api/files/bulk';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    path, PROJECT_ROOT, TRASH_DIR,
    rateLimit: () => true,
    readBody: async () => ({}),
    isValidFilePath: () => true,
    isValidDir: () => true,
    invalidateCache: () => {},
    fs: { existsSync: () => true, mkdirSync: () => {}, renameSync: () => {} },
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('POST /api/files/bulk early-validation guard ladder', () => {
  it('returns 429 for a rate-limited request and never reads the body', async () => {
    const rateLimit = spy(() => false);
    const readBody = spy(async () => ({ action: 'delete', paths: ['content/note.md'] }));
    const res = await invokeBulk({ rateLimit, readBody });
    assert.equal(res.status, 429);
    assert.deepEqual(res.payload, { error: 'Too many requests. Try again in a minute.' });
    // The limiter is keyed by the socket address (here 127.0.0.1) and capped at 10.
    assert.deepEqual(rateLimit.calls, [['files-bulk:127.0.0.1', 10]]);
    // The 429 short-circuits before the try block, so the body is never consumed.
    assert.equal(readBody.calls.length, 0);
  });

  it('returns 400 "Missing action or paths" when action is absent', async () => {
    const readBody = spy(async () => ({ paths: ['content/note.md'] }));
    const isValidDir = spy(() => true);
    const isValidFilePath = spy(() => true);
    const res = await invokeBulk({ readBody, isValidDir, isValidFilePath });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing action or paths' });
    // The body is read once; the guard returns before any path or directory check.
    assert.equal(readBody.calls.length, 1);
    assert.equal(isValidDir.calls.length, 0);
    assert.equal(isValidFilePath.calls.length, 0);
  });

  it('returns 400 "Missing action or paths" when paths is not an array', async () => {
    const readBody = spy(async () => ({ action: 'delete', paths: 'content/note.md' }));
    const isValidDir = spy(() => true);
    const isValidFilePath = spy(() => true);
    const res = await invokeBulk({ readBody, isValidDir, isValidFilePath });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing action or paths' });
    assert.equal(readBody.calls.length, 1);
    assert.equal(isValidDir.calls.length, 0);
    assert.equal(isValidFilePath.calls.length, 0);
  });

  it('returns 400 "Missing action or paths" when paths is an empty array', async () => {
    const readBody = spy(async () => ({ action: 'delete', paths: [] }));
    const isValidDir = spy(() => true);
    const isValidFilePath = spy(() => true);
    const res = await invokeBulk({ readBody, isValidDir, isValidFilePath });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing action or paths' });
    assert.equal(readBody.calls.length, 1);
    assert.equal(isValidDir.calls.length, 0);
    assert.equal(isValidFilePath.calls.length, 0);
  });

  it('returns 400 for an unknown action before consulting the target directory', async () => {
    const readBody = spy(async () => ({ action: 'copy', paths: ['content/note.md'] }));
    const isValidDir = spy(() => true);
    const isValidFilePath = spy(() => true);
    const res = await invokeBulk({ readBody, isValidDir, isValidFilePath });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'action must be "delete" or "move"' });
    // 'copy' is rejected by the action-validity guard (which returns the exact message
    // above). isValidDir is gated on action === 'move', so it is never consulted for a
    // non-move action; the per-item loop (isValidFilePath) is not reached either.
    assert.equal(isValidDir.calls.length, 0);
    assert.equal(isValidFilePath.calls.length, 0);
  });

  it('returns 400 for a move whose targetDir isValidDir rejects', async () => {
    const readBody = spy(async () => ({ action: 'move', paths: ['content/note.md'], targetDir: 'outside' }));
    const isValidDir = spy(() => false);
    const isValidFilePath = spy(() => true);
    const res = await invokeBulk({ readBody, isValidDir, isValidFilePath });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid target directory. Must start with content/' });
    // isValidDir is consulted exactly once, with the rejected targetDir.
    assert.deepEqual(isValidDir.calls, [['outside']]);
    // The guard returns before the per-item loop, so no path is validated.
    assert.equal(isValidFilePath.calls.length, 0);
  });

  it('skips the targetDir guard for a delete action (isValidDir is move-only)', async () => {
    const readBody = spy(async () => ({ action: 'delete', paths: ['bad-1', 'bad-2'] }));
    const isValidDir = spy(() => true);
    const isValidFilePath = spy(() => false);
    const invalidateCache = spy();
    const res = await invokeBulk({ readBody, isValidDir, isValidFilePath, invalidateCache });
    assert.equal(res.status, 200);
    assert.equal(res.payload.success, true);
    // Every path fails isValidFilePath, so the loop runs but processes nothing.
    assert.equal(res.payload.processed, 0);
    assert.deepEqual(res.payload.errors, [
      { path: 'bad-1', error: 'Invalid path' },
      { path: 'bad-2', error: 'Invalid path' },
    ]);
    // A delete never reaches the move-only targetDir guard, so isValidDir is untouched.
    assert.equal(isValidDir.calls.length, 0);
    // processed stayed 0, so neither cache prefix is cleared.
    assert.equal(invalidateCache.calls.length, 0);
  });

  it('returns 400 "Invalid request" when readBody throws', async () => {
    const readBody = spy(async () => { throw new Error('malformed body'); });
    const res = await invokeBulk({ readBody });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid request' });
    // The throw happens inside the try, after the body read was attempted once.
    assert.equal(readBody.calls.length, 1);
  });
});
