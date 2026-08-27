import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Characterization test: apifilerename-badbody-500
//
// api/file-rename.js is the Vercel serverless handler for POST /api/file/rename.
// It is a CommonJS module (module.exports = async function handler(req)), so load
// it the way the real runtime does: createRequire then require the file. This
// mirrors tests/next-apifilerename-handler-guards.test.mjs, which loads the same
// module and asserts via res.status plus await res.json().
const require = createRequire(import.meta.url);
const handler = require('../../../../api/file-rename.js');

// This suite pins the CURRENT, network-free behavior of the OUTER-CATCH 500
// branch. Inside the single outer try, `const body = await req.json()` is the
// FIRST statement, ahead of the isValidFilePath 400 guard and ahead of every
// getFile / putFile / deleteFile call. When req.json() rejects, control jumps
// straight to the outer catch, which returns:
//
//     jsonResponse(500, { error: err.message })
//
// So a body that fails to parse yields HTTP 500 whose `.error` echoes the thrown
// message verbatim. The sibling guard suite never exercises this path: its
// postReq() always resolves req.json() to { oldPath, newPath }, so the reject
// branch had zero assertions until now.
//
// GITHUB_TOKEN is saved, cleared for the cases, and restored afterward. The
// json() reject short-circuits before getConfig() is ever consulted, so this
// path makes no request regardless; clearing the token is a tripwire. If the
// branch order ever regressed and a case slipped past req.json() into the
// network sequence, getConfig() would throw 'GITHUB_TOKEN environment variable
// is not set' and the asserted `.error` (our own parse message) would stop
// matching, failing loudly rather than reaching the real GitHub API. No
// global.fetch stub is installed; this branch needs none.

// Build a fake POST req whose body parse rejects with a caller-supplied message,
// so each assertion is self-contained: it owns the exact string it expects back.
function badBodyReq(message) {
  return {
    method: 'POST',
    json: async () => { throw new SyntaxError(message); },
  };
}

// ─── Malformed-body outer-catch 500 ───────────────────────────────────────────

describe('api/file-rename.js malformed-body 500 (outer catch, network-free)', () => {
  let savedToken;

  before(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  after(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  it('POST whose req.json() rejects returns 500 with the thrown message as .error', async () => {
    const res = await handler(badBodyReq('bad json'));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'bad json' });
  });

  it('the json() reject short-circuits to 500 BEFORE the isValidFilePath 400 guard', async () => {
    // `await req.json()` runs ahead of `const { oldPath, newPath } = body` and
    // ahead of isValidFilePath, so a rejecting body can never reach the 400
    // 'Invalid path' branch even when its would-be paths would have validated:
    // it surfaces as the outer-catch 500 instead. Pin both the status and the
    // message so a future reordering that ran the path guard first is caught.
    const res = await handler(badBodyReq('Unexpected end of JSON input'));
    assert.equal(res.status, 500);
    assert.notEqual(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error, 'Unexpected end of JSON input');
    assert.notEqual(payload.error, 'Invalid path');
  });

  it('a second thrown message also round-trips as .error (catch echoes err.message, not a fixed string)', async () => {
    const res = await handler(badBodyReq('Unexpected token < in JSON at position 0'));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Unexpected token < in JSON at position 0' });
  });

  it('the handler resolves to a Response (the json() rejection is caught, never propagated)', async () => {
    // The outer try/catch swallows the rejection, so handler() resolves to a
    // 500 Response rather than rejecting. This locks the catch as the boundary.
    const res = await handler(badBodyReq('caught not propagated'));
    assert.ok(res instanceof Response);
    assert.equal(res.status, 500);
  });
});
