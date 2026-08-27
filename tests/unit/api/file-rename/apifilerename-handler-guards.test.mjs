import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/file-rename.js is the Vercel serverless handler for POST /api/file/rename.
// It is a CommonJS module (module.exports = async function handler(req)), so load
// it the way the real runtime does: createRequire then require the file. This
// mirrors tests/next-apifile-handler-guards.test.mjs, which loads api/file.js.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/file-rename.js');

// These tests lock the CURRENT, correct behavior of the network-free guard and
// dispatch branches of the rename handler. Every case reaches a branch that
// returns a Response BEFORE getFile / putFile / deleteFile is ever called, so
// none of them touch the GitHub API:
//
//   • OPTIONS short-circuits to optionsResponse() (status 204).
//   • A non-POST method falls through to 405 'Method not allowed'.
//   • A POST whose oldPath or newPath fails isValidFilePath returns 400
//     'Invalid path' before the first getFile lookup. isValidFilePath (see
//     api/_github.js) rejects '..', absolute paths, and non-string values, so
//     each invalid input below short-circuits with no network call.
//
// GITHUB_TOKEN is intentionally left unset: getConfig() throws without it, so if
// any case accidentally reached the network path the test would fail loudly
// instead of making a real request. The assertions capture what the code does
// today; they are additive and touch no source file.
//
// jsonResponse / optionsResponse from api/_github.js return a web Response, so
// every assertion reads res.status and (for the JSON branches) await res.json().

// Build a minimal fake req for OPTIONS / GET / PATCH, where only the method matters.
function methodReq(method) {
  return { method };
}

// Build a minimal fake req for POST, where the body comes from req.json().
function postReq(oldPath, newPath) {
  return { method: 'POST', json: async () => ({ oldPath, newPath }) };
}

const VALID_OLD = 'content/old.md'; // passes isValidFilePath (content/ prefix, .md ext)
const VALID_NEW = 'content/new.md'; // passes isValidFilePath
const TRAVERSAL_PATH = '../etc/passwd'; // contains '..', so isValidFilePath rejects it
const ABSOLUTE_PATH = '/content/abs.md'; // starts with '/', so isValidFilePath rejects it

// ─── Method dispatch ──────────────────────────────────────────────────────────

describe('api/file-rename.js handler dispatch (network-free)', () => {
  it('OPTIONS short-circuits to optionsResponse() with status 204', async () => {
    const res = await handler(methodReq('OPTIONS'));
    assert.equal(res.status, 204);
  });

  it('GET (a non-POST method) returns 405 Method not allowed', async () => {
    const res = await handler(methodReq('GET'));
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  });

  it('PATCH (another non-POST method) returns 405 Method not allowed', async () => {
    const res = await handler(methodReq('PATCH'));
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  });
});

// ─── Invalid-path guard (returns before any GitHub call) ──────────────────────

describe('api/file-rename.js Invalid path guard (network-free)', () => {
  it('POST with a traversal oldPath returns 400 Invalid path', async () => {
    const res = await handler(postReq(TRAVERSAL_PATH, VALID_NEW));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });

  it('POST with an absolute newPath returns 400 Invalid path', async () => {
    const res = await handler(postReq(VALID_OLD, ABSOLUTE_PATH));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });

  it('POST with a missing (undefined) oldPath returns 400 Invalid path', async () => {
    const res = await handler(postReq(undefined, VALID_NEW));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });

  it('POST with a non-string newPath returns 400 Invalid path', async () => {
    const res = await handler(postReq(VALID_OLD, 123));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });
});
