import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/_github.js is a CommonJS module of shared GitHub API helpers. Load it the
// way the api/ serverless handlers (api/file.js, api/file-rename.js) do, so we
// exercise the exported helpers directly. This mirrors
// tests/next-apigithub-response-helpers.test.mjs for the createRequire load and
// the res.status / await res.json() reading style.
const require = createRequire(import.meta.url);
const { getFile, putFile, listTree, getConfig } = require('../api/_github.js');

// These tests lock the CURRENT behavior of the network-path functions getFile,
// putFile, and listTree, and through them the non-exported throwIfNotOk. Every
// case is deterministic: there is NO real network, NO clock, and NO randomness.
// globalThis.fetch is replaced with an in-memory stub that records the url/opts
// it receives and replies with a caller-set web Response. The original fetch and
// the GITHUB_* env vars are saved before the suite and restored after it, so the
// suite leaves both process.env and the global fetch exactly as it found them.
// The assertions are additive and touch no source file.

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

// ─── getFile(filePath) ────────────────────────────────────────────────────────

describe('api/_github.js getFile(filePath) network path', () => {
  it('returns the parsed JSON body on a 200, builds the contents URL, and sends the Bearer token', async () => {
    const payload = { content: 'aGVsbG8=', sha: 'abc123', encoding: 'base64' };
    nextResponse = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const filePath = 'content/posts/hello.md';
    const result = await getFile(filePath);

    // The parsed JSON body is returned verbatim.
    assert.deepEqual(result, payload);

    // Exactly one fetch, against the GitHub contents endpoint.
    assert.equal(fetchCalls.length, 1);
    const { url, opts } = fetchCalls[0];
    const { repo, branch, token } = getConfig();
    assert.equal(
      url,
      `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`,
    );
    // URL shape, asserted independently of the configured repo name.
    assert.ok(url.startsWith('https://api.github.com/'));
    assert.ok(url.includes('/repos/'));
    assert.ok(url.includes('/contents/'));
    assert.ok(url.includes(`?ref=${branch}`));
    // The request carries the Bearer token built by headers(token).
    assert.equal(opts.headers.Authorization, `Bearer ${token}`);
  });

  it('throws the GitHub message with error.status set when the error body is JSON (404 Not Found)', async () => {
    // throwIfNotOk reads the error body; when it has a message that message is used.
    nextResponse = new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(
      () => getFile('content/missing.md'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Not Found');
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

// ─── listTree() ───────────────────────────────────────────────────────────────

describe('api/_github.js listTree() network path', () => {
  it('returns the parsed tree JSON on a 200 and targets the git/trees endpoint', async () => {
    const tree = { sha: 'main-sha', tree: [{ path: 'content/a.md', type: 'blob' }] };
    nextResponse = new Response(JSON.stringify(tree), { status: 200 });
    const result = await listTree();
    assert.deepEqual(result, tree);
    assert.equal(fetchCalls.length, 1);
    const { branch } = getConfig();
    assert.ok(fetchCalls[0].url.startsWith('https://api.github.com/'));
    // Pins both the branch segment and the recursive query listTree always appends.
    assert.ok(fetchCalls[0].url.includes(`/git/trees/${branch}?recursive=1`));
  });

  it('throws "GitHub API error: 502" with error.status when the error body is not JSON', async () => {
    // A non-JSON body makes res.json() reject, so throwIfNotOk's `.catch(() => ({}))`
    // yields {} (no message) and the fallback `GitHub API error: <status>` is thrown.
    nextResponse = new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
    await assert.rejects(
      () => listTree(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'GitHub API error: 502');
        assert.equal(err.status, 502);
        return true;
      },
    );
  });
});

// ─── putFile(filePath, content, message, sha) ─────────────────────────────────

describe('api/_github.js putFile(filePath, content, message, sha) network path', () => {
  it('uses method PUT, base64-encodes content, and omits body.sha when no sha arg is passed', async () => {
    nextResponse = new Response(JSON.stringify({ content: {}, commit: {} }), { status: 200 });
    await putFile('content/new.md', 'hello', 'create new.md');

    assert.equal(fetchCalls.length, 1);
    const { url, opts } = fetchCalls[0];
    const { repo, token, branch } = getConfig();
    assert.equal(url, `https://api.github.com/repos/${repo}/contents/content/new.md`);
    assert.equal(opts.method, 'PUT');
    assert.equal(opts.headers.Authorization, `Bearer ${token}`);

    const body = JSON.parse(opts.body);
    // base64 of 'hello' is 'aGVsbG8='.
    assert.equal(body.content, 'aGVsbG8=');
    assert.equal(body.message, 'create new.md');
    assert.equal(body.branch, branch); // putFile writes the configured branch into the body
    assert.ok(!('sha' in body)); // no sha arg, so the field is omitted
  });

  it('includes body.sha only when a sha arg is passed', async () => {
    nextResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    await putFile('content/edit.md', 'world', 'update edit.md', 'sha_xyz');

    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body.sha, 'sha_xyz');
    assert.equal(body.content, Buffer.from('world').toString('base64'));
    assert.equal(body.message, 'update edit.md');
  });

  it('returns the parsed JSON body on a stubbed 200', async () => {
    const payload = {
      content: { path: 'content/new.md', sha: 'newsha' },
      commit: { sha: 'commitsha' },
    };
    nextResponse = new Response(JSON.stringify(payload), { status: 200 });
    const result = await putFile('content/new.md', 'data', 'msg');
    assert.deepEqual(result, payload);
  });
});
