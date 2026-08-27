import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/upload.js is the Vercel serverless handler for POST /api/upload, a CommonJS
// module (module.exports = async function handler(req)) that returns a global
// Response. Load it the way the runtime and the sibling upload suites do:
// createRequire then require. getConfig and GITHUB_API come from api/_github.js so
// every expected request URL is derived from the module, never hardcoded. This
// mirrors the load in tests/next-apiupload-network-branches.test.mjs.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/upload.js');
const { getConfig, GITHUB_API } = require('../../../../api/_github.js');

// What this suite pins: the filename-SANITIZATION projection of the success path
// (api/upload.js lines 37 to 78). The handler computes
//   safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')   (line 37)
// and threads safeName through three downstream outputs:
//   1. filePath, hence the GitHub Contents PUT URL              (lines 38, 57, 65)
//   2. the PUT body commit message `Upload image ${safeName}`   (line 59)
//   3. the returned public url `/` + filePath without 'static/' (lines 77, 78)
// The three existing upload suites all pass already-clean names (test.png), so the
// regex never substitutes a character (safeName === name) and the commit message
// is never asserted at all. Here we drive a name WITH characters that need
// replacing and lock all three projections to the sanitized value.
//
// Determinism (same proven seam as next-apiupload-network-branches): NO real
// network, NO clock, NO randomness. globalThis.fetch is replaced with an in-memory
// stub routed by opts.method, so the GET getFile performs and the PUT the handler
// issues each resolve to a caller-set web Response. GITHUB_TOKEN is set to a dummy
// so getConfig() succeeds and execution reaches fetch; the GITHUB_* env vars and
// the real fetch are saved before the suite and restored after, so the suite leaves
// process.env and globalThis.fetch exactly as it found them. Every expected value
// is derived from the real module; no source file is touched.

// The raw name carries a space, parentheses, and a bang, all outside the
// [a-zA-Z0-9._-] allow-list, so each maps to '_'; the dot before the extension is
// preserved (it is in the allow-list). Verified against the live handler.
const RAW_NAME = 'my photo (1)!.png';
const SAFE_NAME = 'my_photo__1__.png';

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

// A tiny, exactly-sized image body. Uint8Array([...]).buffer has byteOffset 0 and
// no Buffer-pool padding, so Buffer.from(it) round-trips to the same base64 the
// handler computes from the ArrayBuffer it reads.
const UPLOAD_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
const EXPECTED_B64 = Buffer.from(UPLOAD_BYTES).toString('base64');

// Drive POST /api/upload for the given raw (un-encoded) name and optional dir. The
// name is percent-encoded into the query exactly as a browser would send it; the
// handler's new URL(...).searchParams.get('name') decodes it back to the raw name,
// so the sanitization regex (not URL decoding) is what produces safeName.
async function callUpload(name, dir) {
  let search = '?name=' + encodeURIComponent(name);
  if (dir !== undefined) search += '&dir=' + encodeURIComponent(dir);
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
  // method, so it defaults to GET) and record every call so a test can assert the
  // PUT URL and body.
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

// ─── Default dir: safeName flows into url, PUT URL, and commit message ─────────

describe('POST /api/upload success path: filename sanitization projection', () => {
  it('replaces unsafe chars and pins the url, PUT contents URL, and commit message', async () => {
    // 404 from getFile => the file is treated as new (sha stays undefined); the
    // PUT then succeeds with a 201, exercising the full success path.
    getResponse = jsonRes(404, { message: 'Not Found' });
    putResponse = jsonRes(201, { content: {}, commit: {} });

    const r = await callUpload(RAW_NAME);

    // (a) 200 and the returned url is the SANITIZED public path: the default dir
    // static/img/uploads with the leading 'static/' stripped, safeName appended.
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, url: `/img/uploads/${SAFE_NAME}` });

    // Two fetches in order: the getFile GET, then the upload PUT. Both carry the
    // sanitized path; the raw name never appears in either URL. Expected URLs are
    // derived from getConfig() so they track the module defaults.
    assert.equal(fetchCalls.length, 2);
    const { repo, branch } = getConfig();
    assert.equal(
      fetchCalls[0].url,
      `${GITHUB_API}/repos/${repo}/contents/static/img/uploads/${SAFE_NAME}?ref=${branch}`,
    );
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');

    // (b) the PUT contents URL ends with the sanitized path.
    assert.equal(fetchCalls[1].opts.method, 'PUT');
    assert.equal(
      fetchCalls[1].url,
      `${GITHUB_API}/repos/${repo}/contents/static/img/uploads/${SAFE_NAME}`,
    );
    assert.ok(fetchCalls[1].url.endsWith(`/contents/static/img/uploads/${SAFE_NAME}`));

    // (c) the commit message carries the sanitized name. This is the projection no
    // existing suite asserts, because their clean names make safeName === name.
    const putBody = JSON.parse(fetchCalls[1].opts.body);
    assert.equal(putBody.message, `Upload image ${SAFE_NAME}`);
    assert.equal(putBody.message, 'Upload image my_photo__1__.png');

    // The body bytes, branch, and new-file (no sha) shape ride along unchanged.
    assert.equal(putBody.content, EXPECTED_B64);
    assert.equal(putBody.branch, branch);
    assert.ok(!('sha' in putBody));

    // The raw, unsanitized characters must not leak into any outbound projection.
    assert.ok(!r.body.url.includes(' '));
    assert.ok(!fetchCalls[1].url.includes(' '));
    assert.ok(!putBody.message.includes('('));
  });
});

// ─── Non-default dir: safeName joins onto the provided dir ─────────────────────

describe('POST /api/upload success path: sanitized name joins a non-default dir', () => {
  it('appends safeName to ?dir= and strips static/ for the public url', async () => {
    getResponse = jsonRes(404, { message: 'Not Found' });
    putResponse = jsonRes(201, { content: {}, commit: {} });

    // A non-default but valid dir (the guard requires it to start with static/img/).
    // safeName joins onto it unchanged; only the file name, not the dir, is
    // sanitized.
    const r = await callUpload(RAW_NAME, 'static/img/custom');

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, url: `/img/custom/${SAFE_NAME}` });

    const { repo } = getConfig();
    assert.equal(
      fetchCalls[1].url,
      `${GITHUB_API}/repos/${repo}/contents/static/img/custom/${SAFE_NAME}`,
    );
    const putBody = JSON.parse(fetchCalls[1].opts.body);
    assert.equal(putBody.message, `Upload image ${SAFE_NAME}`);
  });
});
