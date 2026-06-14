import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the real module via createRequire the way the
// sibling cached-first route suites do (next-clusters-500 / next-duplicates-500), so this
// characterization test drives the genuine GET /api/graph handler instead of a
// reimplementation.
//
// It pins that handler's OUTER CATCH. The whole wiki-link graph scan runs inside one try
// (handler at graph-trash-files.js:82, try opens at :83). The try's first failable step is
// the memoized scan call `cached('graph-data', 60000, fn)` at :87; any throw from that
// call, or from inside the fn closure it wraps, lands in the catch at :165, whose return
// `json(res, 500, {error: 'Graph generation failed: ' + err.message})` at :166 emits the
// reply. That
// is an err.message-PREFIX golden: the fixed prefix 'Graph generation failed: ' joined to
// the caught error's .message, so each seam below throws an Error with a KNOWN message and
// asserts the EXACT composed string. The success 200 projection `{nodes, edges}` returned
// at :164 is then never emitted.
//
// The graph is pure wiki-link ([[target]]) edge resolution over the content tree, with no
// embedding, vector, or semantic retrieval, so this ADD-ONLY test is fully
// constraint-compliant. It pins a net-new 500 golden for this route.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/virtual-root';

// The two exact replies the outer catch composes, captured in the {status, body} shape
// used by the json() stub below. The body is the fixed 'Graph generation failed: ' prefix
// plus the caught error's .message, so the two seams differ only in that message suffix.
const GOLDEN_500_CACHE = { status: 500, body: { error: 'Graph generation failed: cache layer unavailable' } };
const GOLDEN_500_FS = { status: 500, body: { error: 'Graph generation failed: content dir unreadable' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself: the
// scan closure is never invoked, so the throw at the cached('graph-data', …) call
// (graph-trash-files.js:87) lands directly in the outer catch carrying the message
// 'cache layer unavailable'.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way the
// live memo does on a cold key. Paired with a throwing fs so the failure comes from INSIDE
// the scan closure (its first collectGraphFiles → fs.readdirSync) yet still reaches the
// SAME outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. collectGraphFiles
// calls readdirSync directly with no existsSync guard, so only the two methods the closure
// reaches are implemented. On the throwing-cached path the closure never runs, so this fs
// proves the scan never walked the content tree (readdirCalls stays 0).
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's collectGraphFiles(contentDir))
// throws, steering the pass-through-cached path into the outer catch from within the
// closure. The readdirSync call sits in the for…of loop header at graph-trash-files.js:95,
// OUTSIDE any inner try/catch (collectGraphFiles has none), so the throw escapes the
// closure and lands in the SAME outer catch as the cached-throw path, carrying the message
// 'content dir unreadable'.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/graph handler over a mocked ctx. The caller supplies the two
// seams used to steer the single try into its catch: `cached` and `fs`. Every json(res,
// status, payload) write is captured in `replies` so a test can assert the 500 is the ONLY
// reply and the success projection never fired, and every cached(key, ttl) invocation is
// recorded so a test can prove the throw originates at the one memo call this route reaches.
async function runGraph({ cached, fs }) {
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
  const pathname = '/api/graph';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/graph outer catch returns 500 "Graph generation failed: <err.message>"', () => {
  it('maps a throw from the cached(graph-data) memo call straight into the 500 reply, composing the prefix with err.message', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runGraph({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact 'Graph generation failed: cache layer unavailable' composed body.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500_CACHE);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('graph-data', 60000, fn) at graph-trash-files.js:87.
    assert.deepStrictEqual(cachedCalls, [['graph-data', 60000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {nodes, edges} projection on the cached-throw seam', async () => {
    const { replies } = await runGraph({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500_CACHE);

    // The never-reached proof: no reply carries a 200 status, and none carries either
    // success-projection key, so the {nodes, edges} returned at :164 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'nodes' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'edges' in r.body), false);
  });

  it('returns the same 500 (now carrying the fs error message) when the throw comes from INSIDE the scan closure via fs.readdirSync, with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runGraph({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first collectGraphFiles(contentDir)
    // hits the throwing readdirSync; the throw escapes the closure (the try/catch sits
    // OUTSIDE cached) and lands in the SAME outer catch as the cached-throw path above,
    // now composing the prefix with 'content dir unreadable'.
    assert.deepStrictEqual(cachedCalls, [['graph-data', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500_FS);

    // Same never-reached proof on this seam: no 200, no nodes/edges projection.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'nodes' in r.body), false);
    assert.equal(replies.some((r) => r.body && 'edges' in r.body), false);
  });
});
