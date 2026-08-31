import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { key } from '../_harness.mjs';

// Pins the behavior of the `json()` Cache-Control consolidation:
//   - server/index.js `json(res, status, data, opts)` overrides Cache-Control only on
//     the GET-200 ETag branch, defaulting to 'no-cache' when no opts are given;
//   - GET /api/stats and GET /api/templates now route through json() and must
//     emit byte-identical responses to the old hand-rolled header blocks.
// The helper is exercised in isolation and the two routes through a mocked ctx,
// so this test never boots a server (matching the existing test suite).

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

// ── Load the REAL json() helper out of server/index.js without booting the server ──
// server/index.js calls server.listen() unconditionally at module load and exports
// nothing, so it cannot be require()'d from a unit test. Instead we lift the
// exact source of the top-level `function json(...)` and of `corsHeaders(...)`,
// which it calls, and instantiate them with the module-scope values they close
// over: crypto and CORS_ORIGIN. This pins the helpers' real bytes rather than a
// reimplementation.
const TEST_CORS_ORIGIN = '*';

/** Lift one top-level `function <name>` out of server/index.js by brace balance. */
function liftFunction(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => new RegExp(`^function ${name}\\b`).test(l));
  assert.ok(start !== -1, `server/index.js must define a top-level \`function ${name}\``);
  // Walk from the opening line, balancing braces, until the function closes. This
  // is robust to indentation and neither body has braces inside its strings or
  // comments. Either way it fails loud (a failed assert or a SyntaxError from new
  // Function), never silently.
  let depth = 0, opened = false, end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth === 0) { end = i; break; }
  }
  assert.ok(end !== -1, `could not find the end of \`function ${name}\` in server/index.js`);
  return lines.slice(start, end + 1).join('\n');
}

function loadJson(corsOrigin = TEST_CORS_ORIGIN) {
  const src = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
  const make = new Function(
    'crypto', 'CORS_ORIGIN',
    `${liftFunction(src, 'corsHeaders')}\n${liftFunction(src, 'json')}\nreturn json;`,
  );
  return make(crypto, corsOrigin);
}

const json = loadJson();

// Minimal stand-in for a Node http ServerResponse. json() reads res.req and
// calls res.writeHead / res.end, so we capture both verbatim.
function mockRes(method, reqHeaders = {}) {
  return {
    req: { method, headers: reqHeaders },
    statusCode: null,
    headers: null,
    body: undefined,
    ended: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; this.ended = true; },
  };
}

const BASE_HEADER_KEYS = [
  'Content-Type',
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Credentials',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Vary',
  'X-API-Version',
  'X-Powered-By',
];
const ETAG_HEADER_KEYS = [...BASE_HEADER_KEYS, 'ETag', 'Cache-Control'];

function expectedEtag(data) {
  const body = JSON.stringify(data);
  return '"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 16) + '"';
}

// Reference oracle: the exact response the OLD hand-rolled blocks produced. The
// consolidation must reproduce this byte-for-byte (status, header set, header
// order, values, body).
function legacyHandRolled(data, cacheControl, { corsOrigin = TEST_CORS_ORIGIN, ifNoneMatch } = {}) {
  const body = JSON.stringify(data);
  const etag = expectedEtag(data);
  const headers = {
    'Content-Type': 'application/json',
    // Allow-Origin echoes the caller rather than answering '*': the auth client
    // sends credentialed requests, and a browser rejects a credentialed
    // response whose Allow-Origin is '*' before the caller ever sees it.
    // Authorization is allowed so the preflight lets the session token through.
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
    'X-API-Version': '1.0',
    'X-Powered-By': 'Mochi Lab',
    'ETag': etag,
    'Cache-Control': cacheControl,
  };
  if (ifNoneMatch === etag) return { status: 304, headers, body: undefined };
  return { status: 200, headers, body };
}

function assertSameResponse(res, expected) {
  assert.equal(res.statusCode, expected.status);
  assert.deepEqual(Object.keys(res.headers), Object.keys(expected.headers)); // order
  assert.deepEqual(res.headers, expected.headers);                           // set + values
  assert.equal(res.body, expected.body);
}

describe('json() Cache-Control override (moon-etag-json-cachecontrol)', () => {
  it('defaults Cache-Control to no-cache on a GET-200 with no opts (legacy 3-arg callers unchanged)', () => {
    const res = mockRes('GET');
    const data = { hello: 'world' };
    json(res, 200, data);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-cache');
    assert.equal(res.headers['ETag'], expectedEtag(data));
    assert.equal(res.body, JSON.stringify(data));
    assert.deepEqual(Object.keys(res.headers), ETAG_HEADER_KEYS);
  });

  it('treats an opts object without cacheControl the same as no opts (still no-cache)', () => {
    const res = mockRes('GET');
    json(res, 200, { a: 1 }, {});
    assert.equal(res.headers['Cache-Control'], 'no-cache');
  });

  it('overrides Cache-Control with opts.cacheControl on a GET-200', () => {
    const res = mockRes('GET');
    const data = { totalFiles: 3 };
    json(res, 200, data, { cacheControl: 'public, max-age=30' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'public, max-age=30');
    assert.equal(res.headers['ETag'], expectedEtag(data));
    assert.equal(res.body, JSON.stringify(data));
  });

  it('preserves the full header set AND insertion order on the GET-200 ETag branch', () => {
    const res = mockRes('GET');
    json(res, 200, { a: 1 }, { cacheControl: 'public, max-age=30' });
    assert.deepEqual(Object.keys(res.headers), ETAG_HEADER_KEYS);
  });

  it('short-circuits to 304 with an empty body on a matching if-none-match, carrying the override', () => {
    const data = { totalFiles: 3 };
    const etag = expectedEtag(data);
    const res = mockRes('GET', { 'if-none-match': etag });
    json(res, 200, data, { cacheControl: 'public, max-age=30' });
    assert.equal(res.statusCode, 304);
    assert.equal(res.body, undefined);
    assert.equal(res.ended, true);
    assert.equal(res.headers['ETag'], etag);
    assert.equal(res.headers['Cache-Control'], 'public, max-age=30');
  });

  it('does NOT short-circuit when if-none-match does not match the ETag', () => {
    const data = { totalFiles: 3 };
    const res = mockRes('GET', { 'if-none-match': '"stale"' });
    json(res, 200, data, { cacheControl: 'public, max-age=30' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, JSON.stringify(data));
  });

  it('emits only the base headers (no ETag, no Cache-Control) on a non-GET, even when cacheControl is passed', () => {
    const res = mockRes('POST');
    json(res, 200, { ok: true }, { cacheControl: 'public, max-age=30' });
    assert.deepEqual(Object.keys(res.headers), BASE_HEADER_KEYS);
    assert.equal(res.headers['ETag'], undefined);
    assert.equal(res.headers['Cache-Control'], undefined);
    assert.equal(res.body, JSON.stringify({ ok: true }));
  });

  it('emits only the base headers on a GET with a non-200 status, even when cacheControl is passed', () => {
    const res = mockRes('GET');
    json(res, 500, { error: 'boom' }, { cacheControl: 'public, max-age=30' });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(Object.keys(res.headers), BASE_HEADER_KEYS);
    assert.equal(res.headers['Cache-Control'], undefined);
  });

  it('reflects the configured CORS origin (no hard-coded star)', () => {
    const jsonCustom = loadJson('https://mochi.example');
    const res = mockRes('GET');
    jsonCustom(res, 200, { a: 1 });
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://mochi.example');
  });
});

describe('json() reproduces the old hand-rolled blocks byte-for-byte', () => {
  const CASES = [
    { name: '/api/stats', cacheControl: 'public, max-age=30', data: { totalFiles: 7, totalWords: 1234, references: 5, byDirectory: { blog: { files: 3, words: 600 } } } },
    { name: '/api/templates', cacheControl: 'public, max-age=3600', data: { templates: [{ id: 'blank' }, { id: 'blog' }] } },
  ];
  for (const { name, cacheControl, data } of CASES) {
    it(`${name}: 200 response matches the legacy oracle`, () => {
      const res = mockRes('GET');
      json(res, 200, data, { cacheControl });
      assertSameResponse(res, legacyHandRolled(data, cacheControl));
    });
    it(`${name}: 304 response matches the legacy oracle on a matching if-none-match`, () => {
      const ifNoneMatch = expectedEtag(data);
      const res = mockRes('GET', { 'if-none-match': ifNoneMatch });
      json(res, 200, data, { cacheControl });
      assertSameResponse(res, legacyHandRolled(data, cacheControl, { ifNoneMatch }));
    });
  }
});

// Drive the two real route handlers with a mocked ctx and capture the json()
// call. This pins that each call site forwards the correct cacheControl and body
// shape, without depending on a running server or the filesystem.
describe('route call sites forward the right cacheControl', () => {
  it('GET /api/stats calls json with cacheControl public, max-age=30', async () => {
    const filesRoutes = require('../../../src/server/routes/files.js');
    const FAKE_STATS = { totalFiles: 7, totalWords: 1234, references: 5, byDirectory: {} };
    let captured = null;
    const ctx = {
      cacheKey: (_orgId, name) => key(name), // the handler scopes its key to the workspace
      cached: (_key, _ttl, _fn) => FAKE_STATS, // bypass the content-dir walk
      json: (_res, status, data, opts) => { captured = { status, data, opts }; },
    };
    const url = new URL('http://localhost/api/stats');
    await filesRoutes({ method: 'GET', headers: {} }, { writableEnded: false }, url, '/api/stats', ctx);
    assert.ok(captured, 'json() must be called');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.data, FAKE_STATS);
    assert.deepEqual(captured.opts, { cacheControl: 'public, max-age=30' });
  });

});
