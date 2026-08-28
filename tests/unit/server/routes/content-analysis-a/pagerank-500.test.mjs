import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module via createRequire the
// way the sibling route suites do (next-pagerank-aj / next-pagerank-rowkey /
// next-content-a-cache-refs), so this characterization test drives the genuine
// GET /api/references/pagerank handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole PageRank build runs inside one
// try (handler opens around content-analysis-a.js:1154, try at :1155). The try's
// first failable step is the memoized build call cached('ref-pagerank', 120000,
// fn) at :1156; any throw from that call, or from inside the fn closure it wraps,
// lands in the catch around :1237 which returns
// json(res, 500, {error: 'PageRank failed'}) at :1238. The success 200 projection
// json(res, 200, {rankings, total}) returned at :1236 is then never emitted.
//
// The closure's first failable read is fs.readFileSync of
// bibliography/references.yaml at :1158. js-yaml is a real installed dependency,
// so the require('js-yaml') just above that read resolves; the injectable
// throwing seam is therefore that ctx.fs.readFileSync read, NOT the swallowing
// loadReferencesCached helper (which this pagerank handler does not call, so a
// {}-on-broken-yaml loader could never turn the 500 into a 200).
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape
// used by the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'PageRank failed' } };

// Every key the success projection returns, the object {rankings, total} sent by
// json(res, 200, ...) at :1236. The never-reached proof asserts that none of them
// surfaces in any captured reply.
const SUCCESS_KEYS = ['rankings', 'total'];

// A cached() that throws synchronously, modelling a failure of the memo layer
// itself: the build closure is never invoked, so the throw at the
// cached('ref-pagerank', ...) call (content-analysis-a.js:1156) lands directly in
// the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the
// way the live memo does on a cold key. Paired with a throwing fs so the failure
// comes from INSIDE the build closure (its first read of
// bibliography/references.yaml via fs.readFileSync) yet still reaches the SAME
// outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readFileSync counts its calls and otherwise returns an
// empty string. Used on the throwing-cached path to prove the build closure never
// ran (no references.yaml read).
function recordingFs() {
  let readFileCalls = 0;
  return {
    get readFileCalls() { return readFileCalls; },
    readFileSync() { readFileCalls++; return ''; },
  };
}

// A throwing fs whose first readFileSync (the build closure's read of
// bibliography/references.yaml) throws, steering the pass-through-cached path into
// the outer catch from within the closure, before readdirSync ever walks the
// content tree.
function throwingFs() {
  let readFileCalls = 0;
  return {
    get readFileCalls() { return readFileCalls; },
    readFileSync() { readFileCalls++; throw new Error('references.yaml unreadable'); },
  };
}

// Drive the real GET /api/references/pagerank handler over a mocked ctx. The
// caller supplies the two seams used to steer the single try into its catch:
// `cached` and `fs`. Every json(res, status, payload) write is captured in
// `replies` so a test can assert the 500 is the ONLY reply and the success
// projection never fired, and every cached(key, ttl) invocation is recorded so a
// test can prove the throw originates at the one memo call this route reaches.
async function runPageRank({ cached, fs }) {
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
  const pathname = '/api/references/pagerank';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/references/pagerank outer catch returns 500 PageRank failed', () => {
  it('maps a throw from the cached(ref-pagerank) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runPageRank({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status
    // and the exact {error: 'PageRank failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this
    // route: cached('ref-pagerank', 120000, fn), the first throwable step in the
    // try.
    assert.deepStrictEqual(cachedCalls, [['ref-pagerank', 120000]]);

    // cached threw before invoking the closure, so references.yaml was never read.
    assert.equal(fs.readFileCalls, 0, 'the build closure never ran (no readFileSync)');
  });

  it('never emits the success 200 {rankings, total} projection', async () => {
    const { replies } = await runPageRank({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty
    // replies array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any
    // of the success projection keys, so the {rankings, total} object returned at
    // :1236 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('returns the same 500 when the throw comes from INSIDE the closure (fs.readFileSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runPageRank({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first read of
    // bibliography/references.yaml hits the throwing readFileSync; the throw
    // escapes the closure (the try/catch sits OUTSIDE cached) and lands in the
    // SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['ref-pagerank', 120000]]);
    assert.ok(fs.readFileCalls > 0, 'the build closure entered and read references.yaml');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });
});
