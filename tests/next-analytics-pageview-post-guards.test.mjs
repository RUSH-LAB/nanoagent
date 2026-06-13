import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the REAL route module the way the sibling
// server route tests do (see tests/next-discussions-delete-msg-guards.test.mjs and
// tests/next-analyticsusers-dedup-protokeys.test.mjs), so these cases exercise the
// shipped POST /api/analytics/pageview handler rather than a reimplementation.
//
// The proto-key 'Invalid path' branch is already pinned by
// tests/next-analyticsusers-dedup-protokeys.test.mjs, so this file pins the OTHER
// input-validation guards the handler runs before any store IO: the rate limit, the
// Missing path and Path too long checks on `path`, and the referrer and userAgent
// type checks. Every branch here returns before loadJSON, saveJSON, and new Date(),
// so the cases are deterministic and the file edits no source.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

const PATH = '/api/analytics/pageview';

// Drive the POST /api/analytics/pageview handler with a minimal mocked ctx. `body`
// is what the handler receives from `await readBody(req)`. The recorders capture the
// response handed to json(res, status, payload), the rate-limit arguments, and how
// many times readBody, loadJSON, and saveJSON ran, so each guard is pinned both by
// its status and body and by the IO it did NOT perform. loadJSON and saveJSON are
// recorders only: no guard under test should reach them, so a count above zero means
// a guard fell through.
async function invoke({
  body = {},
  rateLimitOk = true,
  remoteAddress = '127.0.0.1',
} = {}) {
  const url = new URL(`http://localhost${PATH}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  let captured = null;
  let readBodyCount = 0;
  let loadCount = 0;
  let saveCount = 0;
  let rateLimitArgs = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    rateLimit: (key, limit) => { rateLimitArgs = { key, limit }; return rateLimitOk; },
    readBody: async () => { readBodyCount += 1; return body; },
    loadJSON: () => { loadCount += 1; return {}; },
    saveJSON: () => { saveCount += 1; },
    ANALYTICS_FILE: '/tmp/analytics-pageview-post-guards-test.json',
  };
  await analyticsUsersRoutes(req, res, url, PATH, ctx);
  return { captured, readBodyCount, loadCount, saveCount, rateLimitArgs };
}

describe('POST /api/analytics/pageview input-validation guards (current behavior)', () => {
  it('returns 429 with the pageview key and limit 60 and does zero IO when rate limited', async () => {
    const { captured, readBodyCount, loadCount, saveCount, rateLimitArgs } = await invoke({
      body: { path: '/docs/intro' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The rate-limit guard sits before the try block, so readBody never runs and
    // nothing loads or saves.
    assert.equal(readBodyCount, 0);
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
    // The handler keys the limiter on the socket address and allows 60 per window.
    assert.equal(rateLimitArgs.key, 'pageview:127.0.0.1');
    assert.equal(rateLimitArgs.limit, 60);
  });

  it('returns 400 Missing path for a falsy or non-string path', async () => {
    // `!pagePath || typeof pagePath !== 'string'` rejects every falsy value plus any
    // truthy non-string, before any store IO.
    const bodies = [
      {},             // path omitted (undefined)
      { path: '' },   // empty string
      { path: null },
      { path: 0 },
      { path: false },
      { path: 123 },  // truthy, but not a string
      { path: true },
    ];
    for (const body of bodies) {
      const { captured, readBodyCount, loadCount, saveCount } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing path' });
      // readBody ran (the rate limit passed), but the guard returns before store IO.
      assert.equal(readBodyCount, 1);
      assert.equal(loadCount, 0);
      assert.equal(saveCount, 0);
    }
  });

  it('returns 400 Path too long for a 501-character path', async () => {
    // The length guard fires once `path.length > 500`. A 500-character path clears it,
    // but that accepting case is not asserted here because it proceeds to loadJSON,
    // saveJSON, and new Date(), which this deterministic guard suite avoids.
    const { captured, readBodyCount, loadCount, saveCount } = await invoke({
      body: { path: 'a'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Path too long' });
    assert.equal(readBodyCount, 1);
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 referrer must be a string for a defined non-string referrer', async () => {
    // A valid path clears the earlier guards so the referrer type check is what
    // rejects. `referrer !== undefined && typeof referrer !== 'string'` flags any
    // defined non-string, including null.
    for (const referrer of [123, null, true, {}, []]) {
      const { captured, readBodyCount, loadCount, saveCount } = await invoke({
        body: { path: '/docs/intro', referrer },
      });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'referrer must be a string' });
      assert.equal(readBodyCount, 1);
      assert.equal(loadCount, 0);
      assert.equal(saveCount, 0);
    }
  });

  it('returns 400 userAgent must be a string for a defined non-string userAgent', async () => {
    // A valid path and a valid (string) referrer clear the earlier guards, so the
    // userAgent type check is what rejects the defined non-string.
    for (const userAgent of [123, null, true, {}, []]) {
      const { captured, readBodyCount, loadCount, saveCount } = await invoke({
        body: { path: '/docs/intro', referrer: 'https://example.com', userAgent },
      });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'userAgent must be a string' });
      assert.equal(readBodyCount, 1);
      assert.equal(loadCount, 0);
      assert.equal(saveCount, 0);
    }
  });

  it('checks referrer before userAgent when both are non-string', async () => {
    // Guard order: the referrer type check precedes the userAgent one, so a body with
    // both invalid reports the referrer error and never reaches the store.
    const { captured, loadCount, saveCount } = await invoke({
      body: { path: '/docs/intro', referrer: 1, userAgent: 2 },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'referrer must be a string' });
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });
});
