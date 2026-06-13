import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load the REAL module via createRequire the way
// the sibling research-tools suites do, then drive the /api/references/track
// handlers directly over a mocked ctx. This characterizes ONLY the pre-network
// guard rungs: every asserted case returns at its guard BEFORE the Semantic
// Scholar https.get, so no real network request is ever made. The GET
// missing-key, POST 429, and POST missing-or-invalid-key rungs also reject
// before any read, so they touch no filesystem at all.
//
// The POST handler reads the bibliography with a raw require('js-yaml') plus
// fs.readFileSync and yaml.load (it does NOT use loadReferencesCached), so the
// 404 and no-arxiv rungs are deterministic from the YAML string the fs mock
// returns, parsed by the real js-yaml. The GET missing-key rung returns before
// any read, so neither path here involves the shared references memo.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

const PROJECT_ROOT = '/fake/root';

// Build a recording ctx. `events` logs each fs side effect in order ('read' per
// readFileSync, 'write' per writeFileSync), so an empty array proves a guard
// rejected before any I/O and a lone ['read'] proves it read but never wrote.
// `readBodyCount` proves whether the body was consumed; `rateLimitCalls`
// captures the limiter key and ceiling. readFileSync returns `bibYaml` verbatim
// (a YAML string the real js-yaml parses) and writeFileSync is captured in
// memory, never hitting disk. `rateLimited` flips the limiter to throttled.
function makeCtx({ body, bibYaml, rateLimited }) {
  const recorders = { captured: null, readBodyCount: 0, events: [], writes: [], rateLimitCalls: [] };
  const ctx = {
    json(_res, status, payload) { recorders.captured = { status, payload }; return recorders.captured; },
    rateLimit(key, limit) { recorders.rateLimitCalls.push({ key, limit }); return !rateLimited; },
    readBody: async () => { recorders.readBodyCount += 1; return body; },
    sanitizeText: (x) => x,
    fs: {
      readFileSync: () => { recorders.events.push('read'); return bibYaml; },
      writeFileSync: (file, data) => { recorders.events.push('write'); recorders.writes.push({ file, data }); },
    },
    path,
    PROJECT_ROOT,
  };
  return { ctx, recorders };
}

// GET /api/references/track. `keyParam` undefined sends no key param at all;
// keyParam '' sends an empty ?key=. Both drive the missing-key guard, which
// returns before any read.
async function invokeGet(keyParam) {
  const pathname = '/api/references/track';
  const search = keyParam === undefined ? '' : `?key=${encodeURIComponent(keyParam)}`;
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const { ctx, recorders } = makeCtx({});
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return recorders;
}

// POST /api/references/track. Drives the rate-limit, missing-or-invalid-key,
// not-found, and no-arxiv guards depending on the body, bibYaml, and rateLimited
// inputs. remoteAddress 127.0.0.1 makes the limiter key 'track-ref:127.0.0.1'.
async function invokePost({ body, bibYaml = '{}', rateLimited = false, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/references/track';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const { ctx, recorders } = makeCtx({ body, bibYaml, rateLimited });
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return recorders;
}

describe('GET /api/references/track missing-key guard', () => {
  it('returns 400 Missing key param when no key param is present, touching no files', async () => {
    const { captured, events, readBodyCount } = await invokeGet(undefined);
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing key param' });
    // The guard is the first statement and returns before any read.
    assert.deepEqual(events, []);
    assert.equal(readBodyCount, 0);
  });

  it('returns 400 Missing key param for an empty ?key= as well', async () => {
    const { captured, events } = await invokeGet('');
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing key param' });
    assert.deepEqual(events, []);
  });
});

describe('POST /api/references/track pre-network guard ladder', () => {
  it('returns 429 when rate limited, never reading the body and recording the track-ref key at limit 10', async () => {
    const { captured, events, readBodyCount, rateLimitCalls } = await invokePost({
      body: { key: 'doe2021' },
      rateLimited: true,
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The limiter is the first statement, before the try block and before readBody.
    assert.deepEqual(rateLimitCalls, [{ key: 'track-ref:127.0.0.1', limit: 10 }]);
    assert.equal(readBodyCount, 0);
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing or invalid key when the key is omitted', async () => {
    const { captured, events, readBodyCount, rateLimitCalls } = await invokePost({
      body: {},
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    // The limiter passed and the body was read, then validation rejected before the read.
    assert.deepEqual(rateLimitCalls, [{ key: 'track-ref:127.0.0.1', limit: 10 }]);
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing or invalid key when the key is not a string', async () => {
    // A numeric key trips the typeof half of the guard rather than the falsy half.
    const { captured, events, readBodyCount } = await invokePost({
      body: { key: 123 },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
  });

  it('returns 404 Reference not found, reading the bibliography but never writing, when the key is absent', async () => {
    const { captured, events, writes, readBodyCount } = await invokePost({
      body: { key: 'ghost2023' },
      bibYaml: 'present:\n  title: A Different Paper\n  year: 2020\n',
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Reference not found' });
    // The read happened; the guard returns before any write.
    assert.deepEqual(events, ['read']);
    assert.equal(writes.length, 0);
    assert.equal(readBodyCount, 1);
  });

  it('returns 400 No arXiv ID found for this reference when the entry has no arXiv id or url', async () => {
    const { captured, events, writes } = await invokePost({
      body: { key: 'ref_noarxiv' },
      bibYaml: 'ref_noarxiv:\n  type: article\n  title: Paper Without ArXiv\n  year: 2021\n  venue: Some Workshop\n',
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'No arXiv ID found for this reference' });
    // POST returns 400 here, while the GET method returns 200 with
    // published:false for the same message, so the status pins this to the POST
    // branch. The read happened; nothing is written.
    assert.deepEqual(events, ['read']);
    assert.equal(writes.length, 0);
  });
});
