import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/upload.js is a CommonJS Vercel serverless handler that returns a global
// Response; load it the way the other api/ handlers would be loaded.
const require = createRequire(import.meta.url);
const handler = require('../api/upload.js');

// Invoke POST /api/upload with the given query string and read back the status
// plus parsed JSON body. The stub arrayBuffer() lets a name that PASSES the
// extension and directory guards advance to the GitHub layer without a real body.
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

describe('POST /api/upload extension validation (slice form)', () => {
  // Force the no-token path so a name whose extension PASSES validation slips
  // past the guard and surfaces a 500 from getConfig() (reached via getFile),
  // never a real network call. That keeps an accepted extension (500) cleanly
  // distinguishable from a rejected one (400 "Invalid image type").
  let savedToken;
  before(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  after(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  // Accepted: a mixed-case ".PNG" suffix lowercases to ".png", which is allowed,
  // so the request is NOT rejected on the extension check. With no token it
  // reaches the GitHub layer and returns 500, proving the extension passed.
  it('accepts photo.PNG (no 400 Invalid image type; reaches GitHub layer)', async () => {
    const r = await callUpload('?name=photo.PNG');
    assert.notEqual(r.status, 400, 'a .png name must pass the extension guard');
    if (r.body) {
      assert.notEqual(r.body.error, 'Invalid image type');
    }
    assert.equal(r.status, 500, 'an accepted extension reaches the GitHub layer (no token, so 500)');
  });

  // Accepted, multi-dot: only the final segment is the extension, so
  // "photo.tar.png" validates as ".png" (allowed), the mirror image of the
  // rejected "archive.tar.gz" below. This pins the "after the LAST dot"
  // semantics the slice form relies on; a first-dot parse would read ".tar.png".
  it('accepts photo.tar.png (last segment .png; reaches GitHub layer)', async () => {
    const r = await callUpload('?name=photo.tar.png');
    assert.notEqual(r.status, 400, 'a multi-dot name ending in .png must pass the extension guard');
    if (r.body) {
      assert.notEqual(r.body.error, 'Invalid image type');
    }
    assert.equal(r.status, 500, 'an accepted extension reaches the GitHub layer (no token, so 500)');
  });

  // Rejected: only the final dot-separated segment is the extension, so
  // "archive.tar.gz" validates as ".gz" (not ".tar"), which is not an allowed
  // image type. This is the multi-dot case the slice form must keep identical.
  it('rejects archive.tar.gz with 400 Invalid image type', async () => {
    const r = await callUpload('?name=archive.tar.gz');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Invalid image type');
  });

  // Rejected: with no dot at all, lastIndexOf returns -1 and slice(0) yields the
  // whole string, so the computed ext is ".noextension", which is not allowed.
  it('rejects noextension with 400 Invalid image type', async () => {
    const r = await callUpload('?name=noextension');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Invalid image type');
  });
});
