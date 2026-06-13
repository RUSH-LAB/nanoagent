import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/_github.js is a CommonJS module of shared GitHub API helpers. Load it the
// way the api/ serverless handlers (api/file.js, api/file-rename.js) do, so we
// exercise the exported helpers directly. This mirrors
// tests/next-apigithub-pathguard-test.test.mjs for the createRequire load and
// tests/next-apifile-handler-guards.test.mjs for reading Response status,
// headers, and json.
const require = createRequire(import.meta.url);
const { jsonResponse, optionsResponse, headers, getConfig } = require('../api/_github.js');

// These tests lock the CURRENT, correct behavior of the pure response builders
// and the config reader in api/_github.js. Every case is network-free and
// side-effect-free: the response builders construct a web Response in memory,
// and the getConfig cases only read process.env, which is saved and restored
// around each case so the suite leaves the environment unchanged. The
// assertions capture what the code does today; they are additive and touch no
// source file.

// The CORS headers api/_github.js attaches to every response. Mirrored here so
// the tests can assert the exact values without reaching for a non-exported
// constant. These must stay in sync with CORS_HEADERS in api/_github.js.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── jsonResponse(status, data) ───────────────────────────────────────────────

describe('api/_github.js jsonResponse(status, data)', () => {
  it('returns a Response whose status equals the passed status and whose body round-trips to data', async () => {
    const data = { ok: true, items: [1, 2, 3], nested: { a: 'b' } };
    const res = jsonResponse(200, data);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), data);
  });

  it('honors a non-200 status code', async () => {
    const res = jsonResponse(404, { error: 'Not found' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  });

  it('sets Content-Type to application/json', () => {
    const res = jsonResponse(200, { ok: true });
    assert.equal(res.headers.get('Content-Type'), 'application/json');
  });

  it('includes the three CORS headers', () => {
    const res = jsonResponse(201, { created: true });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), CORS['Access-Control-Allow-Origin']);
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), CORS['Access-Control-Allow-Methods']);
    assert.equal(res.headers.get('Access-Control-Allow-Headers'), CORS['Access-Control-Allow-Headers']);
  });
});

// ─── optionsResponse() ────────────────────────────────────────────────────────

describe('api/_github.js optionsResponse()', () => {
  it('returns status 204', () => {
    const res = optionsResponse();
    assert.ok(res instanceof Response);
    assert.equal(res.status, 204);
  });

  it('includes the three CORS headers', () => {
    const res = optionsResponse();
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), CORS['Access-Control-Allow-Origin']);
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), CORS['Access-Control-Allow-Methods']);
    assert.equal(res.headers.get('Access-Control-Allow-Headers'), CORS['Access-Control-Allow-Headers']);
  });

  it('sets no Content-Type header, since the body is null', () => {
    const res = optionsResponse();
    assert.equal(res.headers.get('Content-Type'), null);
  });
});

// ─── headers(token) ───────────────────────────────────────────────────────────

describe('api/_github.js headers(token)', () => {
  it('builds the Authorization header as Bearer followed by the token', () => {
    const h = headers('tok_abc123');
    assert.equal(h.Authorization, 'Bearer tok_abc123');
  });

  it('sets the GitHub Accept, API version, and Content-Type values exactly', () => {
    const h = headers('tok_abc123');
    assert.equal(h.Accept, 'application/vnd.github+json');
    assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(h['Content-Type'], 'application/json');
  });
});

// ─── getConfig() ──────────────────────────────────────────────────────────────

describe('api/_github.js getConfig()', () => {
  const KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
  const saved = {};

  // Save the real env, then clear all three keys so each case starts from a
  // known-empty state. afterEach restores the originals so the suite leaves
  // process.env exactly as it found it.
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('throws a descriptive error when GITHUB_TOKEN is unset', () => {
    assert.throws(
      () => getConfig(),
      { message: 'GITHUB_TOKEN environment variable is not set' },
    );
  });

  it('returns the default repo and branch when only GITHUB_TOKEN is set', () => {
    process.env.GITHUB_TOKEN = 'tok123';
    assert.deepEqual(getConfig(), {
      token: 'tok123',
      repo: 'zeyuyang8/mochi-lab',
      branch: 'main',
    });
  });

  it('honors the GITHUB_REPO and GITHUB_BRANCH overrides when set', () => {
    process.env.GITHUB_TOKEN = 'tok123';
    process.env.GITHUB_REPO = 'octocat/hello-world';
    process.env.GITHUB_BRANCH = 'develop';
    assert.deepEqual(getConfig(), {
      token: 'tok123',
      repo: 'octocat/hello-world',
      branch: 'develop',
    });
  });
});
