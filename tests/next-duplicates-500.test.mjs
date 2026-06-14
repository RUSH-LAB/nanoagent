import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-orphans-500 / next-healthsummary-500 /
// next-bibanalytics-500), so this characterization test drives the genuine
// GET /api/analytics/duplicates handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole duplicate scan runs inside one try
// (handler at analysis-admin.js:335, try opens at :336). The try's first failable step
// is the memoized scan call `cached('analytics:duplicates', 60000, fn)` at :337; any
// throw from that call, or from inside the fn closure it wraps, lands in the catch at
// :408 through :410, which returns `json(res, 500, {error: 'Duplicate scan failed'})`.
// The success 200 projection `{duplicates}` returned at :407 is then never emitted.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Duplicate scan failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the scan closure is never invoked, so the throw at the cached('analytics:duplicates', …)
// call (analysis-admin.js:337) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes from
// INSIDE the scan closure (its first scanFiles → fs.readdirSync) yet still reaches the
// SAME outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. existsSync
// returns true so scanFiles would clear its existence guard, but on the throwing-cached
// path the closure never runs, so this fs proves the scan never walked the content tree
// (readdirCalls stays 0).
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    existsSync() { return true; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scanFiles(contentDir))
// throws, steering the pass-through-cached path into the outer catch from within the
// closure. existsSync returns true so scanFiles reaches readdirSync rather than
// short-circuiting on its `if (!fs.existsSync(dir)) return` guard.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    existsSync() { return true; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/analytics/duplicates handler over a mocked ctx. The caller
// supplies the two seams used to steer the single try into its catch: `cached` and
// `fs`. Every json(res, status, payload) write is captured in `replies` so a test can
// assert the 500 is the ONLY reply and the success projection never fired, and every
// cached(key, ttl) invocation is recorded so a test can prove the throw originates at
// the one memo call this route reaches.
async function runDuplicates({ cached, fs }) {
  const replies = [];
  const cachedCalls = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
  };
  const pathname = '/api/analytics/duplicates';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/analytics/duplicates outer catch returns 500 Duplicate scan failed', () => {
  it('maps a throw from the cached(analytics:duplicates) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runDuplicates({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Duplicate scan failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('analytics:duplicates', 60000, fn) at analysis-admin.js:337.
    assert.deepStrictEqual(cachedCalls, [['analytics:duplicates', 60000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {duplicates} projection', async () => {
    const { replies } = await runDuplicates({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries the
    // success projection key, so the duplicates list returned at :407 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'duplicates' in r.body), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runDuplicates({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scanFiles(contentDir) hits
    // the throwing readdirSync; the throw escapes the closure (the try/catch sits
    // OUTSIDE cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['analytics:duplicates', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'duplicates' in r.body), false);
  });
});
