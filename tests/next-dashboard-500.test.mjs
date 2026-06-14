import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load the real module the way the sibling route
// tests do (see tests/next-analytics-export-csv.test.mjs), so this
// characterization test drives the genuine GET /api/dashboard handler rather than
// a reimplementation.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// The dashboard handler (analysis-admin.js:878) assembles its payload through the
// memoized helper cached('api-dashboard', 30000, () => {...}) at line 880 and, on
// any throw, falls into the outer catch at line 985 that replies
// json(res, 500, {error: 'Dashboard failed'}). Stubbing ctx.cached to throw makes
// that assembly call fail before the projection closure runs, so the 500 golden
// is reached deterministically: the closure's live inputs (require('js-yaml'),
// process.memoryUsage(), process.uptime(), and generatedAt via
// new Date().toISOString()) never execute. Only cached and json are read on this path, so ctx supplies just those
// two, and every json(res, status, payload) reply is recorded to prove the 200
// projection {server, content, activity, tests, endpoints, health, generatedAt}
// is never emitted.
function makeCtx() {
  const calls = { cached: [], json: [] };
  const ctx = {
    cached(key, ttl, build) {
      calls.cached.push({ key, ttl, buildType: typeof build });
      throw new Error('boom'); // force the GET /api/dashboard outer catch
    },
    json(res, status, payload) {
      calls.json.push({ status, payload });
      res.writableEnded = true;
      return { status, payload };
    },
  };
  return { ctx, calls };
}

// Invoke the real route module for GET /api/dashboard fully in process: no
// network, no server, no disk. The dispatcher in server.js detects a sent reply
// via res.writableEnded, which the json stub sets.
async function invoke(ctx) {
  const pathname = '/api/dashboard';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  await routes(req, res, url, pathname, ctx);
  return res;
}

describe('GET /api/dashboard: outer-catch 500', () => {
  it('replies 500 {error: "Dashboard failed"} when the cached assembly throws', async () => {
    const { ctx, calls } = makeCtx();
    const res = await invoke(ctx);

    // The memoized assembly ran (and threw) exactly once, with the dashboard
    // cache key and 30s TTL the handler passes at analysis-admin.js:880.
    assert.equal(calls.cached.length, 1, 'cached() was invoked once');
    assert.deepStrictEqual(
      { key: calls.cached[0].key, ttl: calls.cached[0].ttl },
      { key: 'api-dashboard', ttl: 30000 },
    );

    // Exactly one reply, the 500 golden, and it ended the response.
    assert.equal(calls.json.length, 1, 'the handler emits exactly one reply');
    assert.deepStrictEqual(calls.json[0], { status: 500, payload: { error: 'Dashboard failed' } });
    assert.equal(res.writableEnded, true, 'the 500 reply ended the response');
  });

  it('never emits the success 200 projection (never-reached proof)', async () => {
    const { ctx, calls } = makeCtx();
    await invoke(ctx);

    // never-reached proof: cached threw (so it ran) and no captured reply carries
    // status 200, so the success projection is never built or sent.
    assert.equal(calls.cached.length, 1, 'cached ran before the throw reached the catch');
    assert.equal(
      calls.json.filter(c => c.status === 200).length,
      0,
      'no 200 {server, content, activity, tests, endpoints, health, generatedAt} reply is emitted',
    );
  });
});
