import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/files.js is a CommonJS Vercel serverless handler that returns a global
// Response; load it the way the other api/ handlers would be loaded.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/files.js');

// Invoke GET /api/files with the given query string and read back the status
// plus parsed JSON body from the Response the handler returns.
async function callFiles(search = '') {
  const req = { method: 'GET', url: '/api/files' + search };
  const res = await handler(req);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe('GET /api/files dir traversal guard', () => {
  // Force the no-token path so a `dir` that PASSES validation short-circuits in
  // getConfig() with a 500 before any fetch. That keeps every case pure (no
  // network) and makes the guard rejection (400) distinguishable from a request
  // that reached the GitHub layer (500).
  let savedToken;
  before(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  after(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  // ── Rejection direction: a `dir` containing ".." is refused ──────────────
  const traversals = [
    '?dir=content/../secret',
    '?dir=content/..',
    '?dir=content/sub/../../etc',
    '?dir=../etc',
    '?dir=..',
  ];

  for (const search of traversals) {
    it(`rejects ${search} with 400 Invalid directory`, async () => {
      const r = await callFiles(search);
      assert.equal(r.status, 400, 'a traversal dir must be a 400, not a 500');
      assert.equal(r.body.error, 'Invalid directory');
    });
  }

  it('rejects content/../secret before any network call', async () => {
    // With no token present, a `dir` that slipped past the guard would reach
    // getConfig() and return a 500 GITHUB_TOKEN error. A clean 400 here proves
    // the `..` guard fired first, ahead of listTree()/fetch.
    const r = await callFiles('?dir=content/../secret');
    assert.equal(r.status, 400);
    assert.notEqual(r.status, 500, 'must not reach the GitHub config/network layer');
    assert.equal(r.body.error, 'Invalid directory');
  });

  // ── No over-rejection: legitimate `dir` values are unaffected ────────────
  const legit = ['', '?dir=content', '?dir=content/posts', '?dir=content/posts/sub'];

  for (const search of legit) {
    const label = search || '(absent dir)';
    it(`does not reject ${label} with the traversal guard`, async () => {
      const r = await callFiles(search);
      assert.notEqual(r.status, 400, 'a clean dir must pass validation');
      if (r.body) {
        assert.notEqual(r.body.error, 'Invalid directory');
      }
      // It passed the guard and reached the GitHub layer, which (no token)
      // surfaces as a 500. This is the unchanged pre-fix behavior; no happy
      // path / network is asserted.
      assert.equal(r.status, 500);
    });
  }
});
