import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module via createRequire the way
// the sibling cached-first route suites do (mirroring next-clusters-500, which
// pins the neighbouring GET /api/content-clusters 500 in this same module), so
// this characterization test drives the genuine GET /api/report/knowledge-base
// handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole knowledge-base report scan runs
// inside one try (handler at study-knowledge.js:940, try opens at :941). The
// try's first failable step is the memoized scan call
// `cached('kb-report', 60000, fn)` at :948; any throw from that call, or from
// inside the fn closure it wraps, lands in the catch at :992 through :994, which
// returns `json(res, 500, {error: 'Report generation failed'})`. The success 200
// projection `{...report, generatedAt}`, where `report = {overview, sections,
// topTags}`, returned at :991 is then never emitted.
//
// The report is pure file-tree accounting: content files are counted and grouped
// by directory and by front-matter tag, with no embedding, vector, or semantic
// retrieval, so this ADD-ONLY test is fully constraint-compliant. No sibling
// suite pins this handler's 500, so the golden is net-new.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape the
// json() stub below records.
const GOLDEN_500 = { status: 500, body: { error: 'Report generation failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer
// itself: the scan closure is never invoked, so the throw at the
// cached('kb-report', …) call (study-knowledge.js:948) lands directly in the
// outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the
// way the live memo does on a cold key. Paired with a throwing fs so the failure
// comes from INSIDE the scan closure (its first scan call's fs.readdirSync) yet
// still reaches the SAME outer catch, proving the 500 is independent of where in
// the try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. On the
// throwing-cached path the closure never runs, so this fs proves the scan never
// walked the content tree (readdirCalls stays 0). scan() calls readdirSync
// directly (no existsSync guard), so only the two methods the closure could reach
// are implemented.
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scan(contentDir))
// throws, steering the pass-through-cached path into the outer catch from within
// the closure. The readdirSync call sits in the for…of loop header at
// study-knowledge.js:955, OUTSIDE the per-file inner try/catch (:961 through :974,
// which wraps only readFileSync and front-matter parsing) and OUTSIDE the
// references.yaml inner try/catch (:979 through :982), so the throw escapes scan
// and the closure and lands in the SAME outer catch.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/report/knowledge-base handler over a mocked ctx. The
// caller supplies the two seams used to steer the single try into its catch:
// `cached` and `fs`. Every json(res, status, payload) write is captured in
// `replies` so a test can assert the 500 is the ONLY reply and the success
// projection never fired, and every cached(key, ttl) invocation is recorded so a
// test can prove the throw originates at the one memo call this route reaches.
async function runReport({ cached, fs }) {
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
  const pathname = '/api/report/knowledge-base';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/report/knowledge-base outer catch returns 500 Report generation failed', () => {
  it('maps a throw from the cached(kb-report) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runReport({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status
    // and the exact {error: 'Report generation failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this
    // route: cached('kb-report', 60000, fn) at study-knowledge.js:948.
    assert.deepStrictEqual(cachedCalls, [['kb-report', 60000]]);

    // cached threw before invoking the closure, so the content tree was never
    // walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {overview, sections, topTags, generatedAt} projection', async () => {
    const { replies } = await runReport({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty
    // replies array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any
    // success-projection key, so the {overview, sections, topTags, generatedAt}
    // response built at :991 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'overview' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'sections' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'topTags' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'generatedAt' in r.body), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runReport({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scan(contentDir) hits
    // the throwing readdirSync; the throw escapes the closure (the per-file and
    // references.yaml try/catches sit OUTSIDE this loop header) and lands in the
    // SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['kb-report', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'overview' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'sections' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'topTags' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'generatedAt' in r.body), false);
  });
});
