import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// apifile-badbody-500: characterization test for the outer-catch 500 branch of
// the PUT and POST blocks in api/file.js.
//
// api/file.js is the Vercel serverless handler for /api/file. It is a CommonJS
// module (module.exports = async function handler(req)), so load it the way the
// real runtime does: createRequire then require the file. This mirrors the load
// in tests/next-apifile-handler-guards.test.mjs.
const require = createRequire(import.meta.url);
const handler = require('../api/file.js');

// Both the PUT block (json() at api/file.js:31, catch returning 500 at 53 to 55)
// and the POST block (json() at 61, catch returning 500 at 81 to 83) run
// `await req.json()` as the FIRST statement inside their try. When that call
// rejects (a malformed request body), control jumps straight to the catch, which
// returns jsonResponse(500, { error: err.message }) BEFORE the isValidFilePath
// guard and before any getFile / putFile / getConfig / fetch call.
//
// The sibling suite tests/next-apifile-handler-guards.test.mjs only ever supplies
// a resolving req.json(), so it never reaches this path; these add-only cases pin
// it. The thrown message is supplied here, so every assertion is self-contained.
//
// GITHUB_TOKEN is saved, cleared, and restored around the cases (mirroring the
// env-guard idea in tests/next-apifiles-handler-guards.test.mjs). The json()
// throw fires first, so no network is touched; but if the branch order ever
// regressed and a case slipped past req.json() with a valid-looking path,
// getConfig() would throw 'GITHUB_TOKEN environment variable is not set' and
// surface as a 500 with a DIFFERENT message. Asserting the exact thrown message
// therefore distinguishes this json-throw 500 from a config / network 500 and
// keeps every case network-free.
//
// No global.fetch stub is introduced: the sibling suite has no such precedent and
// this branch never reaches fetch. jsonResponse from api/_github.js returns a web
// Response, so every assertion reads res.status and await res.json().

// Identity message the fake req.json() throws; the assertions compare against it.
const BAD_JSON_MSG = 'bad json';

// A distinctive, realistic parse message used to prove the catch echoes
// err.message verbatim rather than returning a fixed guard or config string.
const PARSE_MSG = 'Unexpected end of JSON input';

// The fixed strings the handler returns at its 400 guards; the json-throw 500
// path must never produce either of these.
const GUARD_MESSAGES = ['Invalid path', 'Content must be a string'];

// The message getConfig() throws with no token; the json-throw 500 must not be
// this, which would mean a case slipped through to the GitHub config layer.
const NO_TOKEN_MSG = 'GITHUB_TOKEN environment variable is not set';

// Build a fake req whose body fails to parse: json() rejects with a SyntaxError,
// exactly as the runtime body parser does on malformed JSON.
function badBodyReq(method, message = BAD_JSON_MSG) {
  return { method, json: async () => { throw new SyntaxError(message); } };
}

describe('api/file.js malformed-body 500 branch (network-free)', () => {
  // Force the no-token path so any accidental slip past req.json() would throw in
  // getConfig() before a fetch, never reaching the real GitHub API.
  let savedToken;
  before(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  after(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  it('PUT with a malformed body returns 500 with the thrown message as .error', async () => {
    const res = await handler(badBodyReq('PUT'));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: BAD_JSON_MSG });
  });

  it('POST with a malformed body returns 500 with the thrown message as .error', async () => {
    const res = await handler(badBodyReq('POST'));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: BAD_JSON_MSG });
  });

  it('PUT: the json-throw 500 is reached BEFORE path validation, not a 400 guard', async () => {
    // json() throws before any body materializes, so the path / content guards
    // never run: the response is the json-throw 500, not a 400. A distinctive
    // thrown message proves the catch echoes err.message rather than returning a
    // fixed guard string.
    const res = await handler(badBodyReq('PUT', PARSE_MSG));
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.notEqual(res.status, 400, 'must not reach the path / content guard');
    assert.equal(body.error, PARSE_MSG);
    assert.ok(!GUARD_MESSAGES.includes(body.error), 'must not be a 400 guard message');
  });

  it('POST: the json-throw 500 short-circuits before any network / config call', async () => {
    // With GITHUB_TOKEN cleared, a case that slipped past req.json() would yield a
    // 500 whose message is the getConfig() error, not the thrown one. Asserting
    // the exact thrown message proves the throw fired first and no fetch ran.
    const res = await handler(badBodyReq('POST', PARSE_MSG));
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, PARSE_MSG);
    assert.notEqual(body.error, NO_TOKEN_MSG, 'must not reach the GitHub config layer');
  });
});
