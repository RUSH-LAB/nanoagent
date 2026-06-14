import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-healthsummary-500 / next-engagement-error500 /
// next-analytics-export-csv), so this characterization test drives the genuine
// GET /api/content-health handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole content-tree health scan and the
// success projection run inside one try (handler opens at misc-tools.js:371, try
// at :372). The try's first failable step is the memoized scan call
// `cached('content-health', 60000, fn)` (around misc-tools.js:373); any throw from
// that call, or from inside the fn closure it wraps, lands in the catch (around
// misc-tools.js:457) which returns
// `json(res, 500, {error: 'Content health check failed'})` (around :458). The
// success 200 projection returned by `json(res, 200, health)` at :456 is then
// never emitted.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/misc-tools.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Content health check failed' } };

// Every key the success projection returns (around misc-tools.js:446-454). The
// never-reached proof asserts that none of them surfaces in any captured reply.
const SUCCESS_KEYS = [
  'totalPages',
  'draftCount',
  'brokenLinks',
  'brokenLinkCount',
  'orphanPages',
  'orphanPageCount',
  'totalLinks',
];

// A cached() that throws synchronously, modelling a failure of the memo layer
// itself: the scan closure is never invoked, so the throw at the
// cached('content-health', …) call (around misc-tools.js:373) lands directly in the
// outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the
// way the live memo does on a cold key. Paired with a throwing fs so the failure
// comes from INSIDE the scan closure (its first scanHealth → fs.readdirSync) yet
// still reaches the SAME outer catch, proving the 500 is independent of where in
// the try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. Used on
// the throwing-cached path to prove the scan closure never ran (no filesystem
// walk).
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scanHealth(contentDir))
// throws, steering the pass-through-cached path into the outer catch from within
// the closure.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/content-health handler over a mocked ctx. The caller
// supplies the two seams used to steer the single try into its catch: `cached` and
// `fs`. Every json(res, status, payload) write is captured in `replies` so a test
// can assert the 500 is the ONLY reply and the success projection never fired, and
// every cached(key, ttl) invocation is recorded so a test can prove the throw
// originates at the one memo call this route reaches.
async function runContentHealth({ cached, fs }) {
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
  const pathname = '/api/content-health';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/content-health outer catch returns 500 Content health check failed', () => {
  it('maps a throw from the cached(content-health) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runContentHealth({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Content health check failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('content-health', 60000, fn) (around misc-tools.js:373).
    assert.deepStrictEqual(cachedCalls, [['content-health', 60000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 content-health projection', async () => {
    const { replies } = await runContentHealth({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any of
    // the success projection keys, so the projection returned at :456 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runContentHealth({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scanHealth(contentDir)
    // hits the throwing readdirSync; the throw escapes the closure (the try/catch
    // sits OUTSIDE cached) and lands in the SAME outer catch as the cached-throw
    // path above.
    assert.deepStrictEqual(cachedCalls, [['content-health', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
  });
});
