import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load the real module via createRequire the way
// the sibling route suites do (next-healthsummary-500 / next-engagement-error500 /
// next-analytics-export-csv), so this characterization test drives the genuine
// GET /api/references/analytics handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole bibliography fold runs inside one
// try (the handler block lives around content-analysis-b.js:93). The try's first
// failable step is the memoized scan call `cached('bib-analytics', 60000, fn)`; any
// throw from that call, or from inside the fn closure it wraps, lands in the outer
// catch, which returns json(res, 500, {error: 'Analytics failed'}). The success 200
// projection returned just above that catch (totalReferences, avgYear, and the rest
// through yearRange) is then never emitted.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Analytics failed' } };

// Every key in the success 200 projection the handler returns on the happy path.
// The never-reached proof asserts none of these ever appears in a captured reply.
const SUCCESS_KEYS = [
  'totalReferences', 'avgYear', 'medianYear', 'avgAge', 'uniqueAuthors',
  'uniqueVenues', 'topAuthors', 'topVenues', 'typeDistribution', 'yearRange',
];

// A cached() that throws synchronously, modelling a failure of the memo layer
// itself: the analytics closure is never invoked, so the throw at the
// cached('bib-analytics', ttl, fn) call (the first throwable step inside the single
// try) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the
// way the live memo does on a cold key. Paired with a throwing fs so the failure
// comes from INSIDE the analytics closure (its first fs.readFileSync of
// references.yaml) yet still reaches the SAME outer catch, proving the 500 is
// independent of where in the try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readFileSync counts its calls and otherwise returns an empty
// string. Used on the throwing-cached path to prove the analytics closure never ran
// (no references.yaml read).
function recordingFs() {
  let readFileCalls = 0;
  return {
    get readFileCalls() { return readFileCalls; },
    readFileSync() { readFileCalls++; return ''; },
  };
}

// A throwing fs whose first readFileSync (the analytics closure's read of
// bibliography/references.yaml) throws, steering the pass-through-cached path into
// the outer catch from within the closure.
function throwingFs() {
  let readFileCalls = 0;
  return {
    get readFileCalls() { return readFileCalls; },
    readFileSync() { readFileCalls++; throw new Error('references.yaml unreadable'); },
  };
}

// Drive the real GET /api/references/analytics handler over a mocked ctx. The caller
// supplies the two seams used to steer the single try into its catch: `cached` and
// `fs`. Every json(res, status, payload) write is captured in `replies` so a test
// can assert the 500 is the ONLY reply and the success projection never fired, and
// every cached(key, ttl) invocation is recorded so a test can prove the throw
// originates at the one memo call this route reaches.
async function runAnalytics({ cached, fs }) {
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
  const pathname = '/api/references/analytics';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/references/analytics outer catch returns 500 Analytics failed', () => {
  it('maps a throw from the cached(bib-analytics) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runAnalytics({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Analytics failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // the cached('bib-analytics', 60000, fn) call, the first throwable step in the try.
    assert.deepStrictEqual(cachedCalls, [['bib-analytics', 60000]]);

    // cached threw before invoking the closure, so references.yaml was never read.
    assert.equal(fs.readFileCalls, 0, 'the analytics closure never ran (no readFileSync)');
  });

  it('never emits the success 200 projection (totalReferences through yearRange)', async () => {
    const { replies } = await runAnalytics({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any of
    // the success projection keys, so the analytics object on the happy path was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('returns the same 500 when the throw comes from INSIDE the closure (fs.readFileSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runAnalytics({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first read of
    // bibliography/references.yaml hits the throwing readFileSync; the throw escapes
    // the closure (the try/catch sits OUTSIDE cached) and lands in the SAME outer
    // catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['bib-analytics', 60000]]);
    assert.ok(fs.readFileCalls > 0, 'the analytics closure entered and read references.yaml');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });
});
