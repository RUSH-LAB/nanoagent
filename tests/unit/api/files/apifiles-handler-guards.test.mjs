import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/files.js is the Vercel serverless handler for GET /api/files. It is a
// CommonJS module (module.exports = async function handler(req)), so load it the
// way the real runtime does: createRequire then require the file. This mirrors
// tests/next-apifile-handler-guards.test.mjs, which loads api/file.js the same way.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/files.js');

// These tests lock the CURRENT, correct behavior of the network-free guard and
// dispatch branches of the handler. Every case reaches a branch that returns a
// Response BEFORE the try block calls listTree() (which itself calls
// getConfig()), so none of them touch the GitHub API:
//
//   • OPTIONS short-circuits to optionsResponse() (status 204).
//   • A non-GET method falls through to 405 'Method not allowed'.
//   • A GET whose `dir` is neither 'content' nor starts with 'content/' (and
//     contains no '..') returns 400 'Invalid directory' before getConfig().
//
// The '..' traversal half of the directory guard is already pinned by
// tests/next-files-dir-reject-dotdot.test.mjs, and the pure buildTree helper by
// tests/next-apifiles-buildtree-singlepass.test.mjs; neither is re-covered here.
//
// GITHUB_TOKEN is saved, cleared, and restored around the cases. With no token a
// case that accidentally fell through the guard would reach getConfig(), which
// throws and surfaces as a loud 500 instead of a real request; the 'Invalid
// directory' cases assert the status is NOT 500 to prove the guard fired first.
//
// jsonResponse / optionsResponse from api/_github.js return a web Response, so
// every assertion reads res.status and (for the JSON branches) await res.json().

// Minimal fake req: GET carries its `dir` in the query string; other methods
// only need `method`. The handler reads nothing else off req for these branches.
function getReq(search = '') {
  return { method: 'GET', url: '/api/files' + search };
}

describe('GET /api/files dispatch and invalid-directory guards (network-free)', () => {
  // Force the no-token path so a value that PASSES the guard short-circuits in
  // getConfig() with a 500 before any fetch, keeping every case pure and making
  // a guard rejection (400) distinguishable from reaching the GitHub layer (500).
  let savedToken;
  before(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  after(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  // ── Method dispatch ────────────────────────────────────────────────────────
  it('OPTIONS short-circuits to optionsResponse() with status 204', async () => {
    // optionsResponse() returns a 204 with a null body, so do not read json().
    const res = await handler({ method: 'OPTIONS' });
    assert.equal(res.status, 204);
  });

  it('POST returns 405 Method not allowed before any GitHub call', async () => {
    const res = await handler({ method: 'POST', url: '/api/files' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  });

  it('PUT returns 405 Method not allowed', async () => {
    const res = await handler({ method: 'PUT', url: '/api/files' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  });

  it('DELETE returns 405 Method not allowed', async () => {
    const res = await handler({ method: 'DELETE', url: '/api/files' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  });

  it('PATCH returns 405 Method not allowed', async () => {
    const res = await handler({ method: 'PATCH', url: '/api/files' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  });

  // ── Invalid directory with no '..' (the non-content half of the guard) ───────
  it('GET ?dir=secret returns 400 Invalid directory, not 500', async () => {
    // 'secret' !== 'content' and does not start with 'content/', so the guard
    // fires before getConfig(); a 500 here would mean the value slipped through.
    const res = await handler(getReq('?dir=secret'));
    assert.equal(res.status, 400);
    assert.notEqual(res.status, 500, 'must not reach the GitHub config/network layer');
    assert.deepEqual(await res.json(), { error: 'Invalid directory' });
  });

  it('GET ?dir=content-x returns 400 Invalid directory (startsWith boundary), not 500', async () => {
    // 'content-x' shares the 'content' prefix but is not 'content' and does not
    // start with 'content/', guarding the startsWith('content/') boundary.
    const res = await handler(getReq('?dir=content-x'));
    assert.equal(res.status, 400);
    assert.notEqual(res.status, 500, 'must not reach the GitHub config/network layer');
    assert.deepEqual(await res.json(), { error: 'Invalid directory' });
  });
});
