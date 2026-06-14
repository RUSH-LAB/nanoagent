import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-duplicates-500 / next-orphans-500), so this
// characterization test drives the genuine GET /api/files/recent handler instead of a
// reimplementation.
//
// It pins that handler's OUTER CATCH. The whole recent-files scan runs inside one try
// (handler at analysis-admin.js:209, try opens at :210). The try's first failable step
// is the memoized scan call
// `cached('files-recent:' + (includeStats ? 'stats' : 'plain'), 30000, fn)` at :229; a
// bare GET (no ?includeStats) keys it 'files-recent:plain'. Any throw from that call, or
// from inside the fn closure it wraps (walkRecent → fs.readdirSync), lands in the catch
// at :264 through :266, which returns `json(res, 500, {error: 'Failed to list recent
// files'})`. The success 200 projection `{files}` returned at :263 is then never emitted.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Failed to list recent files' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the scan closure is never invoked, so the throw at the cached('files-recent:plain', …)
// call (analysis-admin.js:229) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes from
// INSIDE the scan closure (its first walkRecent → fs.readdirSync) yet still reaches the
// SAME outer catch, proving the 500 is independent of where in the try the throw
// originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and otherwise no-ops. On the
// throwing-cached path the closure never runs, so this fs proves the scan never walked
// the content tree (readdirCalls stays 0). statSync/readFileSync are present only so a
// closure that did run would not crash for an unrelated reason.
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    statSync() { return { mtimeMs: 0 }; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the scan closure's walkRecent(contentDir))
// throws, steering the pass-through-cached path into the outer catch from within the
// closure. walkRecent has no existsSync guard, so its very first readdirSync throws.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    statSync() { return { mtimeMs: 0 }; },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/files/recent handler over a mocked ctx. The caller supplies
// the two seams used to steer the single try into its catch: `cached` and `fs`. Every
// json(res, status, payload) write is captured in `replies` so a test can assert the
// 500 is the ONLY reply and the success projection never fired, and every cached(key,
// ttl) invocation is recorded so a test can prove the throw originates at the one memo
// call this route reaches.
async function runRecent({ cached, fs }) {
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
  const pathname = '/api/files/recent';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

describe('GET /api/files/recent outer catch returns 500 Failed to list recent files', () => {
  it('maps a throw from the cached(files-recent:plain) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runRecent({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Failed to list recent files'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for a bare GET:
    // cached('files-recent:plain', 30000, fn) at analysis-admin.js:229.
    assert.deepStrictEqual(cachedCalls, [['files-recent:plain', 30000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('never emits the success 200 {files} projection', async () => {
    const { replies } = await runRecent({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries the
    // success projection key, so the files list returned at :263 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'files' in r.body), false);
  });

  it('returns the same 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls } = await runRecent({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first walkRecent(contentDir) hits
    // the throwing readdirSync; the throw escapes the closure (the try/catch sits
    // OUTSIDE cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['files-recent:plain', 30000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && 'files' in r.body), false);
  });
});
