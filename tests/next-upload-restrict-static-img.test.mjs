import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/upload.js is a CommonJS Vercel serverless handler that returns a global
// Response; load it the way the other api/ handlers would be loaded.
const require = createRequire(import.meta.url);
const handler = require('../api/upload.js');

// Invoke POST /api/upload with the given query string and read back the status
// plus parsed JSON body from the Response the handler returns. The stub
// arrayBuffer() lets a dir that PASSES validation advance to the GitHub layer
// without a real request body.
async function callUpload(search = '') {
  const req = {
    method: 'POST',
    url: '/api/upload' + search,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const res = await handler(req);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe('POST /api/upload static/img/ dir restriction', () => {
  // Force the no-token path so a `dir` that PASSES validation short-circuits in
  // getConfig() (reached via getFile) with a 500 before any fetch. That keeps
  // every case pure (no network) and makes the guard rejection (400)
  // distinguishable from a request that reached the GitHub layer (500).
  let savedToken;
  before(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  after(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  // ── Rejection direction: a dir outside static/img/ is refused ─────────────
  // Each carries a valid image `name` so the request reaches the dir guard
  // rather than short-circuiting on the missing-name or extension checks.
  const outOfArea = [
    '?dir=content/secret&name=x.png',
    '?dir=src/whatever&name=x.png',
    '?dir=static&name=x.png',
    '?dir=static/imgur&name=x.png', // shares the prefix but not the / boundary
    '?dir=public/static/img/uploads&name=x.png',
  ];

  for (const search of outOfArea) {
    it(`rejects ${search} with 400 Invalid directory`, async () => {
      const r = await callUpload(search);
      assert.equal(r.status, 400, 'an out-of-area dir must be a 400, not a 500');
      assert.equal(r.body.error, 'Invalid directory');
      assert.notEqual(r.status, 500, 'must not reach the GitHub config/network layer');
    });
  }

  it('still rejects a "static/img/" dir that escapes via ".." with 400', async () => {
    // 'static/img/../../secret' starts with static/img/ yet contains '..', so
    // the preserved traversal clause must still fire ahead of any network call.
    const r = await callUpload('?dir=static/img/../../secret&name=x.png');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Invalid directory');
  });

  // ── No over-rejection: a static/img/ dir is NOT refused by this clause ─────
  // With no token it slips past the guard and surfaces a 500 from the GitHub
  // layer; that 500 (not a 400) proves the dir was accepted. This is the
  // unchanged pre-fix behavior for valid dirs; no happy path / network is hit.
  const legit = [
    '?name=x.png', // absent dir defaults to static/img/uploads
    '?dir=static/img/uploads&name=x.png',
    '?dir=static/img/&name=x.png',
    '?dir=static/img/posts/2026&name=x.png',
  ];

  for (const search of legit) {
    const label = search.includes('dir=') ? search : '(absent dir)';
    it(`does not reject ${label} with the dir guard`, async () => {
      const r = await callUpload(search);
      assert.notEqual(r.status, 400, 'a static/img/ dir must pass validation');
      if (r.body) {
        assert.notEqual(r.body.error, 'Invalid directory');
      }
      assert.equal(r.status, 500, 'a valid dir reaches the GitHub layer (no token => 500)');
    });
  }
});
