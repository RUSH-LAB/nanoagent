import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module via createRequire the
// way the sibling activity-feed route tests do, so this characterization test
// drives the genuine GET /api/activity-feed handler instead of a reimplementation.
// numericParam is required at the module top from ../server-utils, so it belongs
// to the real module and is never stubbed: the `const limit = ...` line runs
// before the try and must not throw.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
const COMMENTS_FILE = 'comments';
const DISCUSSIONS_FILE = 'discussions';
const ANNOTATIONS_FILE = 'annotations';

// The sibling success suites (projection, guard, negative-limit-clamp) drive the
// handler with this ctx shape: the node path module, the data-file path tokens,
// and a loadJSON that dispatches on the file token. The reviews source path is
// computed inside the handler as path.join(PROJECT_ROOT, 'var', 'data', 'reviews.json'),
// so the dispatcher keys the reviews fixture off that exact resolved path. With
// throwOnLoad set, loadJSON throws on its very first call (the comments load, the
// first failable step inside the try), sending the handler into the outer catch.
function makeCtx({ comments = {}, discussions = {}, annotations = {}, reviews = {}, throwOnLoad = false } = {}) {
  const REVIEWS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'reviews.json');
  const calls = { loadJSON: [] };
  const ctx = {
    path,
    PROJECT_ROOT,
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
    ANNOTATIONS_FILE,
    loadJSON(file) {
      calls.loadJSON.push(file);
      if (throwOnLoad) throw new Error('activity store unreadable');
      if (file === COMMENTS_FILE) return comments;
      if (file === DISCUSSIONS_FILE) return discussions;
      if (file === ANNOTATIONS_FILE) return annotations;
      if (file === REVIEWS_FILE) return reviews;
      return {};
    },
  };
  return { ctx, calls };
}

// Invoke GET /api/activity-feed with the mocked ctx, recording every
// json(res, status, payload) reply the handler emits. Both the success path and
// the outer catch reply through json, so capturing all of them lets a test prove
// the success 200 reply is never emitted once the load throws. Fully in process:
// no network, no server, no disk.
async function invoke(ctx, search = '') {
  const pathname = '/api/activity-feed';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const jsonCalls = [];
  const fullCtx = {
    json(_res, status, payload) {
      const reply = { status, payload };
      jsonCalls.push(reply);
      res.writableEnded = true;
      return reply;
    },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { jsonCalls, res };
}

describe('GET /api/activity-feed: outer-catch 500', () => {
  it('reaches the 200 {events, total} reply with this ctx when loadJSON does not throw', async () => {
    // Reachability anchor: the very same ctx the failure cases use produces a real
    // 200 when loadJSON returns data, so the never-reached proof below is meaningful
    // and the 500 is not a side effect of a broken ctx. The detailed projection
    // golden is owned by next-activity-feed-projection; this pins only that the
    // success reply is reachable with this exact ctx shape.
    const { ctx, calls } = makeCtx({
      comments: { 'guide.md': [{ author: 'alice', text: 'hi', createdAt: '2024-05-01T00:00:00.000Z' }] },
    });
    const { jsonCalls } = await invoke(ctx);

    assert.equal(jsonCalls.length, 1, 'the success path emits exactly one reply');
    assert.deepEqual(jsonCalls[0], {
      status: 200,
      payload: {
        events: [{ type: 'comment', page: 'guide.md', author: 'alice', preview: 'hi', timestamp: '2024-05-01T00:00:00.000Z' }],
        total: 1,
      },
    });
    assert.equal(calls.loadJSON.length, 4, 'the success path loads all four sources');
  });

  it('returns 500 Activity feed failed via json when the first loadJSON throws', async () => {
    const { ctx } = makeCtx({ throwOnLoad: true });
    const { jsonCalls, res } = await invoke(ctx);

    // The single reply is the outer-catch golden, captured by deepEqual.
    assert.equal(jsonCalls.length, 1, 'the handler emits exactly one reply');
    assert.deepEqual(jsonCalls[0], { status: 500, payload: { error: 'Activity feed failed' } });
    assert.equal(res.writableEnded, true, 'the 500 reply finished the response');
  });

  it('throws at the first failable step, so the 200 {events, total} body is never reached', async () => {
    const { ctx, calls } = makeCtx({ throwOnLoad: true });
    const { jsonCalls } = await invoke(ctx);

    // loadJSON throws on its first call (the comments load), so the downstream
    // discussions, annotations, and reviews loads never run.
    assert.deepEqual(calls.loadJSON, [COMMENTS_FILE], 'only the comments load is attempted before the throw');
    // Never-reached proof: exactly one reply, and no json call carried the success
    // 200 {events, total} body.
    assert.equal(jsonCalls.length, 1, 'the catch emits the only reply');
    assert.equal(jsonCalls.find(c => c.status === 200), undefined, 'the success 200 body was never emitted');
  });
});
