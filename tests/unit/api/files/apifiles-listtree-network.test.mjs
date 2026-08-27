import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/files.js is the Vercel serverless handler for GET /api/files: it lists the
// repo file tree from the GitHub Git Trees API. It is a CommonJS module
// (module.exports = async function handler(req)), so load it the way the real
// runtime does: createRequire then require the file. This mirrors
// tests/next-apifiles-handler-guards.test.mjs for the handler load + Response
// reading, and tests/next-apigithub-network-throwifnotok.test.mjs for the
// globalThis.fetch stub and the GITHUB_* env save/restore harness.
const require = createRequire(import.meta.url);
const handler = require('../../../../api/files.js');
const { getConfig, GITHUB_API } = require('../../../../api/_github.js');

// These tests lock the CURRENT behavior of the network-driven body of handler():
// the try block that awaits listTree(), feeds its tree into buildTree(dir), and
// returns 200 { files }, plus the catch that maps any listTree() failure to a
// 500 { error: err.message }. The pure guard and dispatch branches (OPTIONS, 405,
// 400 invalid dir, the '..' traversal reject) already live in
// tests/next-apifiles-handler-guards.test.mjs and
// tests/next-files-dir-reject-dotdot.test.mjs, and the buildTree directory
// nesting in tests/next-apifiles-buildtree-singlepass.test.mjs; none are
// re-covered here.
//
// Every case is deterministic: there is NO real network, clock, or randomness.
// globalThis.fetch is replaced with an in-memory stub that records each call and
// replies with a caller-set web Response. The original fetch and the GITHUB_* env
// vars are saved before the suite and restored after it, so the suite leaves both
// process.env and the global fetch exactly as it found them. A GITHUB_TOKEN is set
// so getConfig() passes on the network path, and the repo/branch overrides are
// cleared so the module defaults drive the URL; expected URLs are then derived
// from getConfig() + GITHUB_API rather than hardcoded. The assertions are additive
// and touch no source file.

const GH_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
const savedEnv = {};
const realFetch = globalThis.fetch;

// Per-case fetch-stub state: the recorded calls and the Response the next fetch
// resolves to. beforeEach resets both so cases never bleed into each other.
let fetchCalls = [];
let nextResponse = null;

before(() => {
  for (const k of GH_KEYS) savedEnv[k] = process.env[k];
  // Token present so getConfig() does not throw on the network path; repo/branch
  // overrides cleared so the module defaults ('zeyuyang8/mochi-lab', 'main')
  // drive the URL, which the assertions then derive from getConfig().
  delete process.env.GITHUB_REPO;
  delete process.env.GITHUB_BRANCH;
  process.env.GITHUB_TOKEN = 'tok_test_files';
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

// Success-leg Response: a 200 carrying a GitHub Git Trees payload built from the
// given flat entry list. listTree() reads its body once via res.json().
function treeResponse(tree) {
  return new Response(JSON.stringify({ sha: 's', tree }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Minimal fake req: GET carrying its `dir` in the query string. The handler reads
// only req.method and req.url for this path.
function getReq(search = '') {
  return { method: 'GET', url: '/api/files' + search };
}

describe('GET /api/files listTree() network path (fetch-stubbed)', () => {
  it('resolves to a 200 web Response whose JSON is { files } built from the stubbed tree', async () => {
    nextResponse = treeResponse([
      { path: 'content/a.md', type: 'blob', size: 1 },
      { path: 'other/b.md', type: 'blob', size: 2 },
    ]);

    const res = await handler(getReq('?dir=content'));

    // The handler resolves to a web Response: status + JSON are read off it.
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    // buildTree keeps the content/ blob and drops the other/ blob, so files holds
    // exactly the one content entry, shaped { name, path, type:'file', size }.
    assert.deepEqual(await res.json(), {
      files: [{ name: 'a.md', path: 'content/a.md', type: 'file', size: 1 }],
    });
  });

  it('targets the git/trees endpoint with the branch + recursive=1 and the Bearer token from getConfig()', async () => {
    nextResponse = treeResponse([{ path: 'content/a.md', type: 'blob', size: 1 }]);

    await handler(getReq('?dir=content'));

    // Exactly one fetch, against the Git Trees URL listTree() builds.
    assert.equal(fetchCalls.length, 1);
    const { repo, branch, token } = getConfig();
    const { url, opts } = fetchCalls[0];
    assert.equal(url, `${GITHUB_API}/repos/${repo}/git/trees/${branch}?recursive=1`);
    // URL shape, asserted independently of the configured repo name.
    assert.ok(url.startsWith('https://api.github.com/'));
    assert.ok(url.includes('git/trees/'));
    assert.ok(url.includes(`git/trees/${branch}?recursive=1`));
    // The request carries the Bearer token built by headers(token).
    assert.equal(opts.headers.Authorization, `Bearer ${token}`);
  });

  it('applies the ?dir filter to the returned tree (?dir=content/posts keeps only that subtree)', async () => {
    nextResponse = treeResponse([
      { path: 'content/posts/x.md', type: 'blob', size: 3 },
      { path: 'content/notes.md', type: 'blob', size: 4 },
    ]);

    const res = await handler(getReq('?dir=content/posts'));

    assert.equal(res.status, 200);
    // Only the blob under content/posts/ survives; content/notes.md is filtered out.
    assert.deepEqual(await res.json(), {
      files: [{ name: 'x.md', path: 'content/posts/x.md', type: 'file', size: 3 }],
    });
  });

  it('defaults the directory to content when no ?dir is given', async () => {
    nextResponse = treeResponse([
      { path: 'content/a.md', type: 'blob', size: 1 },
      { path: 'other/b.md', type: 'blob', size: 2 },
    ]);

    // No query string: url.searchParams.get('dir') is null, so dir falls back to
    // 'content' and only the content/ blob is kept.
    const res = await handler(getReq());

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      files: [{ name: 'a.md', path: 'content/a.md', type: 'file', size: 1 }],
    });
  });

  it('maps a non-ok fetch with a non-JSON body to a 500 { error } (502 surfaces as GitHub API error: 502)', async () => {
    // throwIfNotOk reads the error body; a non-JSON body makes res.json() reject,
    // so its .catch(() => ({})) yields {} (no message) and the fallback
    // `GitHub API error: <status>` is thrown. The handler's catch squashes the
    // original 502 to a 500 and surfaces err.message.
    nextResponse = new Response('<html>502</html>', { status: 502 });

    const res = await handler(getReq('?dir=content'));

    assert.equal(res.status, 500);
    assert.notEqual(res.status, 502, 'the original GitHub status is not propagated');
    assert.deepEqual(await res.json(), { error: 'GitHub API error: 502' });
  });

  it('surfaces the GitHub error message on a JSON error body, still as a 500', async () => {
    // A JSON error body with a message makes throwIfNotOk throw that message; the
    // handler returns it under { error } but still maps the status to 500.
    nextResponse = new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await handler(getReq('?dir=content'));

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Not Found' });
  });
});
