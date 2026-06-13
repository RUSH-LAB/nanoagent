import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL route module the way the sibling feeds
// route tests do (next-feeds-sessions-post-validation-guards,
// next-importbibtex-guards). This pins the CURRENT behavior of the pre-network
// guards on POST /api/import-url (handler at feeds.js line 214): the rate-limit
// rung, the input-validation rungs, and the conflict rung. Every one of these
// returns before the https.get call, so a guarded request never touches the
// network. No source file is edited.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/tmp/next-feeds-importurl-preget-test';

// The handler picks its client with require('https') / require('http') and calls
// .get on it. Core modules are process-global singletons, so the objects this
// test require()s are the very objects the handler would see. Replace their .get
// with a tripwire that records a read and then throws, proving no guarded case
// reaches the network. The recorder must read zero on every case below.
const http = require('http');
const https = require('https');
let networkReads = 0;
const realHttpGet = http.get;
const realHttpsGet = https.get;
before(() => {
  http.get = () => { networkReads += 1; throw new Error('network reached: a guard let the request through'); };
  https.get = () => { networkReads += 1; throw new Error('network reached: a guard let the request through'); };
});
after(() => {
  http.get = realHttpGet;
  https.get = realHttpsGet;
});

// Drive a single POST /api/import-url request over a fully mocked ctx, mirroring
// the ctx shape the sibling feeds route tests use. `readBody` resolves to the
// supplied body and counts its calls so the 429 rung can prove it returns before
// any body read. `rateLimit` records its (key, ceiling) and returns false only
// when throttled. `isValidFilePath` and `fs.existsSync` are configurable booleans
// so each later rung is reachable in turn. No real clock, filesystem, or network
// is touched, and `networkReads` is reset per call so each case asserts its own
// zero.
async function invoke({ body, throttled = false, validPath = true, exists = false, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/import-url';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };

  let captured = null;
  let readBodyCalls = 0;
  const rateLimitCalls = [];
  const existsArgs = [];

  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    rateLimit(key, max) { rateLimitCalls.push({ key, max }); return !throttled; },
    readBody: async () => { readBodyCalls += 1; return body; },
    isValidFilePath: () => validPath,
    fs: { existsSync: (p) => { existsArgs.push(p); return exists; } },
    path,
    PROJECT_ROOT,
  };

  networkReads = 0;
  await feedsRoutes(req, res, url, pathname, ctx);
  return { captured, readBodyCalls, rateLimitCalls, existsArgs, networkReads };
}

describe('POST /api/import-url pre-network guards', () => {
  // Rung 1 (rate limit): the limiter is consulted with the per-address key and a
  // ceiling of 5, and a throttled request returns 429 before the body is read.
  it('returns 429 before reading the body when the limiter rejects, keyed import-url:<addr> at ceiling 5', async () => {
    const { captured, readBodyCalls, rateLimitCalls, networkReads } = await invoke({
      body: { url: 'https://example.com', targetPath: 'content/x.md' },
      throttled: true,
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    assert.deepEqual(rateLimitCalls, [{ key: 'import-url:127.0.0.1', max: 5 }]);
    assert.equal(readBodyCalls, 0);
    assert.equal(networkReads, 0);
  });

  // Rung 2 (url present): a missing url is rejected. This runs after readBody but
  // before the network, so the body is read once and the recorder stays at zero.
  it('returns 400 Missing or invalid url when the body has no url', async () => {
    const { captured, readBodyCalls, networkReads } = await invoke({ body: { targetPath: 'content/x.md' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid url' });
    assert.equal(readBodyCalls, 1);
    assert.equal(networkReads, 0);
  });

  // Rung 2 (url type): a non-string url is rejected with the same body.
  it('returns 400 Missing or invalid url when url is a non-string', async () => {
    const { captured, networkReads } = await invoke({ body: { url: 123, targetPath: 'content/x.md' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid url' });
    assert.equal(networkReads, 0);
  });

  // Rung 3 (targetPath present): a valid url with no targetPath is rejected.
  it('returns 400 Missing or invalid targetPath when targetPath is absent', async () => {
    const { captured, networkReads } = await invoke({ body: { url: 'https://example.com' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid targetPath' });
    assert.equal(networkReads, 0);
  });

  // Rung 4 (title type): a present but non-string optional title is rejected.
  it('returns 400 when an optional title is present but not a string', async () => {
    const { captured, networkReads } = await invoke({
      body: { url: 'https://example.com', targetPath: 'content/x.md', title: 123 },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'title must be a string' });
    assert.equal(networkReads, 0);
  });

  // Rung 5 (path safety): isValidFilePath rejecting the targetPath yields 400,
  // even though every earlier field is well formed.
  it('returns 400 Invalid targetPath when isValidFilePath rejects the path', async () => {
    const { captured, networkReads } = await invoke({
      body: { url: 'https://example.com', targetPath: '../outside.md' },
      validPath: false,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid targetPath' });
    assert.equal(networkReads, 0);
  });

  // Rung 6 (scheme): a url whose scheme is neither http nor https is rejected,
  // so a path such as ftp://... never reaches the fetch.
  it('returns 400 when the url scheme is neither http nor https', async () => {
    const { captured, networkReads } = await invoke({
      body: { url: 'ftp://example.com/file.txt', targetPath: 'content/x.md' },
      validPath: true,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'URL must start with http:// or https://' });
    assert.equal(networkReads, 0);
  });

  // Rung 7 (conflict): when the resolved target already exists the request is
  // rejected with 409, and the existence check is the PROJECT_ROOT joined with
  // the requested targetPath.
  it('returns 409 when the target file already exists, checking the joined path', async () => {
    const targetPath = 'content/dup.md';
    const { captured, existsArgs, networkReads } = await invoke({
      body: { url: 'https://example.com/page', targetPath },
      validPath: true,
      exists: true,
    });
    assert.equal(captured.status, 409);
    assert.deepEqual(captured.payload, { error: 'Target file already exists' });
    assert.deepEqual(existsArgs, [path.join(PROJECT_ROOT, targetPath)]);
    assert.equal(networkReads, 0);
  });
});
