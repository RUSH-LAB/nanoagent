import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/upload.js is the Vercel serverless handler for POST /api/upload. It is a
// CommonJS module (module.exports = async function handler(req)) that returns a
// global Response, so load it the way the real runtime and the sibling upload
// tests do: createRequire then require the file. getConfig and GITHUB_API come
// from api/_github.js so the expected request URLs are derived from the module
// rather than hardcoded. This mirrors the createRequire load in
// tests/next-apifile-handler-guards.test.mjs.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/upload.js');
const { getConfig, GITHUB_API } = require('../../../../api/_github.js');

// After its method, name, extension, and directory guards the handler reads the
// request body, calls getFile (from api/_github.js) to look up an existing sha,
// then issues a raw PUT fetch to the GitHub Contents API. The three existing
// upload suites (next-apiupload-handler-guards, next-upload-restrict-static-img,
// next-upload-extslice) all stop at a guard or the no-token 500, so the
// network-driven branches pinned below were never exercised.
//
// Every case here is deterministic: there is NO real network, NO clock, and NO
// randomness. globalThis.fetch is replaced with an in-memory stub that routes by
// HTTP method, so the GET that getFile performs and the PUT that the handler
// issues each resolve to a caller-set web Response. GITHUB_TOKEN is set to a dummy
// so getConfig() succeeds and execution reaches fetch; the original fetch and the
// GITHUB_* env vars are saved before the suite and restored after it, so the suite
// leaves both process.env and globalThis.fetch exactly as it found them. The
// assertions are additive and touch no source file; every expected value is
// derived from the real module.
//
// Branches pinned here, each isolated by the stubbed GET/PUT responses:
//   • getFile 404 => file treated as new (no sha), PUT ok => 200 success + URL.
//   • getFile 200 with a sha => PUT body carries that sha (overwrite) => 200.
//   • PUT not ok with a JSON message => 500 carrying that message.
//   • PUT not ok with a message-less JSON body => 500 default 'Upload failed'.
//   • PUT not ok with a non-JSON body => json() rejects, the catch yields {}, so
//     500 default 'Upload failed'.
//   • getFile throws a non-404 => rethrown to the outer catch => 500
//     'Upload failed: <message>'; the PUT is never reached.

const GH_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
const savedEnv = {};
const realFetch = globalThis.fetch;

// Per-case state for the fetch stub: recorded calls plus the Response each leg
// should resolve to. beforeEach resets all three so cases never bleed.
let fetchCalls = [];
let getResponse = null;
let putResponse = null;

// Build a web Response with a JSON body and the given status.
function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Build a web Response with a raw (non-JSON) body, so res.json() rejects.
function rawRes(status, text, contentType) {
  return new Response(text, { status, headers: { 'Content-Type': contentType } });
}

// A tiny, deterministic image body. Uint8Array([...]).buffer is exactly sized
// (byteOffset 0, no Buffer-pool padding), so Buffer.from(it) round-trips to the
// same base64 the handler computes from the ArrayBuffer it reads.
const UPLOAD_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
const EXPECTED_B64 = Buffer.from(UPLOAD_BYTES).toString('base64');

// Invoke POST /api/upload with the given query string and read back the status
// plus parsed JSON body. arrayBuffer() returns the upload body the handler reads.
async function callUpload(search = '') {
  const req = {
    method: 'POST',
    url: '/api/upload' + search,
    arrayBuffer: async () => UPLOAD_BYTES.buffer,
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

before(() => {
  for (const k of GH_KEYS) savedEnv[k] = process.env[k];
  // A token is required so getConfig() does not throw on the network path. Clear
  // the repo/branch overrides so the module defaults drive the URL; expected
  // values are then read from getConfig() rather than hardcoded.
  delete process.env.GITHUB_REPO;
  delete process.env.GITHUB_BRANCH;
  process.env.GITHUB_TOKEN = 'tok_test_123';
  // The handler issues up to two fetch calls per request: a GET inside getFile,
  // then a PUT for the upload itself. Route by opts.method (getFile passes no
  // method, so it defaults to GET) and record every call so a test can assert
  // the PUT body and the call ordering.
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    const method = (opts && opts.method) || 'GET';
    return method === 'PUT' ? putResponse : getResponse;
  };
});

after(() => {
  globalThis.fetch = realFetch;
  for (const k of GH_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  fetchCalls = [];
  getResponse = null;
  putResponse = null;
});

// ─── Success: new file (getFile 404) ──────────────────────────────────────────

describe('POST /api/upload network path: new file success', () => {
  it('treats a 404 from getFile as a new file and returns 200 with the public URL', async () => {
    // getFile sees a 404, so throwIfNotOk throws with status 404; the handler
    // swallows that (sha stays undefined) and treats the file as new.
    getResponse = jsonRes(404, { message: 'Not Found' });
    putResponse = jsonRes(201, { content: {}, commit: {} });

    const r = await callUpload('?name=test.png');

    assert.equal(r.status, 200);
    // publicPath strips the leading 'static/' from static/img/uploads/test.png.
    assert.deepEqual(r.body, { success: true, url: '/img/uploads/test.png' });

    // Two fetches in order: the getFile GET, then the upload PUT.
    assert.equal(fetchCalls.length, 2);
    const { repo, branch } = getConfig();
    assert.equal(
      fetchCalls[0].url,
      `${GITHUB_API}/repos/${repo}/contents/static/img/uploads/test.png?ref=${branch}`,
    );
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.equal(
      fetchCalls[1].url,
      `${GITHUB_API}/repos/${repo}/contents/static/img/uploads/test.png`,
    );
    assert.equal(fetchCalls[1].opts.method, 'PUT');

    // New file => the PUT body omits sha and carries the base64 of the body.
    const putBody = JSON.parse(fetchCalls[1].opts.body);
    assert.ok(!('sha' in putBody));
    assert.equal(putBody.content, EXPECTED_B64);
    assert.equal(putBody.branch, branch);
  });
});

// ─── Success: existing file (getFile returns a sha) ───────────────────────────

describe('POST /api/upload network path: overwrite existing file', () => {
  it('forwards the existing sha into the PUT body and returns 200', async () => {
    // getFile resolves with an existing file, so its sha drives the overwrite.
    getResponse = jsonRes(200, { content: 'ZXhpc3Rpbmc=', sha: 'existingsha123', encoding: 'base64' });
    putResponse = jsonRes(200, { content: {}, commit: {} });

    const r = await callUpload('?name=test.png');

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, url: '/img/uploads/test.png' });

    // The PUT carries the sha from getFile (the overwrite path) and the body bytes.
    const putBody = JSON.parse(fetchCalls[1].opts.body);
    assert.equal(putBody.sha, 'existingsha123');
    assert.equal(putBody.content, EXPECTED_B64);
  });
});

// ─── Failure: PUT not ok ──────────────────────────────────────────────────────

describe('POST /api/upload network path: PUT failures', () => {
  it('returns 500 with the GitHub message when the PUT body has a message', async () => {
    getResponse = jsonRes(404, { message: 'Not Found' }); // new file, so the PUT runs
    putResponse = jsonRes(422, { message: 'Validation Failed' });

    const r = await callUpload('?name=test.png');

    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Validation Failed' });
  });

  it('returns 500 with the default message when the failing PUT body has no message', async () => {
    getResponse = jsonRes(404, { message: 'Not Found' });
    putResponse = jsonRes(500, {}); // not ok, valid JSON, no message field

    const r = await callUpload('?name=test.png');

    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Upload failed' });
  });

  it('returns 500 with the default message when the failing PUT body is not JSON', async () => {
    // res.json() rejects on a non-JSON body, so the handler catch yields {} and
    // the default 'Upload failed' message stands. This pins the .catch arm.
    getResponse = jsonRes(404, { message: 'Not Found' });
    putResponse = rawRes(502, '<html><body>502 Bad Gateway</body></html>', 'text/html');

    const r = await callUpload('?name=test.png');

    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Upload failed' });
  });
});

// ─── Failure: getFile throws a non-404 (outer catch) ──────────────────────────

describe('POST /api/upload network path: getFile non-404 error', () => {
  it('rethrows a non-404 getFile error to the outer catch and returns 500 with the prefix', async () => {
    // A 500 from getFile makes throwIfNotOk throw with status 500; the handler
    // does not swallow it (status is not 404), so it falls to the outer catch.
    getResponse = jsonRes(500, { message: 'GitHub is down' });

    const r = await callUpload('?name=test.png');

    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Upload failed: GitHub is down' });

    // Only the getFile GET ran; the upload PUT was never reached.
    assert.equal(fetchCalls.length, 1);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
  });
});
