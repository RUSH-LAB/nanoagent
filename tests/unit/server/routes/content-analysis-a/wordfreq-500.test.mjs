import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module via createRequire the way
// the sibling route suites do (next-healthsummary-500 / next-wordfreq-cache /
// next-content-a-statscompare-cache), so this characterization test drives the
// genuine GET /api/stats/word-frequency handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The handler sits at content-analysis-a.js:677.
// An isValidDir 400 guard runs ABOVE the try (:679), so a valid `dir` is required to
// enter the try (:680). The try's first failable step is the memoized scan call
// cached('word-frequency:' + dir, 60000, fn) at :691. Any throw from that call, or
// from inside the fn closure it wraps, lands in the catch at :713 and :714, which
// returns json(res, 500, {error: 'Word frequency failed'}). The success 200 projection
// {directory, words, totalUniqueWords} returned at :712 is then never emitted.
//
// The request carries ?dir=content because the real server-utils isValidDir accepts
// 'content' (isValidDir at server-utils.js:50, where normalized === 'content' holds),
// so the cache key the route builds is 'word-frequency:content'.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Word frequency failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the scan closure is never invoked, so the throw at the
// cached('word-frequency:content', ...) call (content-analysis-a.js:691) lands
// directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes
// from INSIDE the scan closure (its first scan(fullDir) walk hits fs.readdirSync) yet
// still reaches the SAME outer catch, proving the 500 is independent of where in the
// try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. Used on the
// throwing-cached path to prove the scan closure never ran (no directory walk).
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scan(fullDir) walk) throws,
// steering the pass-through-cached path into the outer catch from within the closure.
// readFileSync is deliberately left benign: the handler wraps every readFileSync in an
// inner try/catch (content-analysis-a.js:700 through :704) that swallows per-file read
// errors, so a readFileSync throw would NOT reach the outer catch. The readdirSync walk
// at :695 is the step that escapes the closure, so that is the one made to throw here.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/stats/word-frequency handler over a mocked ctx. The caller
// supplies the two seams used to steer the single try into its catch: `cached` and
// `fs`. isValidDir is stubbed to accept the request's dir (mirroring the real
// server-utils isValidDir, which returns true for 'content'), so the 400 guard above
// the try passes and execution enters the try. Every json(res, status, payload) write
// is captured in `replies` so a test can assert the 500 is the ONLY reply and the
// success projection never fired, and every cached(key, ttl) invocation is recorded so
// a test can prove the throw originates at the one memo call this route reaches.
async function runWordFrequency({ cached, fs }) {
  const replies = [];
  const cachedCalls = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    isValidDir: () => true,
    fs,
    path,
    // PROJECT_ROOT and ALLOWED_EXTS complete the ctx shape the scan closure reads. Its
    // value is never asserted, but it stays load-bearing on the pass-through-cached
    // seam: the closure runs path.join(PROJECT_ROOT, dir) before the throwing
    // readdirSync, so PROJECT_ROOT must be a real string for the throw to originate at
    // the directory walk rather than at path.join.
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
  };
  const pathname = '/api/stats/word-frequency';
  const url = new URL(`http://localhost${pathname}?dir=content`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/stats/word-frequency outer catch returns 500 Word frequency failed', () => {
  it('maps a throw from the cached(word-frequency:content) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runWordFrequency({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Word frequency failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('word-frequency:content', 60000, fn) at content-analysis-a.js:691.
    assert.deepStrictEqual(cachedCalls, [['word-frequency:content', 60000]]);

    // cached threw before invoking the closure, so the directory was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {directory, words, totalUniqueWords} projection', async () => {
    const { replies } = await runWordFrequency({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any of
    // the success projection keys, so the frequency table returned at :712 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && ('directory' in r.body || 'words' in r.body || 'totalUniqueWords' in r.body)),
      false,
    );
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runWordFrequency({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scan(fullDir) hits the
    // throwing readdirSync; the throw escapes the closure (the try/catch sits OUTSIDE
    // cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['word-frequency:content', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the directory');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
  });
});
