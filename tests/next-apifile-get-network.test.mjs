import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/file.js is the Vercel serverless handler for /api/file. Its GET branch
// reads one file through getFile() in api/_github.js, which calls fetch() against
// the GitHub Contents API. The sibling
// tests/next-apifile-handler-guards.test.mjs already pins the network-free guard
// and dispatch branches; this file pins the GET network path itself by stubbing
// globalThis.fetch, so no real socket is ever opened. Both modules load through
// createRequire the way the Vercel runtime loads them (CommonJS), so the REAL
// handler is exercised, not a reimplementation. The fetch-stub and GITHUB_* env
// pattern mirrors tests/next-apigithub-network-throwifnotok.test.mjs.
const require = createRequire(import.meta.url);
const handler = require('../api/file.js');
const { getConfig, GITHUB_API } = require('../api/_github.js');

// Every case is deterministic: there is NO real network, NO clock, and NO
// randomness. globalThis.fetch is replaced with an in-memory stub that records
// the url/opts it receives and replies with a caller-set web Response. The
// original fetch and the GITHUB_* env vars are saved before the suite and
// restored after it, so the suite leaves both process.env and the global fetch
// exactly as it found them. The assertions pin CURRENT behavior and touch no
// source file.
const GH_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
const savedEnv = {};
const realFetch = globalThis.fetch;

// Per-case state for the fetch stub: the recorded calls and the Response the
// next fetch should resolve to. beforeEach resets both so cases never bleed.
let fetchCalls = [];
let nextResponse = null;

before(() => {
  for (const k of GH_KEYS) savedEnv[k] = process.env[k];
  // A token is required so getConfig() does not throw on the network path. Clear
  // the repo/branch overrides so the module's own defaults drive the URL; the
  // expected values are then derived from getConfig() rather than hardcoded.
  delete process.env.GITHUB_REPO;
  delete process.env.GITHUB_BRANCH;
  process.env.GITHUB_TOKEN = 'tok_test_123';
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return nextResponse;
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
  nextResponse = null;
});

// A GET request whose path comes from the query string (GET carries no body).
function getReq(p) {
  return { method: 'GET', url: '/api/file?path=' + p };
}

const GET_PATH = 'content/note.md'; // passes isValidFilePath (content/ prefix, .md ext)

// Build the GitHub success body the same way getFile expects it: base64 content.
function successResponse(text) {
  return new Response(
    JSON.stringify({ content: Buffer.from(text).toString('base64'), sha: 's', encoding: 'base64' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ─── GET success path (200 with the body decoded) ─────────────────────────────

describe('api/file.js GET handler network path (success)', () => {
  it('returns 200 with the base64 content decoded to utf-8 text', async () => {
    nextResponse = successResponse('hi');

    const res = await handler(getReq(GET_PATH));

    assert.equal(res.status, 200);
    // getFile returns { content: <base64> }; the handler decodes it before replying.
    assert.deepEqual(await res.json(), { content: 'hi' });
    assert.equal(fetchCalls.length, 1);
  });

  it('targets /contents/<path>?ref=<branch> and sends the Bearer token', async () => {
    nextResponse = successResponse('hi');

    const res = await handler(getReq(GET_PATH));
    assert.equal(res.status, 200);

    assert.equal(fetchCalls.length, 1);
    const { url, opts } = fetchCalls[0];
    const { repo, branch, token } = getConfig();
    // The contents URL is built from the configured repo/branch, not hardcoded.
    assert.equal(url, `${GITHUB_API}/repos/${repo}/contents/${GET_PATH}?ref=${branch}`);
    assert.ok(url.includes('/contents/'));
    assert.ok(url.includes(`?ref=${branch}`));
    assert.equal(opts.headers.Authorization, `Bearer ${token}`);
  });
});

// ─── GET error paths (404 mapping and the non-404 fallthrough) ────────────────

describe('api/file.js GET handler network path (errors)', () => {
  it('maps a GitHub 404 (JSON body) to a 404 File not found reply', async () => {
    // throwIfNotOk reads the JSON error body and sets err.status = 404, which the
    // handler maps to its own 404 response.
    nextResponse = new Response('{"message":"Not Found"}', { status: 404 });

    const res = await handler(getReq(GET_PATH));

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'File not found' });
  });

  it('maps a 404 by status even when the error body is not JSON', async () => {
    // The mapping keys off err.status, not the message. A non-JSON 404 body makes
    // throwIfNotOk fall back to 'GitHub API error: 404' for the message, but the
    // status is still 404 so the handler still returns File not found.
    nextResponse = new Response('Not Found', { status: 404 });

    const res = await handler(getReq(GET_PATH));

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'File not found' });
  });

  it('maps a non-404 failure to a 500 carrying err.message', async () => {
    // A 500 with a non-JSON body: throwIfNotOk's res.json() rejects, .catch yields
    // {}, so the message falls back to `GitHub API error: <status>`. err.status is
    // 500 (not 404), so the handler returns that message inside a 500 response.
    nextResponse = new Response('boom', { status: 500 });

    const res = await handler(getReq(GET_PATH));

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'GitHub API error: 500' });
  });
});
