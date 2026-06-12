import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load it the way the sibling route suites do
// (next-analysis-admin-recent-guard, next-graphtrash-search-invalidate) and reuse
// their ctx-mocking shape. GET /api/files/search in files.js serves a flat file
// list from cached('search:list', 30000, () => flatFiles(fullDir)), and GET
// /api/stats reports counts from the content-stats cache. POST /api/files/bulk
// mutates that file set (delete moves files into .trash/, move renames them across
// directories), so after a batch that processed at least one file it must clear the
// 'search' and 'stats' cache prefixes the way the single-file files.js handlers and
// the graph-trash-files.js move/restore fix do. These tests drive the handler with a
// mock fs and a spying invalidateCache (no network, no server) and prove the
// invalidation fires for a delete and a move, and stays silent for an all-invalid
// batch (processed === 0, nothing actually moved).
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

const PROJECT_ROOT = '/fake/root';
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');

// Drive the POST /api/files/bulk route with a mocked ctx and capture the json()
// response. The spying invalidateCache lives in each test's ctx so the test owns the
// recorded-calls array. Mirrors the invokeRoute helper in
// next-graphtrash-search-invalidate.test.mjs.
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
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('POST /api/files/bulk clears the "search" and "stats" cache prefixes', () => {
  it('invalidates both search and stats after a delete batch that processed a file', async () => {
    const invalidations = [];
    const res = await invokeBulk({
      readBody: async () => ({ action: 'delete', paths: ['content/note.md'] }),
      invalidateCache: (p) => invalidations.push(p),
      // The file exists, so the rename into .trash/ runs to completion.
      fs: { existsSync: () => true, mkdirSync: () => {}, renameSync: () => {} },
    });
    assert.equal(res.status, 200, 'a valid bulk delete returns 200');
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.processed, 1, 'one file was deleted');
    // A bulk delete drops the file count, so both the cached search list and the
    // content stats snapshot are stale and must be cleared.
    assert.ok(invalidations.includes('search'), 'delete clears the search cache');
    assert.ok(invalidations.includes('stats'), 'delete clears the stats cache');
  });

  it('invalidates both search and stats after a move batch that processed a file', async () => {
    const invalidations = [];
    const fullSource = path.join(PROJECT_ROOT, 'content/old/note.md');
    const res = await invokeBulk({
      readBody: async () => ({ action: 'move', paths: ['content/old/note.md'], targetDir: 'content/new' }),
      invalidateCache: (p) => invalidations.push(p),
      // Source exists, target does not, so the rename runs to completion.
      fs: { existsSync: (p) => p === fullSource, mkdirSync: () => {}, renameSync: () => {} },
    });
    assert.equal(res.status, 200, 'a valid bulk move returns 200');
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.processed, 1, 'one file was moved');
    // A bulk move changes the per-directory breakdown, so the search list and the
    // stats snapshot are both stale and must be cleared.
    assert.ok(invalidations.includes('search'), 'move clears the search cache');
    assert.ok(invalidations.includes('stats'), 'move clears the stats cache');
  });

  it('invalidates nothing for an all-invalid batch (processed === 0)', async () => {
    const invalidations = [];
    const res = await invokeBulk({
      readBody: async () => ({ action: 'delete', paths: ['content/missing-a.md', 'content/missing-b.md'] }),
      invalidateCache: (p) => invalidations.push(p),
      // No file exists, so every item fails "File not found" and nothing is moved.
      fs: { existsSync: () => false, mkdirSync: () => {}, renameSync: () => {} },
    });
    assert.equal(res.status, 200, 'an all-invalid batch still returns 200');
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.processed, 0, 'nothing was processed');
    // Nothing changed on disk, so neither cache prefix is cleared.
    assert.ok(!invalidations.includes('search'), 'an empty batch must not clear the search cache');
    assert.ok(!invalidations.includes('stats'), 'an empty batch must not clear the stats cache');
    assert.equal(invalidations.length, 0, 'no cache invalidation at all when processed === 0');
  });
});
