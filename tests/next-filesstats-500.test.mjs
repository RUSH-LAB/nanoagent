import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load the real module via createRequire the way the sibling route
// suites do (next-clusters-500 / next-duplicates-500), so this characterization test
// drives the genuine GET /api/stats handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole content-stats scan runs inside one try
// (handler at files.js:168, try opens at :169). The try's first failable step is the
// memoized scan call `cached('content-stats', 30000, fn)` at :170; any throw from that
// call, or from inside the fn closure it wraps, lands in the catch at :202 through :204,
// which returns `json(res, 500, {error: 'Stats failed'})` at :203. The success 200
// projection `{totalFiles, totalWords, references, byDirectory}` returned at :201 (with a
// `{cacheControl: 'public, max-age=30'}` opts arg) is then never emitted.
//
// The handler opens its try with NO pre-try guard, and the closure's first directory walk
// `fs.readdirSync(contentDir, {withFileTypes: true})` at files.js:192 sits OUTSIDE any
// inner try/catch, so a throw there propagates to the SAME outer catch. The only inner
// try/catch wraps the references.yaml read at :198 (`try { … } catch {}`), which SWALLOWS
// its error and so could never reach the 500; it is therefore deliberately NOT used as a
// seam here. The scan is pure file counting and whitespace word counting, with no
// embedding, vector, or semantic retrieval, so this ADD-ONLY test is constraint-compliant.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/files.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by the
// json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Stats failed' } };

// The success-projection keys the 200 path would carry (stats = {totalFiles, totalWords,
// references, byDirectory} at files.js:199). None may ever appear in a reply body on a
// failing seam.
const SUCCESS_KEYS = ['totalFiles', 'totalWords', 'references', 'byDirectory'];

// A cached() that throws synchronously, modelling a failure of the memo layer itself: the
// scan closure is never invoked, so the throw at the cached('content-stats', …) call
// (files.js:170) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way the
// live memo does on a cold key. Paired with a throwing fs so the failure comes from INSIDE
// the scan closure (its first directory walk fs.readdirSync(contentDir)) yet still reaches
// the SAME outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. On the
// throwing-cached path the closure never runs, so this fs proves the scan never walked the
// content tree (readdirCalls stays 0). The /api/stats closure calls readdirSync directly
// with NO existsSync guard, so only the two methods it could reach are implemented.
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's top-level
// fs.readdirSync(contentDir, {withFileTypes: true}) at files.js:192) throws, steering the
// pass-through-cached path into the outer catch from within the closure. That readdirSync
// sits in the for…of loop header OUTSIDE the references.yaml inner try/catch, so the throw
// escapes the closure and lands in the SAME outer catch as the cached-throw path above.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/stats handler over a mocked ctx. The caller supplies the two
// seams used to steer the single try into its catch: `cached` and `fs`. Every
// json(res, status, payload, opts) write is captured in `replies` — the optional 4th opts
// arg the 200 path passes (`{cacheControl: 'public, max-age=30'}`) is accepted and ignored,
// recording only {status, body} — so a test can assert the 500 is the ONLY reply and the
// success projection never fired. Every cached(key, ttl) invocation is recorded so a test
// can prove the throw originates at the one memo call this route reaches.
async function runStats({ cached, fs }) {
  const replies = [];
  const cachedCalls = [];
  const ctx = {
    json(_res, status, payload, _opts) { const r = { status, body: payload }; replies.push(r); return r; },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
  };
  const pathname = '/api/stats';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/stats outer catch returns 500 Stats failed', () => {
  it('maps a throw from the cached(content-stats) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runStats({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Stats failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('content-stats', 30000, fn) at files.js:170.
    assert.deepStrictEqual(cachedCalls, [['content-stats', 30000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {totalFiles, totalWords, references, byDirectory} projection', async () => {
    const { replies } = await runStats({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies array:
    // the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any of the
    // success-projection keys, so the {totalFiles, totalWords, references, byDirectory}
    // returned at :201 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    for (const key of SUCCESS_KEYS) {
      assert.equal(replies.some((r) => r.body && key in r.body), false, `no reply body carries "${key}"`);
    }
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runStats({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first fs.readdirSync(contentDir) hits
    // the throwing readdirSync; the throw escapes the closure (the only inner try/catch
    // wraps just the references.yaml read) and lands in the SAME outer catch as the
    // cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['content-stats', 30000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    for (const key of SUCCESS_KEYS) {
      assert.equal(replies.some((r) => r.body && key in r.body), false, `no reply body carries "${key}"`);
    }
  });
});
