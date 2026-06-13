import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/file.js is the Vercel serverless handler for /api/file. It is a CommonJS
// module (module.exports = async function handler(req)), so load it the way the
// real runtime does: createRequire then require the file. This mirrors
// tests/next-apigithub-pathguard-test.test.mjs, which loads api/_github.js.
const require = createRequire(import.meta.url);
const handler = require('../api/file.js');

// These tests lock the CURRENT, correct behavior of the network-free guard and
// dispatch branches of the handler. Every case reaches a branch that returns a
// Response BEFORE getFile / putFile / deleteFile is ever called, so none of them
// touch the GitHub API:
//
//   • OPTIONS short-circuits to optionsResponse() (status 204).
//   • An invalid path fails isValidFilePath and returns 400 'Invalid path'
//     before any network call, for GET, DELETE, PUT, and POST.
//   • A valid path with non-string content returns 400 'Content must be a
//     string' before the getFile lookup, for PUT and POST.
//   • An unsupported method falls through to 405 'Method not allowed'.
//
// GITHUB_TOKEN is intentionally left unset: getConfig() throws without it, so if
// any case accidentally reached the network path the test would fail loudly
// instead of making a real request. The assertions capture what the code does
// today; they are additive and touch no source file.
//
// jsonResponse / optionsResponse from api/_github.js return a web Response, so
// every assertion reads res.status and (for the JSON branches) await res.json().

// Build a minimal fake req for GET / DELETE, where the path comes from the query.
function queryReq(method, p) {
  return { method, url: '/api/file?path=' + encodeURIComponent(p) };
}

// Build a minimal fake req for PUT / POST, where the body comes from req.json().
function bodyReq(method, body) {
  return { method, json: async () => body };
}

const INVALID_PATH = '../etc/passwd'; // contains '..', so isValidFilePath rejects it
const VALID_PATH = 'content/note.md'; // passes isValidFilePath (content/ prefix, .md ext)

// ─── Method dispatch ──────────────────────────────────────────────────────────

describe('api/file.js handler dispatch (network-free)', () => {
  it('OPTIONS short-circuits to optionsResponse() with status 204', async () => {
    const res = await handler({ method: 'OPTIONS' });
    assert.equal(res.status, 204);
  });

  it('an unsupported method (PATCH) returns 405 Method not allowed', async () => {
    const res = await handler({ method: 'PATCH' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  });
});

// ─── Invalid-path guard (returns before any GitHub call) ──────────────────────

describe('api/file.js Invalid path guard (network-free)', () => {
  it('GET with an invalid path query returns 400 Invalid path', async () => {
    const res = await handler(queryReq('GET', INVALID_PATH));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });

  it('DELETE with an invalid path query returns 400 Invalid path', async () => {
    const res = await handler(queryReq('DELETE', INVALID_PATH));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });

  it('PUT with an invalid path in the body returns 400 Invalid path', async () => {
    const res = await handler(bodyReq('PUT', { path: INVALID_PATH, content: 'x' }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });

  it('POST with an invalid path in the body returns 400 Invalid path', async () => {
    const res = await handler(bodyReq('POST', { path: INVALID_PATH, content: 'x' }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });
});

// ─── Content-type guard (path is valid, content is not a string) ──────────────

describe('api/file.js Content must be a string guard (network-free)', () => {
  it('PUT with a valid path but non-string content returns 400 Content must be a string', async () => {
    const res = await handler(bodyReq('PUT', { path: VALID_PATH, content: 123 }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Content must be a string' });
  });

  it('POST with a valid path but non-string content returns 400 Content must be a string', async () => {
    const res = await handler(bodyReq('POST', { path: VALID_PATH, content: 123 }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Content must be a string' });
  });
});
