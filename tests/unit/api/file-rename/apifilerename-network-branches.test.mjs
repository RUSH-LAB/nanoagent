import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/file-rename.js is the Vercel serverless handler for POST /api/file/rename.
// It is a CommonJS module (module.exports = async function handler(req)) that
// returns a global Response, so load it the way the real runtime and the sibling
// rename suites do: createRequire then require the file. getConfig and GITHUB_API
// come from api/_github.js so the expected request URLs are derived from the
// module rather than hardcoded. This mirrors the createRequire load in
// tests/next-apiupload-network-branches.test.mjs.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/file-rename.js');
const { getConfig, GITHUB_API } = require('../../../../api/_github.js');

// After the OPTIONS, 405, and 400 'Invalid path' guards the handler runs its
// network flow (api/file-rename.js lines 21 to 52): it reads the body via
// req.json(), then drives getFile / putFile / deleteFile from api/_github.js,
// each of which calls fetch. The network-free guards are already pinned by
// tests/next-apifilerename-handler-guards.test.mjs and
// tests/next-apifilerename-badbody-500.test.mjs, so this suite covers only the
// branches that reach fetch and were never exercised before.
//
// Every case here is deterministic: there is NO real network, NO clock, and NO
// randomness. globalThis.fetch is replaced with an in-memory stub that routes by
// opts.method (GET for getFile, PUT for putFile, DELETE for deleteFile) and, for
// the two GET lookups, by the path carried in the contents URL (old vs new). Each
// leg resolves to a caller-set web Response. GITHUB_TOKEN is set to a dummy so
// getConfig() succeeds and execution reaches fetch; the original fetch and the
// GITHUB_* env vars are saved before the suite and restored after it, so the
// suite leaves both process.env and globalThis.fetch exactly as it found them.
// The assertions are additive and touch no source file; every expected value is
// derived from the real module.
//
// Branches pinned here, each isolated by the stubbed GET/PUT/DELETE responses:
//   • getFile(oldPath) 404 => 404 { error: 'Source not found' }; only one GET runs.
//   • getFile(oldPath) 200 then getFile(newPath) 200 => 409 { error: 'Target
//     already exists' }; the PUT and DELETE never run.
//   • Full rename: getFile(oldPath) 200 (base64 content + sha), getFile(newPath)
//     404 (target absent), putFile PUT 200, deleteFile DELETE 200 => 200
//     { success: true, path: newPath }. Exactly four calls in order (GET old, GET
//     new, PUT new, DELETE old); the PUT body carries the base64 of the decoded
//     old content; the DELETE body carries the old file sha; the commit messages
//     are the rename and the delete-old strings.
//   • getFile(newPath) rejects non-404 (a 500) => rethrown to the outer catch =>
//     500 { error: <err.message> }; the PUT and DELETE never run.

const GH_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
const savedEnv = {};
const realFetch = globalThis.fetch;

// Valid content paths so isValidFilePath passes (content/ prefix, .md extension).
const OLD_PATH = 'content/old.md';
const NEW_PATH = 'content/new.md';
// The decoded old file content and its base64, computed (not hardcoded) so the
// PUT round-trip assertion stays exact: getFile returns OLD_CONTENT_B64, the
// handler decodes it, and putFile re-encodes the decoded bytes back to the same
// base64.
const OLD_CONTENT = 'hello world';
const OLD_CONTENT_B64 = Buffer.from(OLD_CONTENT).toString('base64');
const OLD_SHA = 'oldsha123';

// Per-case state for the fetch stub: recorded calls plus the Response each leg
// should resolve to. beforeEach resets all of them so cases never bleed.
let fetchCalls = [];
let getOldResponse = null;
let getNewResponse = null;
let putResponse = null;
let deleteResponse = null;

// Build a web Response with a JSON body and the given status.
function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Set the four legs for a clean, successful rename: old file present, target
// absent (404), PUT and DELETE both ok. Cases that want a failure override one
// leg after calling this (or set legs directly).
function setupSuccess() {
  getOldResponse = jsonRes(200, { content: OLD_CONTENT_B64, sha: OLD_SHA, encoding: 'base64' });
  getNewResponse = jsonRes(404, { message: 'Not Found' });
  putResponse = jsonRes(200, { content: {}, commit: {} });
  deleteResponse = jsonRes(200, { commit: {} });
}

// Invoke POST /api/file/rename with the given paths and read back the status plus
// parsed JSON body. The body comes from req.json(), exactly as the handler reads it.
async function callRename(oldPath = OLD_PATH, newPath = NEW_PATH) {
  const req = { method: 'POST', json: async () => ({ oldPath, newPath }) };
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
  // The handler issues up to four fetch calls: GET old (getFile), GET new
  // (getFile), PUT new (putFile), DELETE old (deleteFile). Route PUT and DELETE
  // by method; route the two GETs by the path in the contents URL. Record every
  // call so a test can assert the bodies and the call ordering.
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    const method = (opts && opts.method) || 'GET';
    if (method === 'PUT') return putResponse;
    if (method === 'DELETE') return deleteResponse;
    if (url.includes(OLD_PATH)) return getOldResponse;
    if (url.includes(NEW_PATH)) return getNewResponse;
    throw new Error(`unexpected GET in fetch stub: ${url}`);
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
  getOldResponse = null;
  getNewResponse = null;
  putResponse = null;
  deleteResponse = null;
});

// ─── Source missing: getFile(oldPath) 404 ─────────────────────────────────────

describe('POST /api/file/rename network path: source not found', () => {
  it('returns 404 Source not found when the first getFile(oldPath) 404s', async () => {
    // throwIfNotOk throws with status 404; the handler's first catch matches
    // err.status === 404 and short-circuits before the target lookup.
    getOldResponse = jsonRes(404, { message: 'Not Found' });

    const r = await callRename();

    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Source not found' });

    // Only the source GET ran: no target lookup, no PUT, no DELETE.
    assert.equal(fetchCalls.length, 1);
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.ok(fetchCalls[0].url.includes(OLD_PATH));
  });
});

// ─── Target exists: getFile(newPath) resolves 200 ─────────────────────────────

describe('POST /api/file/rename network path: target already exists', () => {
  it('returns 409 Target already exists when getFile(newPath) resolves 200', async () => {
    // The source resolves, then the target lookup resolves too (no throw), so the
    // handler returns 409 before decoding, putting, or deleting anything.
    getOldResponse = jsonRes(200, { content: OLD_CONTENT_B64, sha: OLD_SHA, encoding: 'base64' });
    getNewResponse = jsonRes(200, { content: 'eA==', sha: 'targetsha', encoding: 'base64' });

    const r = await callRename();

    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: 'Target already exists' });

    // Two GETs in order (old then new); the PUT and DELETE never run.
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0].url.includes(OLD_PATH));
    assert.ok(fetchCalls[1].url.includes(NEW_PATH));
  });
});

// ─── Full success: GET old, GET new (404), PUT new, DELETE old ────────────────

describe('POST /api/file/rename network path: full rename success', () => {
  it('returns 200 { success: true, path: newPath } when every leg succeeds', async () => {
    setupSuccess();

    const r = await callRename();

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, path: NEW_PATH });
  });

  it('issues GET old, GET new, PUT new, DELETE old in order with the expected bodies', async () => {
    setupSuccess();

    await callRename();

    const { repo, branch } = getConfig();

    // Exactly four calls, in the handler's order.
    assert.equal(fetchCalls.length, 4);

    // 0: getFile(oldPath) GET against the contents endpoint with ?ref.
    assert.equal((fetchCalls[0].opts && fetchCalls[0].opts.method) || 'GET', 'GET');
    assert.equal(
      fetchCalls[0].url,
      `${GITHUB_API}/repos/${repo}/contents/${OLD_PATH}?ref=${branch}`,
    );

    // 1: getFile(newPath) GET against the contents endpoint with ?ref.
    assert.equal((fetchCalls[1].opts && fetchCalls[1].opts.method) || 'GET', 'GET');
    assert.equal(
      fetchCalls[1].url,
      `${GITHUB_API}/repos/${repo}/contents/${NEW_PATH}?ref=${branch}`,
    );

    // 2: putFile(newPath) PUT against the contents endpoint (no ?ref).
    assert.equal(fetchCalls[2].opts.method, 'PUT');
    assert.equal(fetchCalls[2].url, `${GITHUB_API}/repos/${repo}/contents/${NEW_PATH}`);
    const putBody = JSON.parse(fetchCalls[2].opts.body);
    // The PUT carries the base64 of the decoded old content (the round-trip) and
    // the rename commit message, on the configured branch, with no sha (new file).
    assert.equal(putBody.content, OLD_CONTENT_B64);
    assert.equal(putBody.message, `Rename ${OLD_PATH} to ${NEW_PATH}`);
    assert.equal(putBody.branch, branch);
    assert.ok(!('sha' in putBody));

    // 3: deleteFile(oldPath) DELETE against the contents endpoint (no ?ref).
    assert.equal(fetchCalls[3].opts.method, 'DELETE');
    assert.equal(fetchCalls[3].url, `${GITHUB_API}/repos/${repo}/contents/${OLD_PATH}`);
    const delBody = JSON.parse(fetchCalls[3].opts.body);
    // The DELETE carries the old file sha and the delete-old commit message.
    assert.equal(delBody.sha, OLD_SHA);
    assert.equal(delBody.message, `Rename ${OLD_PATH} to ${NEW_PATH} (delete old)`);
    assert.equal(delBody.branch, branch);
  });
});

// ─── Target lookup hard-fails: getFile(newPath) non-404 to outer catch ────────

describe('POST /api/file/rename network path: target lookup non-404 error', () => {
  it('rethrows a non-404 from getFile(newPath) to the outer catch and returns 500 with err.message', async () => {
    // The source resolves, but the target lookup returns a 500. throwIfNotOk
    // throws with status 500; the handler's second catch only swallows 404, so it
    // rethrows into the outer catch, which echoes err.message.
    getOldResponse = jsonRes(200, { content: OLD_CONTENT_B64, sha: OLD_SHA, encoding: 'base64' });
    getNewResponse = jsonRes(500, { message: 'GitHub is down' });

    const r = await callRename();

    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'GitHub is down' });

    // The target lookup failed hard, so neither the PUT nor the DELETE ran.
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0].url.includes(OLD_PATH));
    assert.ok(fetchCalls[1].url.includes(NEW_PATH));
  });
});
