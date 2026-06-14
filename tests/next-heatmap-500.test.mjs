import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the real module via createRequire the way the sibling route
// suites do (next-clusters-500 / next-duplicates-500), so this characterization test
// drives the genuine GET /api/activity-heatmap handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole heatmap scan runs inside one try (handler
// at feeds.js:386, try opens at :387). The try first reads an optional ?days via
// numericParam(url.searchParams.get('days'), 365, 365) at :388 (omitted here, so it
// defaults to 365 with no 4xx guard to clear), then its first failable step is the
// memoized scan call cached('activity-heatmap', 60000, fn) at :389; any throw from that
// call, or from inside the fn closure it wraps, lands in the catch at :426 through :428,
// which returns json(res, 500, {error: 'Heatmap failed'}) at :427. The success 200
// projection {days: filtered, totalDays} returned at :425 is then never emitted.
//
// The scan is pure file-mtime plus comment-timestamp counting (no embedding, vector, or
// semantic retrieval), so this ADD-ONLY test is fully constraint-compliant.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by the
// json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Heatmap failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself: the
// scan closure is never invoked, so the throw at the cached('activity-heatmap', …) call
// (feeds.js:389) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way the
// live memo does on a cold key. Paired with a throwing fs so the failure comes from INSIDE
// the scan closure (its first scanActivity → fs.readdirSync) yet still reaches the SAME
// outer catch, proving the 500 is independent of where in the try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync/statSync count their calls and otherwise no-op. On the
// throwing-cached path the closure never runs, so this fs proves the scan never walked the
// content tree (readdirCalls stays 0). scanActivity calls readdirSync directly (no
// existsSync guard); statSync is the per-file call wrapped in the closure's swallowing
// inner try/catch, included here only for ctx faithfulness.
function recordingFs() {
  let readdirCalls = 0;
  let statCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get statCalls() { return statCalls; },
    readdirSync() { readdirCalls++; return []; },
    statSync() { statCalls++; return { mtime: new Date(0) }; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scanActivity(contentDir))
// throws, steering the pass-through-cached path into the outer catch from within the
// closure. That readdirSync(dir, {withFileTypes:true}) sits in the for…of loop header
// OUTSIDE the per-file inner try/catch (feeds.js:398 through :402, which wraps only
// statSync), so the throw escapes scanActivity and the closure and lands in the SAME outer
// catch. It fires before any statSync and before the loadJSON(COMMENTS_FILE) read at
// feeds.js:407.
function throwingFs() {
  let readdirCalls = 0;
  let statCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get statCalls() { return statCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    statSync() { statCalls++; return { mtime: new Date(0) }; },
  };
}

// Drive the real GET /api/activity-heatmap handler over a mocked ctx. The caller supplies
// the two seams used to steer the single try into its catch: `cached` and `fs`. Every
// json(res, status, payload) write is captured in `replies` so a test can assert the 500
// is the ONLY reply and the success projection never fired; every cached(key, ttl)
// invocation is recorded so a test can prove the throw originates at the one memo call
// this route reaches; loadJSON calls are counted to prove the comment read at feeds.js:407
// is never reached on the 500 seams.
async function runHeatmap({ cached, fs }) {
  const replies = [];
  const cachedCalls = [];
  let loadJSONCalls = 0;
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    // loadJSON(COMMENTS_FILE) is read inside the memo closure at feeds.js:407, AFTER the
    // scanActivity walk; both 500 seams trip before that line, so this stays at 0 calls.
    loadJSON() { loadJSONCalls++; return {}; },
    COMMENTS_FILE: path.join(PROJECT_ROOT, 'data', 'comments.json'),
    // feeds.js imports numericParam at module load (server-utils), so this ctx copy is
    // never read; it is supplied only to mirror the handler's full ctx faithfully.
    numericParam: (_raw, def) => def,
  };
  const pathname = '/api/activity-heatmap';
  // No ?days, so the module-level numericParam(null, 365, 365) defaults to 365 and there
  // is no 4xx guard to clear before the try opens.
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls, loadJSONCalls };
}

describe('GET /api/activity-heatmap outer catch returns 500 Heatmap failed', () => {
  it('maps a throw from the cached(activity-heatmap) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls, loadJSONCalls } = await runHeatmap({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Heatmap failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('activity-heatmap', 60000, fn) at feeds.js:389.
    assert.deepStrictEqual(cachedCalls, [['activity-heatmap', 60000]]);

    // cached threw before invoking the closure, so the content tree was never walked and
    // the comment file was never read.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
    assert.equal(fs.statCalls, 0, 'the scan closure never ran (no statSync)');
    assert.equal(loadJSONCalls, 0, 'the scan closure never ran (no loadJSON)');
  });

  it('never emits the success 200 {days, totalDays} projection', async () => {
    const { replies } = await runHeatmap({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries either
    // success-projection key, so the {days, totalDays} returned at :425 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'days' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'totalDays' in r.body), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls, loadJSONCalls } = await runHeatmap({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scanActivity(contentDir) hits
    // the throwing readdirSync; the throw escapes the closure (the per-file try/catch wraps
    // only statSync, inside the loop) and lands in the SAME outer catch as the cached-throw
    // path above.
    assert.deepStrictEqual(cachedCalls, [['activity-heatmap', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');

    // readdirSync threw at the first directory walk, before any per-file statSync and
    // before the loadJSON(COMMENTS_FILE) read at feeds.js:407.
    assert.equal(fs.statCalls, 0, 'readdirSync threw before any statSync');
    assert.equal(loadJSONCalls, 0, 'readdirSync threw before the comment-file read');

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'days' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'totalDays' in r.body), false);
  });
});
