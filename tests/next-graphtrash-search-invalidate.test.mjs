import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the sibling route suites do
// (next-graph-fileinfo-cache, next-filesearch-list-cache) and reuse their
// ctx-mocking shape. GET /api/files/search in files.js serves a flat file list from
// cached('search:list', 30000, () => flatFiles(fullDir)); two mutating handlers in
// this module change that file set, so each must clear the 'search' cache prefix the
// way files.js create/delete/rename do. These tests drive each handler with a mock
// fs and a spying invalidateCache (no network, no server) and prove the invalidation
// fires: 'search' for a move (a path change), and both 'search' and 'stats' for a
// restore (a restored file reappears in the tree and changes the file count).
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/fake/root';
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');

// Drive an arbitrary graph-trash-files.js route with a mocked ctx and capture the
// json() response. The spying invalidateCache lives in each test's ctx so the test
// owns the recorded-calls array. Mirrors the invokeRoute helper in
// next-filesearch-list-cache.test.mjs.
async function invokeRoute({ method, pathname, ctx }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('POST /api/file/move clears the "search" cache prefix', () => {
  it('invalidates search after a successful move and leaves stats untouched', async () => {
    const invalidations = [];
    const fullSource = path.join(PROJECT_ROOT, 'content/old/note.md');
    const ctx = {
      path, PROJECT_ROOT,
      rateLimit: () => true,
      isValidFilePath: () => true,
      isValidDir: () => true,
      readBody: async () => ({ filePath: 'content/old/note.md', targetDir: 'content/new' }),
      invalidateCache: (p) => invalidations.push(p),
      // Source exists, target does not, so the rename runs to completion.
      fs: { existsSync: (p) => p === fullSource, mkdirSync: () => {}, renameSync: () => {} },
    };
    const res = await invokeRoute({ method: 'POST', pathname: '/api/file/move', ctx });
    assert.equal(res.status, 200, 'a valid move returns 200');
    assert.equal(res.payload.success, true);
    assert.ok(invalidations.includes('search'), 'move clears the search cache');
    // A move changes only a file's path, not the file count, so the content stats
    // snapshot stays valid and must not be cleared.
    assert.ok(!invalidations.includes('stats'), 'move must not clear the stats cache');
  });
});

describe('POST /api/trash/restore clears the "search" and "stats" cache prefixes', () => {
  it('invalidates both search and stats after a successful restore', async () => {
    const invalidations = [];
    const trashPath = '.trash/content/2024-01-02T03-04-05-678Z_note.md';
    const fullTrashPath = path.join(PROJECT_ROOT, trashPath);
    const ctx = {
      path, PROJECT_ROOT, TRASH_DIR,
      rateLimit: () => true,
      isValidFilePath: () => true,
      readBody: async () => ({ trashPath }),
      invalidateCache: (p) => invalidations.push(p),
      // The trashed file exists; its restored original path does not, so the restore
      // runs to completion.
      fs: { existsSync: (p) => p === fullTrashPath, mkdirSync: () => {}, renameSync: () => {} },
    };
    const res = await invokeRoute({ method: 'POST', pathname: '/api/trash/restore', ctx });
    assert.equal(res.status, 200, 'a valid restore returns 200');
    assert.equal(res.payload.success, true);
    // A restored file reappears in the content tree and bumps the file count, the
    // inverse of a delete, so both the search list and the content stats are cleared.
    assert.ok(invalidations.includes('search'), 'restore clears the search cache');
    assert.ok(invalidations.includes('stats'), 'restore clears the stats cache');
  });
});
