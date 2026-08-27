import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/file.js is the Vercel serverless handler for /api/file. Its PUT, POST, and
// DELETE branches each read the target through getFile() and then write through
// putFile() or deleteFile() in api/_github.js, every one of which calls fetch()
// against the GitHub Contents API. The network-free guard and dispatch branches
// are already pinned by tests/next-apifile-handler-guards.test.mjs and
// tests/next-apifile-badbody-500.test.mjs, and the GET network path is pinned by
// tests/next-apifile-get-network.test.mjs, so this suite covers only the PUT,
// POST, and DELETE network branches and deliberately does NOT re-cover GET.
//
// Both modules load through createRequire the way the Vercel runtime loads them
// (CommonJS), so the REAL handler runs, not a reimplementation. getConfig and
// GITHUB_API come from api/_github.js so every expected request URL is derived
// from the module rather than hardcoded. The fetch-stub and GITHUB_* env pattern
// mirrors tests/next-apifilerename-network-branches.test.mjs.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/file.js');
const { getConfig, GITHUB_API } = require('../../../../api/_github.js');

// Every case is deterministic: there is NO real network, NO clock, and NO
// randomness. globalThis.fetch is replaced with an in-memory stub that records
// each call and routes by opts.method: PUT goes to putFile, DELETE to deleteFile,
// and the default GET to the getFile lookup. Each leg resolves to a caller-set web
// Response. A dummy GITHUB_TOKEN is set so getConfig() succeeds and execution
// reaches fetch; the original fetch and the GITHUB_* env vars are saved before the
// suite and restored after it, so the suite leaves both process.env and
// globalThis.fetch exactly as it found them. The assertions are additive, pin
// CURRENT behavior, and touch no source file.
const GH_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
const savedEnv = {};
const realFetch = globalThis.fetch;

// A valid content path so isValidFilePath passes (content/ prefix, .md extension).
const FILE_PATH = 'content/note.md';
// The decoded file content and its base64, computed (not hardcoded) so the write
// round-trip assertions stay exact: the handler base64-encodes the request body
// content before sending it on the PUT.
const FILE_CONTENT = 'hello world';
const FILE_CONTENT_B64 = Buffer.from(FILE_CONTENT).toString('base64');
const FILE_SHA = 'sha-123';

// Per-case state for the fetch stub: recorded calls plus the Response each leg
// should resolve to. beforeEach resets all of them so cases never bleed.
let fetchCalls = [];
let getResponse = null;
let putResponse = null;
let deleteResponse = null;

// Build a web Response with a JSON body and the given status.
function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Invoke a body-carrying request (PUT or POST) and read back the status plus the
// parsed JSON body. The body comes from req.json(), exactly as the handler reads it.
async function callJson(method, payload) {
  const req = { method, url: '/api/file', json: async () => payload };
  const res = await handler(req);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// Invoke a DELETE request, whose path comes from the query string (no body).
async function callDelete(path = FILE_PATH) {
  const req = { method: 'DELETE', url: '/api/file?path=' + path };
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
  // The handler issues up to two fetch calls per request: a GET lookup (getFile)
  // followed by a PUT (putFile) or DELETE (deleteFile). Route by method and record
  // every call so a test can assert the bodies and the call ordering.
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    const method = (opts && opts.method) || 'GET';
    if (method === 'PUT') return putResponse;
    if (method === 'DELETE') return deleteResponse;
    return getResponse;
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
  deleteResponse = null;
});

// ─── PUT: update an existing file ──────────────────────────────────────────────

describe('PUT /api/file network path: file not found', () => {
  it('returns 404 File not found when the getFile lookup 404s; only one fetch runs', async () => {
    // throwIfNotOk throws with status 404; the handler's inner catch matches
    // err.status === 404 and replies before any PUT can fire.
    getResponse = jsonRes(404, { message: 'Not Found' });

    const r = await callJson('PUT', { path: FILE_PATH, content: 'new text' });

    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'File not found' });

    assert.equal(fetchCalls.length, 1);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.ok(fetchCalls[0].url.includes(FILE_PATH));
  });
});

describe('PUT /api/file network path: update success', () => {
  it('returns 200 success and PUTs the fetched sha with the Update message', async () => {
    getResponse = jsonRes(200, { content: FILE_CONTENT_B64, sha: FILE_SHA, encoding: 'base64' });
    putResponse = jsonRes(200, { content: {}, commit: {} });

    const r = await callJson('PUT', { path: FILE_PATH, content: 'updated body' });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true });

    const { repo, branch, token } = getConfig();

    // Two calls in order: the GET lookup then the PUT update.
    assert.equal(fetchCalls.length, 2);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.equal(
      fetchCalls[0].url,
      `${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`,
    );

    // The PUT targets the contents endpoint (no ?ref), sends the Bearer token, and
    // carries the fetched sha plus the Update commit message on the configured branch.
    const put = fetchCalls[1];
    assert.equal(put.opts.method, 'PUT');
    assert.equal(put.url, `${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}`);
    assert.equal(put.opts.headers.Authorization, `Bearer ${token}`);
    const putBody = JSON.parse(put.opts.body);
    assert.equal(putBody.message, `Update ${FILE_PATH}`);
    assert.equal(putBody.sha, FILE_SHA);
    assert.equal(putBody.branch, branch);
    assert.equal(putBody.content, Buffer.from('updated body').toString('base64'));
  });
});

// ─── POST: create a new file ───────────────────────────────────────────────────

describe('POST /api/file network path: file already exists', () => {
  it('returns 409 File already exists when the getFile lookup resolves 200; no PUT runs', async () => {
    getResponse = jsonRes(200, { content: FILE_CONTENT_B64, sha: FILE_SHA, encoding: 'base64' });

    const r = await callJson('POST', { path: FILE_PATH, content: 'new text' });

    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: 'File already exists' });

    // The existence check resolved, so the create PUT never fired.
    assert.equal(fetchCalls.length, 1);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.ok(fetchCalls[0].url.includes(FILE_PATH));
  });
});

describe('POST /api/file network path: create success', () => {
  it('returns 200 with the path and PUTs a create (no sha) with the Create message', async () => {
    getResponse = jsonRes(404, { message: 'Not Found' });
    putResponse = jsonRes(200, { content: {}, commit: {} });

    const r = await callJson('POST', { path: FILE_PATH, content: 'created body' });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, path: FILE_PATH });

    const { repo, branch, token } = getConfig();

    // Two calls in order: the 404 existence check then the create PUT.
    assert.equal(fetchCalls.length, 2);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.equal(
      fetchCalls[0].url,
      `${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`,
    );

    // The create PUT carries the Create commit message and omits sha (new file).
    const put = fetchCalls[1];
    assert.equal(put.opts.method, 'PUT');
    assert.equal(put.url, `${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}`);
    assert.equal(put.opts.headers.Authorization, `Bearer ${token}`);
    const putBody = JSON.parse(put.opts.body);
    assert.equal(putBody.message, `Create ${FILE_PATH}`);
    assert.ok(!('sha' in putBody));
    assert.equal(putBody.branch, branch);
    assert.equal(putBody.content, Buffer.from('created body').toString('base64'));
  });
});

// ─── DELETE: delete a file ─────────────────────────────────────────────────────

describe('DELETE /api/file network path: file not found', () => {
  it('returns 404 File not found when the getFile lookup 404s; only one fetch runs', async () => {
    getResponse = jsonRes(404, { message: 'Not Found' });

    const r = await callDelete(FILE_PATH);

    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'File not found' });

    // The lookup 404'd, so the DELETE never fired.
    assert.equal(fetchCalls.length, 1);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.ok(fetchCalls[0].url.includes(FILE_PATH));
  });
});

describe('DELETE /api/file network path: delete success', () => {
  it('returns 200 success and DELETEs with the fetched sha, message, and branch', async () => {
    getResponse = jsonRes(200, { content: FILE_CONTENT_B64, sha: FILE_SHA, encoding: 'base64' });
    deleteResponse = jsonRes(200, { commit: {} });

    const r = await callDelete(FILE_PATH);

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true });

    const { repo, branch, token } = getConfig();

    // Two calls in order: the GET lookup then the DELETE.
    assert.equal(fetchCalls.length, 2);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.equal(
      fetchCalls[0].url,
      `${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`,
    );

    // The DELETE targets the contents endpoint (no ?ref), sends the Bearer token,
    // and carries the delete commit message, the fetched sha, and the branch.
    const del = fetchCalls[1];
    assert.equal(del.opts.method, 'DELETE');
    assert.equal(del.url, `${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}`);
    assert.equal(del.opts.headers.Authorization, `Bearer ${token}`);
    const delBody = JSON.parse(del.opts.body);
    assert.deepEqual(delBody, { message: `Delete ${FILE_PATH}`, sha: FILE_SHA, branch });
  });
});
