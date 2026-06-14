import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the real module via createRequire the way
// the sibling route suites do (next-citationgraph-500 / next-dotexport-500), so this
// characterization test drives the genuine GET /api/backlinks handler rather than a
// reimplementation.
//
// It pins that handler's OUTER CATCH. A guard ABOVE the try rejects a missing ?path
// with json(res, 400, {error: 'Missing path param'}) (graph-trash-files.js:268);
// supplying a non-empty ?path clears that guard and enters the try at :269. The try's
// first failable step is the memoized scan call cached(`backlinks:${targetPath}`,
// 60000, fn) at :270; any throw from that call, or from inside the fn closure it wraps
// (the content scan's fs.readdirSync at :296), lands in the catch at :340 and returns
// json(res, 500, {error: 'Backlinks scan failed'}). The success projection
// json(res, 200, {backlinks}) at :338 is then never emitted.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/virtual-root';

// A non-empty target path that clears the pre-try 400 guard and reaches the memo call.
// The cache key the handler derives from it is `backlinks:${TARGET_PATH}`.
const TARGET_PATH = 'content/docs/x.md';

// The exact reply the outer catch emits, in the {status, body} shape the json() stub
// records below.
const GOLDEN_500 = { status: 500, body: { error: 'Backlinks scan failed' } };

// The reply the pre-try guard emits when ?path is absent. Used by the control case to
// prove that guard is genuinely wired (so the "never fired" assertions are not vacuous).
const GOLDEN_400 = { status: 400, body: { error: 'Missing path param' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the scan closure is never invoked, so the throw at the cached(`backlinks:…`, …) call
// (graph-trash-files.js:270) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes from
// INSIDE the scan closure (its first scanDir then fs.readdirSync) yet still reaches the
// SAME outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. Used on the
// throwing-cached path to prove the scan closure never ran (no filesystem walk).
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scanDir(contentDir)) throws,
// steering the pass-through-cached path into the outer catch from within the closure.
// readdirSync sits OUTSIDE scanDir's inner try/catch (which only guards readFileSync),
// so its throw escapes the closure and reaches the handler's outer catch.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/backlinks handler over a mocked ctx. The caller supplies the
// two seams used to steer the single try into its catch: `cached` and `fs`. Every
// json(res, status, payload) write is captured in `replies` so a test can assert the
// 500 is the ONLY reply and the success projection never fired, and every
// cached(key, ttl) invocation is recorded so a test can prove the throw originates at
// the one memo call this route reaches. `search` defaults to a cleared-guard query
// (?path=…); pass '' to omit ?path and exercise the pre-try 400 guard.
async function runBacklinks({ cached, fs, search = `?path=${TARGET_PATH}` }) {
  const replies = [];
  const cachedCalls = [];
  const res = { writableEnded: false };
  const ctx = {
    json(_res, status, payload) {
      const r = { status, body: payload };
      replies.push(r);
      res.writableEnded = true;
      return r;
    },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
  };
  const pathname = '/api/backlinks';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls, res };
}

describe('GET /api/backlinks outer catch returns 500 Backlinks scan failed', () => {
  it('maps a throw from the cached(backlinks:…) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runBacklinks({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Backlinks scan failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call this route reaches for a set ?path:
    // cached(`backlinks:${targetPath}`, 60000, fn), the first throwable step in the try.
    assert.deepStrictEqual(cachedCalls, [[`backlinks:${TARGET_PATH}`, 60000]]);
    assert.ok(cachedCalls[0][0].startsWith('backlinks:'), 'cache key is namespaced under backlinks:');

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {backlinks} projection, and the 400 guard never fires with ?path set', async () => {
    const { replies } = await runBacklinks({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries the
    // success projection's {backlinks} key, so the json(res, 200, {backlinks}) at :338
    // was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'backlinks' in r.body), false);

    // The pre-try 400 guard never fired: a non-empty ?path was supplied, so the request
    // cleared 'Missing path param' and reached the try.
    assert.equal(replies.some((r) => r.status === 400), false, 'the 400 Missing path param guard never fired');
    assert.equal(replies.some((r) => r.body && r.body.error === 'Missing path param'), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runBacklinks({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scanDir(contentDir) hits the
    // throwing readdirSync; the throw escapes the closure (the try/catch sits OUTSIDE
    // cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [[`backlinks:${TARGET_PATH}`, 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Same never-reached success proof on this seam.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'backlinks' in r.body), false);
  });

  it('fires the pre-try 400 guard (above the try) when ?path is omitted, before any cached call', async () => {
    // Control case: with no ?path, the guard at :268 returns 400 and the handler never
    // enters the try, so cached is never reached. This proves the guard is genuinely
    // above the try and makes the "guard never fired" assertions above non-vacuous.
    const fs = recordingFs();
    const { replies, cachedCalls } = await runBacklinks({ cached: throwingCached(), fs, search: '' });

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_400);
    assert.deepStrictEqual(cachedCalls, [], 'the guard sits above the try, so cached is never reached');
    assert.equal(fs.readdirCalls, 0, 'no scan on the guard path');
  });
});
