import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load the real module via createRequire the way
// the sibling route suites do (next-analytics-export-csv / next-healthsummary-500),
// so this characterization test drives the genuine GET /api/graph/export handler
// rather than a reimplementation.
//
// It pins that handler's OUTER CATCH. A guard ABOVE the try rejects any non-'dot'
// ?format with json(res, 400, {error:'Only DOT format supported'})
// (content-analysis-b.js:135); clearing that guard (no ?format, which defaults to
// 'dot', or an explicit ?format=dot) enters the try at :136. The try's first failable
// step is the memoized DOT build cached('graph-export-dot', 60000, fn) at :141; any
// throw from that call, or from inside the fn closure it wraps (the content scan's
// fs.readdirSync), lands in the catch at :174 and returns
// json(res, 500, {error:'DOT export failed'}) at :175. The success path streams
// instead, res.writeHead(200, …) then res.end(dot) at :172 and :173, so that 200
// download is never emitted on the failure path.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, in the {status, body} shape the json() stub
// records below.
const GOLDEN_500 = { status: 500, body: { error: 'DOT export failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the DOT build closure is never invoked, so the throw at the
// cached('graph-export-dot', …) call (content-analysis-b.js:141) lands directly in the
// outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes from
// INSIDE the scan closure (its first scan() then fs.readdirSync) yet still reaches the
// SAME outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. Used on the
// throwing-cached path to prove the scan closure never ran (no filesystem walk).
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's scan(contentDir)) throws,
// steering the pass-through-cached path into the outer catch from within the closure.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/graph/export handler over a mocked ctx. The caller supplies
// the two seams used to steer the single try into its catch: `cached` and `fs`. Every
// json(res, status, payload) write is captured in `replies`, and the streaming success
// seams are recorded too: res.writeHead pushes into writeHeadCalls, res.end bumps
// endCalls and flips writableEnded. So a test can assert the 500 is the ONLY reply and
// the streamed 200 download never fired. Every cached(key, ttl) invocation is recorded
// so a test can prove the throw originates at the one memo call this route reaches.
// `search` defaults to '' (no ?format), which the handler resolves to 'dot' and so
// clears the pre-try 400 guard; pass '?format=dot' to clear it explicitly.
async function runGraphExport({ cached, fs, search = '' }) {
  const replies = [];
  const cachedCalls = [];
  const res = {
    writableEnded: false,
    writeHeadCalls: [],
    endCalls: 0,
    writeHead(status, headers) { this.writeHeadCalls.push({ status, headers }); return this; },
    end(payload) { this.endCalls++; this.writableEnded = true; return this; },
  };
  const ctx = {
    json(_res, status, payload) {
      const r = { status, body: payload };
      replies.push(r);
      res.writableEnded = true;
      return r;
    },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    CORS_ORIGIN: 'https://mochi.test',
  };
  const pathname = '/api/graph/export';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls, res };
}

describe('GET /api/graph/export outer catch returns 500 DOT export failed', () => {
  it('maps a throw from the cached(graph-export-dot) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls, res } = await runGraphExport({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error:'DOT export failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call this route reaches:
    // cached('graph-export-dot', 60000, fn) at content-analysis-b.js:141.
    assert.deepStrictEqual(cachedCalls, [['graph-export-dot', 60000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');

    // The streamed 200 download never started.
    assert.equal(res.endCalls, 0, 'res.end never fired');
    assert.equal(res.writeHeadCalls.length, 0, 'res.writeHead never wrote a stream head');
  });

  it('never emits the streamed success 200 DOT download (no writeHead 200, no res.end, no 400 guard reply)', async () => {
    const { replies, res } = await runGraphExport({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // res.writeHead was never called with 200 and res.end never fired, so the streaming
    // success projection at content-analysis-b.js:172 and :173 was bypassed.
    assert.equal(res.writeHeadCalls.some((c) => c.status === 200), false, 'writeHead never called with 200');
    assert.equal(res.writeHeadCalls.length, 0);
    assert.equal(res.endCalls, 0, 'res.end never fired');

    // No reply carries a 200 status.
    assert.equal(replies.some((r) => r.status === 200), false);

    // The pre-try 400 guard never fired: format defaulted to 'dot', so the request
    // cleared 'Only DOT format supported' and reached the try.
    assert.equal(replies.some((r) => r.status === 400), false, 'the 400 guard never fired');
    assert.equal(replies.some((r) => r.body && r.body.error === 'Only DOT format supported'), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls, res } = await runGraphExport({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scan(contentDir) hits the
    // throwing readdirSync; the throw escapes the closure (the try/catch sits OUTSIDE
    // cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['graph-export-dot', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Same never-reached success proof on this seam.
    assert.equal(res.writeHeadCalls.some((c) => c.status === 200), false);
    assert.equal(res.endCalls, 0, 'res.end never fired');
    assert.equal(replies.some((r) => r.status === 200), false);
  });

  it('clears the 400 guard with an explicit ?format=dot and still reaches the same 500 outer catch', async () => {
    const { replies, cachedCalls } = await runGraphExport({ cached: throwingCached(), fs: recordingFs(), search: '?format=dot' });

    // An explicit ?format=dot also clears the guard, so the handler reaches the memo
    // call and the throw lands in the same outer catch.
    assert.deepStrictEqual(cachedCalls, [['graph-export-dot', 60000]]);
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 400), false, 'format=dot does not trip the guard');
  });
});
