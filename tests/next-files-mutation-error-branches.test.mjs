import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load the real route module the way the sibling route
// suites do (next-filesearch-list-cache, next-recommendv2-cache) and reuse their
// mocked-ctx shape. These tests pin the CURRENT 400 / 404 / 409 validation
// branches of the three file mutation handlers: create (POST /api/file), delete
// (DELETE /api/file) and rename (POST /api/file/rename). Only the 200 happy
// paths were covered before. Every case runs through a mocked ctx with a mocked
// fs, so no real filesystem write, move, or delete ever happens, and each case
// also asserts the mutating fs calls were never reached on the error path. The
// real isValidFilePath from server-utils.js drives path validation, exactly as
// the server wires it in production.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');
const { isValidFilePath } = require('../server/server-utils.js');

const PROJECT_ROOT = '/fake/root';

// A mocked fs whose existsSync answers per a decision function of the absolute
// path, so a rename case can make the source exist while the target does not (or
// both exist), and a create or delete case can force a specific branch. The
// mutating methods only count their calls; the error branches under test return
// before any of them run, and each test asserts the count stayed at zero.
function makeFs(existsSync) {
  const calls = { mkdirSync: 0, writeFileSync: 0, renameSync: 0 };
  const fs = {
    existsSync,
    mkdirSync: () => { calls.mkdirSync++; },
    writeFileSync: () => { calls.writeFileSync++; },
    renameSync: () => { calls.renameSync++; },
  };
  return { fs, calls };
}

// Drive an arbitrary files.js route with a mocked ctx and capture the json()
// response. Mirrors the invokeRoute helper in next-filesearch-list-cache: a fake
// res, a real URL, a socket so the rate-limit key resolves, and a json() that
// records { status, body }. rateLimit returns true so every handler clears its
// rate gate and reaches the validation branch under test.
async function invokeRoute({ method, pathname, search = '', ctx }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    path,
    PROJECT_ROOT,
    isValidFilePath,
    rateLimit: () => true,
    invalidateCache: () => {},
    json(_res, status, body) { captured = { status, body }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await filesRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('POST /api/file (create) error branches', () => {
  it('returns 400 when content is not a string', async () => {
    const { fs, calls } = makeFs(() => false);
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: 'content/ok.md', content: 123 }), fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Content must be a string' });
    assert.equal(calls.writeFileSync, 0, 'a rejected create never writes');
  });

  it('returns 400 when content exceeds 50000 characters', async () => {
    const { fs, calls } = makeFs(() => false);
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: 'content/ok.md', content: 'a'.repeat(50001) }), fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Content must be 50000 characters or fewer' });
    assert.equal(calls.writeFileSync, 0, 'an over-length create never writes');
  });

  it('returns 409 when the target file already exists', async () => {
    const { fs, calls } = makeFs(() => true);
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: 'content/exists.md', content: 'x' }), fs },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'File already exists' });
    assert.equal(calls.writeFileSync, 0, 'a create over an existing file never writes');
  });
});

describe('DELETE /api/file error branches', () => {
  it('returns 400 for an invalid path', async () => {
    const { fs, calls } = makeFs(() => true);
    const res = await invokeRoute({
      method: 'DELETE',
      pathname: '/api/file',
      search: '?path=../bad',
      ctx: { fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path' });
    assert.equal(calls.renameSync, 0, 'an invalid delete path never moves a file to trash');
  });

  it('returns 404 when the file to delete does not exist', async () => {
    const { fs, calls } = makeFs(() => false);
    const res = await invokeRoute({
      method: 'DELETE',
      pathname: '/api/file',
      search: '?path=content/missing.md',
      ctx: { fs },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
    assert.equal(calls.renameSync, 0, 'a missing file is never moved to trash');
  });
});

describe('POST /api/file/rename error branches', () => {
  it('returns 400 when a path is invalid', async () => {
    const { fs, calls } = makeFs(() => true);
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file/rename',
      ctx: { readBody: async () => ({ oldPath: '../bad', newPath: 'content/new.md' }), fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path' });
    assert.equal(calls.renameSync, 0, 'an invalid rename path never renames');
  });

  it('returns 404 when the source file is missing', async () => {
    const { fs, calls } = makeFs(() => false);
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file/rename',
      ctx: { readBody: async () => ({ oldPath: 'content/old.md', newPath: 'content/new.md' }), fs },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Source not found' });
    assert.equal(calls.renameSync, 0, 'a missing source is never renamed');
  });

  it('returns 409 when the rename target already exists', async () => {
    const fullOld = path.join(PROJECT_ROOT, 'content/old.md');
    const fullNew = path.join(PROJECT_ROOT, 'content/new.md');
    // Source exists and target exists, so the handler clears the source check and
    // trips the target conflict; existsSync decides by its path argument.
    const { fs, calls } = makeFs((p) => p === fullOld || p === fullNew);
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file/rename',
      ctx: { readBody: async () => ({ oldPath: 'content/old.md', newPath: 'content/new.md' }), fs },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Target already exists' });
    assert.equal(calls.renameSync, 0, 'a rename onto an existing target never renames');
  });
});
