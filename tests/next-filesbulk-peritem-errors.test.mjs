import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-adminbulk-invalidate, next-filesbulk-validation-guards)
// and reuse their ctx-mocking shape. This add-only suite characterizes the per-item
// errors[] accumulation inside the POST /api/files/bulk move loop, which the existing
// suites leave uncovered: next-filesbulk-validation-guards pins the pre-loop guard
// ladder, and next-adminbulk-invalidate pins the cache-invalidation accounting on the
// success path. Here every item fails, so processed stays 0 and no cache is cleared.
//
// For action 'move', each path runs through the per-item try block (server lines
// 146-189). After the shared isValidFilePath / fs.existsSync entry guards pass, the
// move branch has three distinct error arms:
//   A. newPath fails isValidFilePath           -> 'Resulting path is invalid' (line 173)
//   B. newPath valid but fullTarget exists      -> 'Target already exists'    (line 178)
//   C. newPath valid, target absent, rename throws -> 'Operation failed'      (line 187)
// Each arm pushes {path, error} into the 200 response body's errors array. The
// 'Operation failed' string had no test anywhere before this file. The delete branch
// is avoided on purpose: it stamps an ISO timestamp from the wall clock, which is not
// deterministic and would make a golden brittle.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

const PROJECT_ROOT = '/fake/root';
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');
const TARGET_DIR = 'content/dest';

// Three input paths, each crafted to land in a distinct move-error arm.
const A = 'content/a.md'; // resolved newPath fails isValidFilePath
const B = 'content/b.md'; // resolved newPath valid, but its target already exists
const C = 'content/c.md'; // resolved newPath valid, target absent, renameSync throws

// The resolved move target for each input, computed exactly as the handler does:
// newPath = path.join(targetDir, basename); fullTarget = path.join(PROJECT_ROOT, newPath).
const newPathA = path.join(TARGET_DIR, path.basename(A)); // 'content/dest/a.md'
const fullSourceC = path.join(PROJECT_ROOT, C);
const fullTargetC = path.join(PROJECT_ROOT, TARGET_DIR, path.basename(C));
const fullTargetDir = path.join(PROJECT_ROOT, TARGET_DIR);

// Minimal call-recording spy: `fn.calls` is the array of argument lists and the
// optional `impl` supplies the return value (and may throw). Args are recorded before
// impl runs, so a throwing impl still leaves the call on record. Mirrors the spy in
// tests/next-filesbulk-validation-guards.test.mjs.
function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = [];
  return fn;
}

// Drive POST /api/files/bulk with a mocked ctx and return the captured json()
// response. Defaults are inert (rate limit open, every guard passes, fs is a no-op);
// each case overrides only the helpers it needs. Mirrors invokeBulk in the sibling
// bulk suites. No real filesystem, network, or clock is touched.
async function invokeBulk(ctx) {
  const pathname = '/api/files/bulk';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    path, PROJECT_ROOT, TRASH_DIR,
    rateLimit: () => true,
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

describe('POST /api/files/bulk per-item move errors[] accumulation', () => {
  it('records the three distinct move-error arms in order for one batch', async () => {
    const invalidateCache = spy();
    const mkdirSync = spy();
    const renameSync = spy((src) => { if (src === fullSourceC) throw new Error('rename failed'); });
    // existsSync is true for each input source (so the not-found guard passes) and for
    // B's resolved target (so B hits the target-exists arm). C's target is absent, so C
    // advances to renameSync, which throws and is caught into 'Operation failed'. A's
    // target is intentionally omitted: A stops at the resolved-path-invalid guard and
    // never reaches the target-exists check.
    const existing = new Set([
      path.join(PROJECT_ROOT, A),
      path.join(PROJECT_ROOT, B),
      path.join(PROJECT_ROOT, C),
      path.join(PROJECT_ROOT, TARGET_DIR, path.basename(B)),
    ]);
    const res = await invokeBulk({
      readBody: async () => ({ action: 'move', targetDir: TARGET_DIR, paths: [A, B, C] }),
      // True for every input path and for B's and C's resolved newPath; false ONLY for
      // A's resolved newPath, so A alone hits the 'Resulting path is invalid' arm.
      isValidFilePath: (p) => p !== newPathA,
      fs: { existsSync: (p) => existing.has(p), mkdirSync, renameSync },
      invalidateCache,
    });

    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.payload, {
      success: true,
      processed: 0,
      errors: [
        { path: A, error: 'Resulting path is invalid' },
        { path: B, error: 'Target already exists' },
        { path: C, error: 'Operation failed' },
      ],
    });
    // Only C advanced past both guard arms to attempt the move, so mkdirSync and
    // renameSync each ran exactly once, for C alone. A and B short-circuited earlier.
    assert.deepStrictEqual(mkdirSync.calls, [[fullTargetDir, { recursive: true }]]);
    assert.deepStrictEqual(renameSync.calls, [[fullSourceC, fullTargetC]]);
    // Every item errored, so processed stayed 0 and neither cache prefix is cleared.
    assert.equal(invalidateCache.calls.length, 0);
  });

  it('arm A records "Resulting path is invalid" when the resolved newPath is rejected', async () => {
    const invalidateCache = spy();
    const renameSync = spy();
    const res = await invokeBulk({
      readBody: async () => ({ action: 'move', targetDir: TARGET_DIR, paths: [A] }),
      // The input path passes, but its resolved newPath is rejected.
      isValidFilePath: (p) => p !== newPathA,
      fs: { existsSync: (p) => p === path.join(PROJECT_ROOT, A), mkdirSync: () => {}, renameSync },
      invalidateCache,
    });
    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.payload, {
      success: true,
      processed: 0,
      errors: [{ path: A, error: 'Resulting path is invalid' }],
    });
    // This arm continues before the move, so no rename is attempted.
    assert.equal(renameSync.calls.length, 0);
    assert.equal(invalidateCache.calls.length, 0);
  });

  it('arm B records "Target already exists" when the move target is already present', async () => {
    const invalidateCache = spy();
    const renameSync = spy();
    const fullSourceB = path.join(PROJECT_ROOT, B);
    const fullTargetB = path.join(PROJECT_ROOT, TARGET_DIR, path.basename(B));
    const res = await invokeBulk({
      readBody: async () => ({ action: 'move', targetDir: TARGET_DIR, paths: [B] }),
      isValidFilePath: () => true,
      // Both the source and the resolved target exist, so B stops at the target-exists guard.
      fs: { existsSync: (p) => p === fullSourceB || p === fullTargetB, mkdirSync: () => {}, renameSync },
      invalidateCache,
    });
    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.payload, {
      success: true,
      processed: 0,
      errors: [{ path: B, error: 'Target already exists' }],
    });
    // The target-exists guard continues before the move, so no rename is attempted.
    assert.equal(renameSync.calls.length, 0);
    assert.equal(invalidateCache.calls.length, 0);
  });

  it('arm C records "Operation failed" when renameSync throws', async () => {
    const invalidateCache = spy();
    const mkdirSync = spy();
    const renameSync = spy(() => { throw new Error('rename failed'); });
    const res = await invokeBulk({
      readBody: async () => ({ action: 'move', targetDir: TARGET_DIR, paths: [C] }),
      isValidFilePath: () => true,
      // Source exists, target does not, so the move advances to renameSync, which throws.
      fs: { existsSync: (p) => p === fullSourceC, mkdirSync, renameSync },
      invalidateCache,
    });
    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.payload, {
      success: true,
      processed: 0,
      errors: [{ path: C, error: 'Operation failed' }],
    });
    // The rename was attempted once with the resolved source and target, then threw
    // into the per-item catch. mkdirSync ran first, also exactly once.
    assert.deepStrictEqual(mkdirSync.calls, [[fullTargetDir, { recursive: true }]]);
    assert.deepStrictEqual(renameSync.calls, [[fullSourceC, fullTargetC]]);
    assert.equal(invalidateCache.calls.length, 0);
  });
});
