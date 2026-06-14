import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-clusters-drop-dead-topwords / next-duplicates-500), so
// this characterization test drives the genuine GET /api/content-clusters handler
// instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole topic-clustering scan runs inside one
// try (handler at study-knowledge.js:225, try opens at :226). The try's first failable
// step is the memoized scan call `cached('content-clusters', 120000, fn)` at :227; any
// throw from that call, or from inside the fn closure it wraps, lands in the catch at
// :267 through :269, which returns `json(res, 500, {error: 'Clustering failed'})`. The
// success 200 projection `{clusters, total}` returned at :266 is then never emitted.
//
// The clustering is pure TAG-string grouping: pages are bucketed by shared front-matter
// tag and the buckets with two or more pages become clusters, with no embedding, vector,
// or semantic retrieval, so this ADD-ONLY test is fully constraint-compliant. The
// existing next-clusters-drop-dead-topwords suite pins only the 200 shape, so this 500
// golden is net-new.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Clustering failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the scan closure is never invoked, so the throw at the cached('content-clusters', …)
// call (study-knowledge.js:227) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes from
// INSIDE the scan closure (its first scanPages → fs.readdirSync) yet still reaches the
// SAME outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. On the
// throwing-cached path the closure never runs, so this fs proves the scan never walked
// the content tree (readdirCalls stays 0). scanPages calls readdirSync directly (no
// existsSync guard), so only the two methods the closure reaches are implemented.
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scanPages(contentDir))
// throws, steering the pass-through-cached path into the outer catch from within the
// closure. The readdirSync call sits in the for…of loop header OUTSIDE the per-file
// inner try/catch (which wraps only readFileSync and front-matter parsing), so the throw
// escapes scanPages and the closure and lands in the SAME outer catch.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/content-clusters handler over a mocked ctx. The caller
// supplies the two seams used to steer the single try into its catch: `cached` and
// `fs`. Every json(res, status, payload) write is captured in `replies` so a test can
// assert the 500 is the ONLY reply and the success projection never fired, and every
// cached(key, ttl) invocation is recorded so a test can prove the throw originates at
// the one memo call this route reaches.
async function runClusters({ cached, fs }) {
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
  const pathname = '/api/content-clusters';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/content-clusters outer catch returns 500 Clustering failed', () => {
  it('maps a throw from the cached(content-clusters) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runClusters({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Clustering failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('content-clusters', 120000, fn) at study-knowledge.js:227.
    assert.deepStrictEqual(cachedCalls, [['content-clusters', 120000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {clusters, total} projection', async () => {
    const { replies } = await runClusters({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries either
    // success-projection key, so the {clusters, total} returned at :266 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'clusters' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'total' in r.body), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runClusters({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scanPages(contentDir) hits
    // the throwing readdirSync; the throw escapes the closure (the try/catch sits
    // OUTSIDE cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['content-clusters', 120000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'clusters' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'total' in r.body), false);
  });
});
