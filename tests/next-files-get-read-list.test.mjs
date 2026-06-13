import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load the real route module and the real path validator
// the way the sibling suite (next-files-mutation-error-branches) does, then drive
// each handler through a mocked ctx. These cases pin the CURRENT behavior of the
// two GET read paths the mutation suite leaves uncovered: GET /api/file (single
// file read) and GET /api/files (directory list). Only the create, delete, and
// rename branches were characterized before; the bare GET read and list branches
// were never exercised through this module.
//
// Every case runs through a mocked ctx so no real filesystem read ever happens:
// the read handler is given a fake fs.readFileSync, and the list handler is given
// fake isValidDir and walkDir helpers, which is exactly how server.js supplies
// them in production. The real isValidFilePath from server-utils.js drives path
// validation for the read branch, matching how the server wires it.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');
const { isValidFilePath } = require('../server/server-utils.js');

const PROJECT_ROOT = '/fake/root';

// Drive an arbitrary files.js route with a mocked ctx and capture the json()
// response. Mirrors the invokeRoute helper in next-files-mutation-error-branches:
// a fake res, a real URL, the matching pathname, and a json() that records
// { status, body }. The req carries a socket and rateLimit returns true to keep
// the harness identical to that sibling; neither GET branch here rate-limits, so
// they are inert for these cases. Per-test ctx fields (fs, isValidDir, walkDir)
// are spread in last, so each case supplies only the helpers its branch reads.
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

describe('GET /api/file (read) branches', () => {
  it('returns 400 for an invalid path and never touches the filesystem', async () => {
    let reads = 0;
    const fs = { readFileSync: () => { reads++; return ''; } };
    const res = await invokeRoute({
      method: 'GET',
      pathname: '/api/file',
      search: '?path=../bad',
      ctx: { fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path' });
    assert.equal(reads, 0, 'a rejected path is never read');
  });

  it('returns 200 with the file content on a successful read', async () => {
    let readPath = null;
    let readEncoding = null;
    const fs = { readFileSync: (p, encoding) => { readPath = p; readEncoding = encoding; return 'file body text'; } };
    const res = await invokeRoute({
      method: 'GET',
      pathname: '/api/file',
      search: '?path=content/ok.md',
      ctx: { fs },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { content: 'file body text' });
    assert.equal(readPath, path.join(PROJECT_ROOT, 'content/ok.md'), 'reads the path joined under PROJECT_ROOT');
    assert.equal(readEncoding, 'utf-8', 'reads as utf-8 so the handler returns a string, not a Buffer');
  });

  it('returns 404 when the read throws', async () => {
    const fs = { readFileSync: () => { throw new Error('ENOENT'); } };
    const res = await invokeRoute({
      method: 'GET',
      pathname: '/api/file',
      search: '?path=content/missing.md',
      ctx: { fs },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
  });
});

describe('GET /api/files (list) branches', () => {
  it('returns 400 when the directory is invalid and never walks it', async () => {
    let walks = 0;
    const res = await invokeRoute({
      method: 'GET',
      pathname: '/api/files',
      search: '?dir=../bad',
      ctx: { isValidDir: () => false, walkDir: () => { walks++; return []; } },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid directory' });
    assert.equal(walks, 0, 'a rejected directory is never walked');
  });

  it('returns 200 with the walked file list on success', async () => {
    let walkArg = null;
    const files = [
      { name: 'a.md', path: 'content/a.md' },
      { name: 'b.md', path: 'content/b.md' },
    ];
    const res = await invokeRoute({
      method: 'GET',
      pathname: '/api/files',
      search: '?dir=content',
      ctx: { isValidDir: () => true, walkDir: (p) => { walkArg = p; return files; } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { files });
    assert.equal(walkArg, path.join(PROJECT_ROOT, 'content'), 'walks the dir joined under PROJECT_ROOT');
  });

  it('returns 200 with an empty list when the directory has no files', async () => {
    const res = await invokeRoute({
      method: 'GET',
      pathname: '/api/files',
      search: '?dir=content',
      ctx: { isValidDir: () => true, walkDir: () => [] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { files: [] });
  });

  it('returns 404 when the walk throws', async () => {
    const res = await invokeRoute({
      method: 'GET',
      pathname: '/api/files',
      search: '?dir=content',
      ctx: { isValidDir: () => true, walkDir: () => { throw new Error('ENOENT'); } },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Directory not found' });
  });
});
