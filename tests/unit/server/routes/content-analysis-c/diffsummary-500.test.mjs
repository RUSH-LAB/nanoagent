import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-diffsummary-cache / next-duplicates-500), so this
// characterization test drives the genuine GET /api/content-diff-summary handler
// instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. After the lone pre-try guard
// `if (!from) return json(res, 400, ...)` (content-analysis-c.js:316), the whole
// date-range scan runs inside one try (opens at :317). The try's first failable step is
// the memoized walk call `cached('diffsummary:' + from + ':' + to, 30000, fn)` at :328;
// any throw from that call, or from inside the fn closure it wraps (its first
// scan -> fs.readdirSync at :334), lands in the catch at :365 through :367, which
// returns `json(res, 500, {error: 'Diff summary failed'})` at :366. The success 200
// projection `{from, to, created, modified, total, createdFiles, modifiedFiles}`
// returned at :357 is then never emitted.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// A truthy `from` plus an EXPLICIT `to` clear the only pre-try guard and make the cache
// key clock independent: with these the handler builds key
// `diffsummary:2026-03-01:2026-03-02` rather than defaulting `to` to today's date via
// `new Date().toISOString().slice(0, 10)`. So the recorded (key, ttl) below is stable
// no matter when this suite runs.
const FROM = '2026-03-01';
const TO = '2026-03-02';
const CACHE_KEY = `diffsummary:${FROM}:${TO}`;
const CACHE_TTL = 30000;

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Diff summary failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the scan closure is never invoked, so the throw at the
// cached('diffsummary:...', 30000, fn) call (content-analysis-c.js:328) lands directly
// in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes from
// INSIDE the scan closure (its first scan -> fs.readdirSync) yet still reaches the SAME
// outer catch, proving the 500 is independent of where in the try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. On the
// throwing-cached path the closure never runs, so this fs proves the scan never walked
// the content tree (readdirCalls stays 0).
function recordingFs() {
  let readdirCalls = 0;
  let statCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get statCalls() { return statCalls; },
    readdirSync() { readdirCalls++; return []; },
    statSync() { statCalls++; return { mtime: new Date(0), birthtime: new Date(0) }; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scan(contentDir)) throws,
// steering the pass-through-cached path into the outer catch from within the closure.
// statSync is a defensive throw that must stay unreached: readdirSync throws before any
// entry is iterated, so statSync is never called. The distinction matters because the
// scan wraps each statSync in its OWN inner try/catch (content-analysis-c.js:339
// through :351), which would swallow a statSync throw; only the un-wrapped readdirSync
// can drive the OUTER catch.
function throwingReaddirFs() {
  let readdirCalls = 0;
  let statCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get statCalls() { return statCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    statSync() { statCalls++; throw new Error('statSync should not be reached: readdirSync throws first'); },
  };
}

// Does this reply carry a key unique to the success 200 projection
// ({from, to, created, modified, total, createdFiles, modifiedFiles})? The 500 body is
// only {error}, so any of these keys appearing would mean the success path leaked.
function carriesSuccessProjection(reply) {
  if (!reply.body) return false;
  return ['createdFiles', 'modifiedFiles', 'total', 'created', 'modified'].some((k) => k in reply.body);
}

// Drive the real GET /api/content-diff-summary handler over a mocked ctx. The caller
// supplies the two seams used to steer the single try into its catch: `cached` and
// `fs`. Every json(res, status, payload) write is captured in `replies` so a test can
// assert the 500 is the ONLY reply and the success projection never fired, and every
// cached(key, ttl) invocation is recorded so a test can prove the throw originates at
// the one memo call this route reaches, keyed by the explicit from/to.
async function runDiffSummary({ cached, fs }) {
  const replies = [];
  const cachedCalls = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
  };
  const pathname = '/api/content-diff-summary';
  const url = new URL(`http://localhost${pathname}?from=${FROM}&to=${TO}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/content-diff-summary outer catch returns 500 Diff summary failed', () => {
  it('maps a throw from the cached(diffsummary:...) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runDiffSummary({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Diff summary failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route, with
    // the clock-independent key built from the explicit from/to and the 30s TTL.
    assert.deepStrictEqual(cachedCalls, [[CACHE_KEY, CACHE_TTL]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
    assert.equal(fs.statCalls, 0, 'the scan closure never ran (no statSync)');
  });

  it('never emits the success 200 {from, to, created, modified, total, createdFiles, modifiedFiles} projection', async () => {
    const { replies } = await runDiffSummary({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any key
    // unique to the success projection, so the {from, to, created, ...} object returned
    // at :357 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some(carriesSuccessProjection), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingReaddirFs();
    const { replies, cachedCalls } = await runDiffSummary({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scan(contentDir) hits the
    // throwing readdirSync; the throw escapes the closure (the try/catch sits OUTSIDE
    // cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [[CACHE_KEY, CACHE_TTL]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    // readdirSync throws before any entry is iterated, so the inner-try statSync (which
    // would be swallowed, not surfaced) is never reached: the OUTER catch is driven by
    // the un-wrapped readdirSync alone.
    assert.equal(fs.statCalls, 0, 'statSync is never reached (readdirSync throws first)');

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some(carriesSuccessProjection), false);
  });
});
