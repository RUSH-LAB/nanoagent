import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// route tests do (mirroring tests/next-analytics-export-csv.test.mjs and
// tests/next-productivity-report-fold.test.mjs), so this characterization test
// drives the genuine GET /api/productivity-report handler, never a
// reimplementation.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

// Distinctive sentinel file paths. The handler's first data read is
// loadJSON(STREAKS_FILE) at content-analysis-a.js:51; loadJSON(ANALYTICS_FILE)
// only runs later (line 81). Throwing on the STREAKS_FILE read therefore lands
// directly in the outer catch (line 122) before the analytics load, the
// cached('content-stats') scan, and the 200 assembly.
const STREAKS_FILE = '/fake/root/data/streaks.json';
const ANALYTICS_FILE = '/fake/root/data/analytics.json';

// Build a ctx whose loadJSON throws on its first call. Every loadJSON file is
// recorded so the test can prove the throw lands on the first read and that the
// read is STREAKS_FILE, and every json(res, status, payload) reply is captured
// so the test can prove the success 200 projection is never emitted.
function makeCtx() {
  const calls = { loadJSON: [] };
  const replies = [];
  const ctx = {
    STREAKS_FILE,
    ANALYTICS_FILE,
    loadJSON(file) {
      calls.loadJSON.push(file);
      throw new Error('streaks store unreadable');
    },
    json(_res, status, payload) {
      replies.push({ status, payload });
      _res.writableEnded = true;
      return { status, payload };
    },
  };
  return { ctx, calls, replies };
}

// Invoke the productivity-report handler over the mocked ctx, fully in process:
// no network, no server, no disk. `writableEnded` mirrors how the live
// dispatcher in server.js detects that a reply was sent.
async function invoke(ctx) {
  const pathname = '/api/productivity-report';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { res };
}

describe('GET /api/productivity-report: outer-catch 500', () => {
  it('returns the 500 Productivity report failed golden when the first (STREAKS_FILE) read throws', async () => {
    const { ctx, replies } = makeCtx();
    await invoke(ctx);

    // Exactly one reply, and it is the outer-catch 500 golden.
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], { status: 500, payload: { error: 'Productivity report failed' } });
  });

  it('reaches the catch via the first loadJSON call, the STREAKS_FILE read', async () => {
    const { ctx, calls } = makeCtx();
    await invoke(ctx);

    // The throw lands on the very first data read, so loadJSON ran exactly once
    // and with STREAKS_FILE; the later loadJSON(ANALYTICS_FILE) at line 81 is
    // never reached.
    assert.equal(calls.loadJSON.length, 1);
    assert.equal(calls.loadJSON[0], STREAKS_FILE);
  });

  it('never emits the success 200 projection', async () => {
    const { ctx, replies } = makeCtx();
    const { res } = await invoke(ctx);

    // The never-reached proof: no captured reply carries status 200, so the
    // {streak, content, traffic, generatedAt} success body (whose live
    // generatedAt timestamp would make a full 200 deep-equal clock dependent) is
    // never assembled or sent. The lone reply is the 500 golden above.
    assert.equal(replies.some(r => r.status === 200), false);
    assert.equal(res.writableEnded, true);
  });
});
