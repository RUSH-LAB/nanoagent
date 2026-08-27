import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module via createRequire the
// way the sibling cached-first route suites do (next-pagerank-500 in this same
// module, and next-clusters-500), so this characterization test drives the
// genuine GET /api/stats/citations-per-page handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole citation-density scan runs inside
// one try (handler opens at content-analysis-a.js:885, try at :886) with NO
// pre-try guard to clear. The try's first failable step is the memoized scan call
// cached('citations-per-page', 60000, fn) at :895; any throw from that call, or
// from inside the fn closure it wraps, lands in the catch at :920 which returns
// json(res, 500, {error: 'Citation density failed'}). The success 200 projection
// json(res, 200, result) returned at :919, where result = {pages, total,
// avgCitations} (assembled at :917), is then never emitted.
//
// The closure's first failable read is the directory walk
// fs.readdirSync(dir, {withFileTypes: true}) at :899, which sits in the for…of
// loop header OUTSIDE any inner try/catch, so its throw escapes the closure and
// reaches the outer catch. The per-file fs.readFileSync at :905 is the WRONG seam:
// it is wrapped in its own swallowing inner try/catch (:904 through :912), so a
// throw there is caught and the scan simply continues, never reaching the 500; and
// in any case the throwing readdirSync fires first on every directory. The
// injectable throwing seam inside the closure is therefore that ctx.fs.readdirSync.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/stats.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Citation density failed' } };

// Every key the success projection returns, the object {pages, total, avgCitations}
// sent by json(res, 200, ...) at :919. The never-reached proof asserts that none of
// them surfaces in any captured reply.
const SUCCESS_KEYS = ['pages', 'total', 'avgCitations'];

// A cached() that throws synchronously, modelling a failure of the memo layer
// itself: the scan closure is never invoked, so the throw at the
// cached('citations-per-page', …) call (content-analysis-a.js:895) lands directly
// in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the
// way the live memo does on a cold key. Paired with a throwing fs so the failure
// comes from INSIDE the scan closure (its first directory walk fs.readdirSync) yet
// still reaches the SAME outer catch, proving the 500 is independent of where in
// the try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise returns an empty
// listing. On the throwing-cached path the closure never runs, so this fs proves
// the scan never walked the content tree (readdirCalls stays 0). readFileSync is a
// no-op returning '' for completeness; the empty readdir listing means the per-file
// branch is never reached anyway.
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's walk of contentDir)
// throws, steering the pass-through-cached path into the outer catch from within
// the closure. The readdirSync call sits in the for…of loop header OUTSIDE the
// per-file inner try/catch (which wraps only readFileSync and front-matter
// parsing), so the throw escapes scan() and the closure and lands in the SAME outer
// catch as the cached-throw path.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/stats/citations-per-page handler over a mocked ctx. The
// caller supplies the two seams used to steer the single try into its catch:
// `cached` and `fs`. Every json(res, status, payload) write is captured in
// `replies` so a test can assert the 500 is the ONLY reply and the success
// projection never fired, and every cached(key, ttl) invocation is recorded so a
// test can prove the throw originates at the one memo call this route reaches.
async function runCitationsPerPage({ cached, fs }) {
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
  const pathname = '/api/stats/citations-per-page';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/stats/citations-per-page outer catch returns 500 Citation density failed', () => {
  it('maps a throw from the cached(citations-per-page) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runCitationsPerPage({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Citation density failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('citations-per-page', 60000, fn), the first throwable step in the try.
    assert.deepStrictEqual(cachedCalls, [['citations-per-page', 60000]]);

    // cached threw before invoking the closure, so the content tree was never
    // walked (no readdirSync).
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {pages, total, avgCitations} projection', async () => {
    const { replies } = await runCitationsPerPage({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any
    // of the success projection keys, so the {pages, total, avgCitations} object
    // returned at :919 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runCitationsPerPage({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first directory walk hits the
    // throwing readdirSync; the throw escapes the closure (the try/catch sits
    // OUTSIDE cached) and lands in the SAME outer catch as the cached-throw path
    // above.
    assert.deepStrictEqual(cachedCalls, [['citations-per-page', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });
});
