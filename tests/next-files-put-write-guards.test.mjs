import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load the real route module and the real path validator the
// way the sibling suites do (next-files-mutation-error-branches,
// next-files-get-read-list), then drive the handler through a mocked ctx. These
// cases pin the CURRENT behavior of the PUT /api/file write handler, which those
// sibling suites leave entirely uncovered: they characterize the GET read/list,
// POST create, and DELETE paths, but never the PUT write path.
//
// The PUT handler is uniquely identified by its `file-write:` rate-limit key and
// its `Failed to update file:` outer-catch string. The `File not found` and
// `Content must be a string` messages are shared across many modules (the latter
// is already tested on the unrelated api/file.js), so they do not pin THIS
// handler on their own; the assertions below still check those messages, but the
// case selection keys on the write path that only this handler exercises.
//
// Every case runs through a mocked ctx with a mocked fs, so no real filesystem
// write ever happens, and each error case asserts the write was never reached. The
// real isValidFilePath from server-utils.js drives path validation, exactly as
// server.js wires it in production.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');
const { isValidFilePath } = require('../server/server-utils.js');

const PROJECT_ROOT = '/fake/root';

// A mocked fs mirroring the sibling makeFs(existsSync) call-counter, narrowed to
// the two calls the PUT handler makes: existsSync decides the 404 vs write branch,
// and writeFileSync records both its call count and its arguments so the success
// case can assert it ran exactly once with (fullPath, content, 'utf-8'). Every
// error branch returns before writeFileSync, so each case asserts the count stayed
// at zero.
function makeFs(existsSync) {
  const calls = { writeFileSync: 0 };
  let writeArgs = null;
  const fs = {
    existsSync,
    writeFileSync: (...args) => { calls.writeFileSync++; writeArgs = args; },
  };
  return { fs, calls, getWriteArgs: () => writeArgs };
}

// Drive the PUT /api/file route with a mocked ctx and capture the json() response.
// Mirrors the invokeRoute helper in the sibling suites: a fake res, a real URL, a
// socket so the rate-limit key resolves, a default rateLimit that clears the gate,
// and a json() that records { status, body }. Per-test ctx fields (fs, readBody,
// rateLimit, invalidateCache) are spread in last, so each case overrides only the
// helpers its branch exercises.
async function invokeRoute({ method, pathname, ctx }) {
  const url = new URL(`http://localhost${pathname}`);
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

describe('PUT /api/file (write) guards', () => {
  it('returns 429 before reading the body when the file-write rate limit trips', async () => {
    const { fs, calls } = makeFs(() => true);
    let bodyReads = 0;
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: {
        rateLimit: () => false,
        readBody: async () => { bodyReads++; return { path: 'content/ok.md', content: 'x' }; },
        fs,
      },
    });
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(bodyReads, 0, 'the 429 short-circuits before the try, so the body is never read');
    assert.equal(calls.writeFileSync, 0, 'a rate-limited write never writes');
  });

  it('returns 400 for an invalid path and never writes', async () => {
    const { fs, calls } = makeFs(() => true);
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: '../bad', content: 'x' }), fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path' });
    assert.equal(calls.writeFileSync, 0, 'an invalid path never writes');
  });

  it('returns 400 when content is not a string and never writes', async () => {
    const { fs, calls } = makeFs(() => true);
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: 'content/ok.md', content: 123 }), fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Content must be a string' });
    assert.equal(calls.writeFileSync, 0, 'a non-string content never writes');
  });

  it('returns 400 when content exceeds 50000 characters and never writes', async () => {
    const { fs, calls } = makeFs(() => true);
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: 'content/ok.md', content: 'a'.repeat(50001) }), fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Content must be 50000 characters or fewer' });
    assert.equal(calls.writeFileSync, 0, 'an over-length content never writes');
  });

  it('accepts content of exactly 50000 characters past the length guard, reaching the existence check', async () => {
    const { fs, calls } = makeFs(() => false);
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: 'content/ok.md', content: 'a'.repeat(50000) }), fs },
    });
    // Exactly 50000 clears `length > 50000`, so the handler proceeds to the
    // existence check; with existsSync false that surfaces as the 404, proving the
    // boundary passed rather than tripping the over-length 400.
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
    assert.equal(calls.writeFileSync, 0, 'a write to a missing file never happens');
  });

  it('returns 404 when the target file does not exist and never writes', async () => {
    const { fs, calls } = makeFs(() => false);
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: { readBody: async () => ({ path: 'content/missing.md', content: 'hello' }), fs },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
    assert.equal(calls.writeFileSync, 0, 'a missing file is never written');
  });

  it('returns 200 and writes once when the file exists, invalidating the search cache', async () => {
    const { fs, calls, getWriteArgs } = makeFs(() => true);
    const invalidated = [];
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: {
        readBody: async () => ({ path: 'content/ok.md', content: 'new body text' }),
        fs,
        invalidateCache: (key) => { invalidated.push(key); },
      },
    });
    assert.equal(res.status, 200);
    // Exactly { success: true }: the write handler returns no `path` field, unlike
    // the POST create handler which echoes { success: true, path: filePath }.
    assert.deepEqual(res.body, { success: true });
    assert.equal(calls.writeFileSync, 1, 'a valid write happens exactly once');
    assert.deepEqual(
      getWriteArgs(),
      [path.join(PROJECT_ROOT, 'content/ok.md'), 'new body text', 'utf-8'],
      'writes the joined path, the content string, and utf-8',
    );
    assert.deepEqual(invalidated, ['search'], 'invalidates only the search cache after a write');
  });

  it('returns 400 with the Failed to update file message when readBody throws', async () => {
    const { fs, calls } = makeFs(() => true);
    const res = await invokeRoute({
      method: 'PUT',
      pathname: '/api/file',
      ctx: { readBody: async () => { throw new Error('bad json'); }, fs },
    });
    assert.equal(res.status, 400);
    // The unique outer-catch string: it proves the try wraps readBody through
    // writeFileSync, while the rate-limit gate sits outside the try.
    assert.deepEqual(res.body, {
      error: 'Failed to update file: request body must be JSON with "path" (string) and "content" (string) fields',
    });
    assert.equal(calls.writeFileSync, 0, 'a body that fails to parse never writes');
  });
});
