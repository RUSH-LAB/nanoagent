import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// route suites do (see tests/next-content-a-cache-refs.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

// The route path is the honest anchor: the 'Missing query' message is shared by
// several handlers, but '/api/search/semantic' is unique to this guard.
const ROUTE = '/api/search/semantic';

// An fs whose read entry points are tripwires: each one bumps a counter and then
// throws. The handler's content walk (fs.readdirSync, then fs.readFileSync per
// file) lives inside the try block AFTER the missing-query guard, so a correct
// guard returns 400 before any of these run. The counter is incremented before
// the throw on purpose: the handler wraps its scan in try/catch, so a swallowed
// throw would still leave a tell (reads > 0) for the assertion to catch.
function makeTripwireFs() {
  const counts = { reads: 0 };
  const trip = (name) => () => {
    counts.reads += 1;
    throw new Error(`fs.${name} ran before the Missing query guard`);
  };
  const fs = {
    readdirSync: trip('readdirSync'),
    readFileSync: trip('readFileSync'),
    statSync: trip('statSync'),
    existsSync: trip('existsSync'),
  };
  return { fs, counts };
}

// Drive GET /api/search/semantic entirely in process: no network, no server. The
// handler answers through json(res, status, payload), which we capture. The ctx
// only needs json plus the fs tripwire here; fs, path, and PROJECT_ROOT are read
// solely inside the post-guard try, so the guard path never touches them.
async function getSemantic(search) {
  const { fs, counts } = makeTripwireFs();
  const url = new URL(`http://localhost${ROUTE}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  let json = null;
  const ctx = {
    json(_res, status, payload) { json = { status, payload }; res.writableEnded = true; return json; },
    fs,
    path,
    PROJECT_ROOT: '/fake/root',
    CORS_ORIGIN: '*',
  };
  await routes(req, res, url, ROUTE, ctx);
  return { json, reads: counts.reads };
}

describe('GET /api/search/semantic: missing-query 400 guard', () => {
  it('returns 400 {error: "Missing query"} when q is absent, before any fs read', async () => {
    const { json, reads } = await getSemantic('');
    assert.ok(json, 'the handler sent a json response');
    assert.equal(json.status, 400);
    assert.deepEqual(json.payload, { error: 'Missing query' });
    assert.equal(reads, 0, 'the guard returns before the filesystem walk');
  });

  it('returns 400 {error: "Missing query"} for an empty q (?q=), before any fs read', async () => {
    const { json, reads } = await getSemantic('?q=');
    assert.ok(json, 'the handler sent a json response');
    assert.equal(json.status, 400);
    assert.deepEqual(json.payload, { error: 'Missing query' });
    assert.equal(reads, 0, 'the guard returns before the filesystem walk');
  });

  it('returns 400 {error: "Missing query"} for a whitespace-only q (?q=%20%20), before any fs read', async () => {
    const { json, reads } = await getSemantic('?q=%20%20');
    assert.ok(json, 'the handler sent a json response');
    assert.equal(json.status, 400);
    assert.deepEqual(json.payload, { error: 'Missing query' });
    assert.equal(reads, 0, 'the guard trims whitespace to empty, then returns before the filesystem walk');
  });
});
