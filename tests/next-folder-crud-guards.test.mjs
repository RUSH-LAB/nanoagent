import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the real route module the way the
// sibling route suites do (next-files-mutation-error-branches) and reuse their
// mocked-ctx idiom. These cases pin the CURRENT behavior of the two folder
// mutation handlers in that module: create (POST /api/folder) and delete-empty
// (DELETE /api/folder). The move, restore, and trash handlers in this module are
// already covered; the folder create and delete branches were not. Every case
// runs through a mocked ctx with a mocked fs, so no real directory is ever
// created or removed, and each case asserts the mutating fs call (mkdirSync or
// rmdirSync) stayed at zero on a guard path and fired exactly once on a success
// path. The real isValidDir from server-utils.js drives path validation, exactly
// as the server wires it in production.
const require = createRequire(import.meta.url);
const folderRoutes = require('../server/routes/graph-trash-files.js');
const { isValidDir } = require('../server/server-utils.js');

const PROJECT_ROOT = '/fake/root';

// A mocked fs covering both handlers. existsSync answers per a decision function,
// statSync reports whether the path is a directory, and readdirSync returns the
// supplied entry list (its length decides the empty vs non-empty branch). The two
// mutating methods only count their calls, so each test can prove a guard path
// never created or removed a directory and a success path did so exactly once.
function makeFs({ existsSync = () => false, isDirectory = () => true, entries = [] } = {}) {
  const calls = { mkdirSync: 0, rmdirSync: 0 };
  const fs = {
    existsSync,
    statSync: () => ({ isDirectory }),
    readdirSync: () => entries,
    mkdirSync: () => { calls.mkdirSync++; },
    rmdirSync: () => { calls.rmdirSync++; },
  };
  return { fs, calls };
}

// Drive the folder route with a mocked ctx and capture the json() response.
// Mirrors the invokeRoute helper in next-files-mutation-error-branches: a fake
// res, a real URL, a socket so the rate-limit key resolves, the real isValidDir,
// and a json() that records { status, body }. rateLimit returns true so each
// handler clears its rate gate and reaches the branch under test, and readBody
// resolves to the supplied JSON body exactly as production parses the request.
async function invokeRoute({ method, body, fs }) {
  const pathname = '/api/folder';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    isValidDir,
    fs,
    rateLimit: () => true,
    readBody: async () => body,
    json(_res, status, payload) { captured = { status, body: payload }; res.writableEnded = true; return captured; },
  };
  await folderRoutes(req, res, url, pathname, ctx);
  return captured;
}

describe('POST /api/folder (create)', () => {
  it('returns 400 for a path that fails isValidDir, before any mkdir', async () => {
    const { fs, calls } = makeFs({ existsSync: () => false });
    const res = await invokeRoute({ method: 'POST', body: { path: 'docs/newfolder' }, fs });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path. Must start with content/' });
    assert.equal(calls.mkdirSync, 0, 'an invalid create path never makes a directory');
  });

  it('returns 409 when the directory already exists', async () => {
    const { fs, calls } = makeFs({ existsSync: () => true });
    const res = await invokeRoute({ method: 'POST', body: { path: 'content/existing' }, fs });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Directory already exists' });
    assert.equal(calls.mkdirSync, 0, 'a create over an existing directory never makes a directory');
  });

  it('returns 201 and calls mkdirSync once for a fresh valid path', async () => {
    const { fs, calls } = makeFs({ existsSync: () => false });
    const res = await invokeRoute({ method: 'POST', body: { path: 'content/newfolder' }, fs });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { success: true, path: 'content/newfolder' });
    assert.equal(calls.mkdirSync, 1, 'a fresh valid path makes the directory exactly once');
  });
});

describe('DELETE /api/folder (delete-empty)', () => {
  it('returns 400 for a path that fails isValidDir', async () => {
    const { fs, calls } = makeFs({ existsSync: () => true });
    const res = await invokeRoute({ method: 'DELETE', body: { path: 'docs/foo' }, fs });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path. Must start with content/' });
    assert.equal(calls.rmdirSync, 0, 'an invalid delete path never removes a directory');
  });

  it('returns 400 when the normalized path is exactly content', async () => {
    const { fs, calls } = makeFs({ existsSync: () => true });
    const res = await invokeRoute({ method: 'DELETE', body: { path: 'content' }, fs });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Cannot delete the root content directory' });
    assert.equal(calls.rmdirSync, 0, 'the root content directory is never removed');
  });

  it('returns 404 when the directory does not exist', async () => {
    const { fs, calls } = makeFs({ existsSync: () => false });
    const res = await invokeRoute({ method: 'DELETE', body: { path: 'content/missing' }, fs });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Directory not found' });
    assert.equal(calls.rmdirSync, 0, 'a missing directory is never removed');
  });

  it('returns 400 when the path is not a directory', async () => {
    const { fs, calls } = makeFs({ existsSync: () => true, isDirectory: () => false });
    const res = await invokeRoute({ method: 'DELETE', body: { path: 'content/afile.md' }, fs });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Path is not a directory' });
    assert.equal(calls.rmdirSync, 0, 'a non-directory path never removes a directory');
  });

  it('returns 400 when the directory is not empty', async () => {
    const { fs, calls } = makeFs({ existsSync: () => true, isDirectory: () => true, entries: ['a.md'] });
    const res = await invokeRoute({ method: 'DELETE', body: { path: 'content/nonempty' }, fs });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Directory is not empty' });
    assert.equal(calls.rmdirSync, 0, 'a non-empty directory is never removed');
  });

  it('returns 200 and calls rmdirSync once for an empty directory', async () => {
    const { fs, calls } = makeFs({ existsSync: () => true, isDirectory: () => true, entries: [] });
    const res = await invokeRoute({ method: 'DELETE', body: { path: 'content/empty' }, fs });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true });
    assert.equal(calls.rmdirSync, 1, 'an empty directory is removed exactly once');
  });
});
