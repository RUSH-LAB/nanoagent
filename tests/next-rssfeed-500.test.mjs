import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// server/routes/feeds.js is CommonJS; load the real module via createRequire the way
// the sibling route suites do (next-sitemap-500 / next-dotexport-500), so this
// characterization test drives the genuine GET /api/feed/rss handler instead of a
// reimplementation.
//
// It pins that handler's OUTER CATCH. The whole RSS build runs inside one try (handler
// at feeds.js:185, try opens at :186). No guard sits above the try, so a GET for
// /api/feed/rss enters it directly. The try's first failable step is the memoized walk
// call `cached('feed-items', 60000, fn)` at :187; any throw from that call, or from
// inside the fn closure it wraps (scanFeedItems → its first fs.readdirSync at :20),
// lands in the catch at :208 and returns
// json(res, 500, {error: 'RSS feed generation failed'}) at :209.
//
// The success path is NOT a json envelope: on success the handler streams the document
// via res.writeHead(200, {'Content-Type': 'application/rss+xml; …'}) then res.end(rss)
// (:202 and :207). So the mocked res below carries the streaming seam (writeHead / end /
// writableEnded) alongside a json() stub, and the failure tests prove that streaming
// success path is never taken.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'RSS feed generation failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the walk closure is never invoked, so the throw at the cached('feed-items', …) call
// (feeds.js:187) lands directly in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the way
// the live memo does on a cold key. Paired with a throwing fs so the failure comes from
// INSIDE the walk closure (scanFeedItems → its first scan → fs.readdirSync) yet still
// reaches the SAME outer catch, proving the 500 is independent of where in the try the
// throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// A recording fs whose readdirSync counts its calls and returns an empty listing. Used
// on the throwing-cached path to prove the walk closure never ran (no filesystem read).
// The statSync and readFileSync stubs are present for shape only; they are never reached
// because readdirSync yields no entries.
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; return []; },
    statSync() { return { mtime: { toISOString: () => '1970-01-01T00:00:00.000Z' }, mtimeMs: 0 }; },
    readFileSync() { return ''; },
  };
}

// A throwing fs whose first readdirSync (the walk closure's scan(contentDir)) throws,
// steering the pass-through-cached path into the outer catch from within the closure.
// scanFeedItems reads the directory in the for-of header at feeds.js:20, OUTSIDE the
// inner try/catch that only guards statSync/readFileSync, so this throw propagates.
function throwingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    statSync() { return { mtime: { toISOString: () => '1970-01-01T00:00:00.000Z' }, mtimeMs: 0 }; },
    readFileSync() { return ''; },
  };
}

// Drive the real GET /api/feed/rss handler over a mocked ctx. The caller supplies the
// two seams used to steer the single try into its catch: `cached` and `fs`. The res mock
// carries the streaming seam the success path uses (writeHead / end / writableEnded), so
// every 200 stream attempt is recorded; the json() stub captures every envelope reply in
// `replies`; and every cached(key, ttl) invocation is recorded in `cachedCalls`. Together
// they let a test assert the 500 is the ONLY reply and the streaming success path never
// fired. Fully in process: no network, no server, no real disk.
async function runRssFeed({ cached, fs }) {
  const replies = [];
  const cachedCalls = [];
  const headCalls = [];
  const endCalls = [];
  const res = {
    writableEnded: false,
    writeHead(status, headers) { headCalls.push({ status, headers }); return this; },
    end(payload) { endCalls.push(payload); this.writableEnded = true; return this; },
  };
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); res.writableEnded = true; return r; },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    CORS_ORIGIN: 'https://mochi.test',
  };
  const pathname = '/api/feed/rss';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls, headCalls, endCalls, res };
}

describe('GET /api/feed/rss outer catch returns 500 RSS feed generation failed', () => {
  it('maps a throw from the cached(feed-items) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls, headCalls, endCalls } = await runRssFeed({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'RSS feed generation failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('feed-items', 60000, fn) at feeds.js:187.
    assert.deepStrictEqual(cachedCalls, [['feed-items', 60000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the walk closure never ran (no readdirSync)');

    // The streaming success path was never taken.
    assert.equal(headCalls.length, 0, 'res.writeHead never fired');
    assert.equal(endCalls.length, 0, 'res.end never fired');
  });

  it('never emits the streaming 200 RSS success path (writeHead 200 + res.end) on the cached-throw seam', async () => {
    const { replies, headCalls, endCalls, res } = await runRssFeed({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: res.writeHead was never called with 200, res.end never
    // fired, and no reply carries a 200 status, so the success RSS stream returned at
    // feeds.js:202 and :207 was bypassed entirely.
    assert.equal(headCalls.some((h) => h.status === 200), false, 'res.writeHead never called with 200');
    assert.equal(headCalls.length, 0, 'res.writeHead never fired at all');
    assert.equal(endCalls.length, 0, 'res.end never fired (the success RSS stream never ran)');
    assert.equal(replies.some((r) => r.status === 200), false);

    // The handler did reply: the json() stub ended the response, exactly as the live
    // dispatcher detects a sent reply.
    assert.equal(res.writableEnded, true);
  });

  it('returns the same 500 when the throw comes from INSIDE scanFeedItems (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls, headCalls, endCalls } = await runRssFeed({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first scan(contentDir) hits the
    // throwing readdirSync; the throw escapes the closure (the try/catch sits OUTSIDE
    // cached) and lands in the SAME outer catch as the cached-throw path above.
    assert.deepStrictEqual(cachedCalls, [['feed-items', 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the walk closure entered and read the content dir');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Same never-reached proof on this second seam: no streaming 200 success path.
    assert.equal(headCalls.length, 0, 'res.writeHead never fired');
    assert.equal(endCalls.length, 0, 'res.end never fired');
    assert.equal(replies.some((r) => r.status === 200), false);
  });
});
