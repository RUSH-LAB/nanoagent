import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/upload.js is the Vercel serverless handler for POST /api/upload. It is a
// CommonJS module (module.exports = async function handler(req)) that returns a
// global Response, so load it the way the real runtime and the sibling upload
// tests do: createRequire then require the file. This mirrors
// tests/next-apifile-handler-guards.test.mjs and the two existing
// tests/next-upload-*.test.mjs.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/upload.js');

// These tests lock the CURRENT, correct behavior of the network-free guard
// branches of the handler. Each case reaches a branch that returns a Response
// BEFORE getFile (and therefore before getConfig(), which throws without
// GITHUB_TOKEN), so none of them touch the GitHub API:
//
//   • OPTIONS short-circuits to optionsResponse() (status 204).
//   • Any non-POST method falls through to 405 'Method not allowed'.
//   • A POST with no file name returns 400 'Missing file name' before the body
//     read and the GitHub lookup, whether the name query is absent or empty,
//     and even when a valid dir is supplied (the missing-name guard precedes
//     the directory guard).
//
// The extension guard ('Invalid image type') and the directory guard ('Invalid
// directory') are deliberately NOT re-covered here: tests/next-upload-extslice
// and tests/next-upload-restrict-static-img already pin them. No GITHUB_TOKEN
// management is needed, because every case returns before getConfig() reads the
// token; the assertions are additive and touch no source file.
//
// jsonResponse / optionsResponse from api/_github.js return a web Response, so
// each assertion reads res.status and (for the JSON branches) await res.json().
// The 204 body is intentionally not read: optionsResponse() sends a null body,
// which is not valid JSON.

// Run a fake req through the handler and read back the status plus parsed JSON
// body (null when the body is empty or not JSON, as for a 204).
async function call(req) {
  const res = await handler(req);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// Minimal fake POST req: the file name is read from the query string, and the
// stub arrayBuffer() matches the runtime shape. The guard branches covered here
// all return before arrayBuffer() is read, so the stub is never invoked.
function postReq(search = '') {
  return {
    method: 'POST',
    url: '/api/upload' + search,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

// ─── OPTIONS preflight ────────────────────────────────────────────────────────

describe('POST /api/upload OPTIONS preflight (network-free)', () => {
  it('OPTIONS short-circuits to optionsResponse() with status 204', async () => {
    const res = await handler({ method: 'OPTIONS' });
    assert.equal(res.status, 204);
  });
});

// ─── Method guard: only POST is accepted ──────────────────────────────────────

describe('POST /api/upload method guard (network-free)', () => {
  // The method check runs ahead of any url parsing, body read, or GitHub call,
  // so a bare { method } is all each case needs to reach the 405 branch.
  it('GET returns 405 Method not allowed', async () => {
    const r = await call({ method: 'GET' });
    assert.equal(r.status, 405);
    assert.deepEqual(r.body, { error: 'Method not allowed' });
  });

  it('PUT returns 405 Method not allowed', async () => {
    const r = await call({ method: 'PUT' });
    assert.equal(r.status, 405);
    assert.deepEqual(r.body, { error: 'Method not allowed' });
  });
});

// ─── Missing-name guard (returns before the body read and any GitHub call) ────

describe('POST /api/upload Missing file name guard (network-free)', () => {
  it('POST with no name query returns 400 Missing file name', async () => {
    const r = await call(postReq(''));
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'Missing file name' });
  });

  it('POST with an empty name query returns 400 Missing file name', async () => {
    const r = await call(postReq('?name='));
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'Missing file name' });
  });

  it('POST with a valid dir but no name returns 400 Missing file name', async () => {
    // The missing-name guard runs ahead of the directory guard, so a present,
    // valid dir does not substitute for an absent name.
    const r = await call(postReq('?dir=static/img/uploads'));
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'Missing file name' });
  });
});
