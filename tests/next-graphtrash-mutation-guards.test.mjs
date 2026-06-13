import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the real route module the way the sibling
// guard suites do (next-folder-crud-guards, next-graphtrash-export-hoist-fmre) and
// reuse their mocked-ctx idiom. These add-only cases pin the CURRENT behavior of the
// GUARD LADDERS of three mutation handlers in that module whose error rungs were
// previously unpinned: POST /api/trash/restore, POST /api/file/move, and POST
// /api/export/bundle. Existing suites cover only their success bodies, cache
// invalidation, and regex byte-identity; every 400 / 404 / 409 guard rung is new here.
//
// Each case drives the real handler over a mocked ctx (mocked fs, stubbed
// isValidFilePath / isValidDir / rateLimit / readBody), so no real filesystem,
// network, or git is ever touched. For restore and move, the mocked fs counts the two
// destructive calls (mkdirSync, renameSync) so each guard case proves no file was
// created or moved; the success branches are out of scope (already pinned elsewhere).
// The handlers read no clock, randomness, or network, so every assertion is
// deterministic.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/fake/root';
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');

// A mocked fs whose two mutating methods only count their calls, so a guard case can
// assert the destructive call count stayed at zero. existsSync is supplied per case to
// select the branch under test; readFileSync exists only so an accidental success path
// would surface as a normal assertion failure rather than a confusing TypeError.
function makeFs({ existsSync = () => false } = {}) {
  const calls = { mkdirSync: 0, renameSync: 0 };
  const fs = {
    existsSync,
    mkdirSync: () => { calls.mkdirSync++; },
    renameSync: () => { calls.renameSync++; },
    readFileSync: () => '',
  };
  return { fs, calls };
}

// An isValidFilePath stub returning a fixed sequence of booleans across successive
// calls, repeating the last value once exhausted. The move handler calls
// isValidFilePath twice (the input filePath, then the joined newPath); a [true, false]
// sequence clears the first guard and reaches the "Resulting path is invalid" rung.
function seqValidFilePath(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

// Drive one handler with a mocked ctx and capture the json() response as
// { status, body }. rateLimit defaults to a pass so each case reaches the branch under
// test; readBody resolves to the supplied body exactly as production parses a request.
async function invoke({ method, pathname, body, fs, isValidFilePath, isValidDir, rateLimit = () => true }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    TRASH_DIR,
    fs,
    isValidFilePath,
    isValidDir,
    rateLimit,
    readBody: async () => body,
    invalidateCache: () => {},
    json(_res, status, payload) { captured = { status, body: payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// A valid trash path of the shape ".trash/<subdir>/<timestamp>_<originalname>". Its
// basename matches TRASH_NAME_RE, so the restore handler clears the format guard and
// reaches the original-path checks.
const TRASH_PATH = '.trash/content/2024-01-01T00-00-00-000Z_foo.md';

describe('POST /api/trash/restore — guard ladder (routes/graph-trash-files.js)', () => {
  // Build the mocked fs per case and return both the captured response and the
  // destructive-call counts. isValidFilePath defaults to a pass; existsSync defaults to
  // a miss (makeFs), which is what the early rungs need.
  function restore(body, { existsSync, isValidFilePath = () => true } = {}) {
    const { fs, calls } = makeFs({ existsSync });
    return invoke({ method: 'POST', pathname: '/api/trash/restore', body, fs, isValidFilePath })
      .then(res => ({ res, calls }));
  }

  it('returns 400 Missing trashPath when the body has no trashPath', async () => {
    const { res, calls } = await restore({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Missing trashPath' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 400 Invalid path for a parent-traversal trashPath', async () => {
    const { res, calls } = await restore({ trashPath: '../secrets.md' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 400 Path must be within .trash/ for a path outside the trash root', async () => {
    const { res, calls } = await restore({ trashPath: 'content/foo.md' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Path must be within .trash/' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 404 Trashed file not found when the trashed file is absent', async () => {
    const { res, calls } = await restore({ trashPath: TRASH_PATH }, { existsSync: () => false });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Trashed file not found' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 400 Cannot restore when the resolved original path is invalid', async () => {
    const { res, calls } = await restore(
      { trashPath: TRASH_PATH },
      { existsSync: () => true, isValidFilePath: () => false },
    );
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Cannot restore: original path is invalid' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 409 when a file already exists at the original path', async () => {
    const { res, calls } = await restore(
      { trashPath: TRASH_PATH },
      { existsSync: () => true, isValidFilePath: () => true },
    );
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'A file already exists at the original path. Rename or delete it first.' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });
});

describe('POST /api/file/move — guard ladder (routes/graph-trash-files.js)', () => {
  it('returns 400 Invalid file path when the source path fails validation', async () => {
    const { fs, calls } = makeFs({ existsSync: () => false });
    const res = await invoke({
      method: 'POST', pathname: '/api/file/move',
      body: { filePath: 'outside/foo.md', targetDir: 'content/sub' },
      fs, isValidFilePath: () => false, isValidDir: () => true,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid file path' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 400 Invalid target directory when targetDir fails validation', async () => {
    const { fs, calls } = makeFs({ existsSync: () => false });
    const res = await invoke({
      method: 'POST', pathname: '/api/file/move',
      body: { filePath: 'content/foo.md', targetDir: 'outside' },
      fs, isValidFilePath: () => true, isValidDir: () => false,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid target directory. Must start with content/' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 404 Source file not found when the source is absent', async () => {
    const { fs, calls } = makeFs({ existsSync: () => false });
    const res = await invoke({
      method: 'POST', pathname: '/api/file/move',
      body: { filePath: 'content/foo.md', targetDir: 'content/sub' },
      fs, isValidFilePath: () => true, isValidDir: () => true,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Source file not found' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 400 Resulting path is invalid via a true-then-false isValidFilePath', async () => {
    // existsSync true clears the Source-file-not-found rung; the second isValidFilePath
    // call (on the joined newPath) returns false and trips this rung.
    const { fs, calls } = makeFs({ existsSync: () => true });
    const res = await invoke({
      method: 'POST', pathname: '/api/file/move',
      body: { filePath: 'content/foo.md', targetDir: 'content/sub' },
      fs, isValidFilePath: seqValidFilePath([true, false]), isValidDir: () => true,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Resulting path is invalid' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 409 when a file already exists at the target location', async () => {
    // existsSync true for both the source and the target reaches the target-exists rung.
    const { fs, calls } = makeFs({ existsSync: () => true });
    const res = await invoke({
      method: 'POST', pathname: '/api/file/move',
      body: { filePath: 'content/foo.md', targetDir: 'content/sub' },
      fs, isValidFilePath: () => true, isValidDir: () => true,
    });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'A file already exists at the target location' });
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });
});

describe('POST /api/export/bundle — guard ladder (routes/graph-trash-files.js)', () => {
  // The bundle guard rungs validate the request body before any fs access, so they need
  // only rateLimit, readBody, and json. The mocked fs is supplied for ctx uniformity.
  function bundle(body) {
    const { fs } = makeFs();
    return invoke({ method: 'POST', pathname: '/api/export/bundle', body, fs, isValidFilePath: () => true });
  }

  it('returns 400 Missing paths array when paths is absent or empty', async () => {
    const absent = await bundle({});
    assert.equal(absent.status, 400);
    assert.deepEqual(absent.body, { error: 'Missing paths array' });
    const empty = await bundle({ paths: [] });
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.body, { error: 'Missing paths array' });
  });

  it('returns 400 when paths exceeds the maximum length of 50', async () => {
    const res = await bundle({ paths: Array.from({ length: 51 }, () => 'content/a.md') });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'paths exceeds maximum length of 50' });
  });

  it('returns 400 All paths must be strings when an element is not a string', async () => {
    const res = await bundle({ paths: ['content/a.md', 42] });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'All paths must be strings' });
  });

  it('returns 400 format must be a string when format is a non-string', async () => {
    const res = await bundle({ paths: ['content/a.md'], format: 42 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'format must be a string' });
  });

  it('returns 400 format must be md or html for an unsupported format', async () => {
    const res = await bundle({ paths: ['content/a.md'], format: 'pdf' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'format must be md or html' });
  });
});
