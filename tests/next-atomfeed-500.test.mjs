import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// server/routes/feeds.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-rssfeed-500 is the RSS twin this mirrors; next-sitemap-500
// / next-dotexport-500 follow the same shape), so this characterization test drives the
// genuine GET /api/feed/atom handler instead of a reimplementation. The Atom handler is the
// STREAMING twin of the RSS handler, so this file mirrors tests/next-rssfeed-500.test.mjs,
// changing the pathname, the content-type, and the golden error string, with the feeds.js
// line citations re-pointed to the Atom handler.
//
// It pins that handler's OUTER CATCH. The whole Atom build runs inside one try (handler
// at feeds.js:358, try opens at :359). No guard sits above the try, so a GET for
// /api/feed/atom enters it directly. The try's first failable step is the memoized walk
// call `cached('feed-items', 60000, fn)` at :360; any throw from that call, or from
// inside the fn closure it wraps (scanFeedItems → its first fs.readdirSync at :20),
// lands in the catch at :380 and returns
// json(res, 500, {error: 'Atom feed generation failed'}) at :381.
//
// The success path is NOT a json envelope: on success the handler streams the document
// via res.writeHead(200, {'Content-Type': 'application/atom+xml; …'}) then res.end(atom)
// (:374 and :379). So the mocked res below carries the streaming seam (writeHead / end /
// writableEnded) alongside a json() stub, and the failure tests prove that streaming
// success path is never taken.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Atom feed generation failed' } };

// A cached() that throws synchronously, modelling a failure of the memo layer itself:
// the walk closure is never invoked, so the throw at the cached('feed-items', …) call
// (feeds.js:360) lands directly in the outer catch.
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

// Drive the real GET /api/feed/atom handler over a mocked ctx. The caller supplies the
// two seams used to steer the single try into its catch: `cached` and `fs`. The res mock
// carries the streaming seam the success path uses (writeHead / end / writableEnded), so
// every 200 stream attempt is recorded; the json() stub captures every envelope reply in
// `replies`; and every cached(key, ttl) invocation is recorded in `cachedCalls`. Together
// they let a test assert the 500 is the ONLY reply and the streaming success path never
// fired. Fully in process: no network, no server, no real disk.
async function runAtomFeed({ cached, fs }) {
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
  const pathname = '/api/feed/atom';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls, headCalls, endCalls, res };
}

describe('GET /api/feed/atom outer catch returns 500 Atom feed generation failed', () => {
  it('maps a throw from the cached(feed-items) memo call straight into the 500 reply', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls, headCalls, endCalls } = await runAtomFeed({ cached: throwingCached(), fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Atom feed generation failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the one memo call the handler reaches for this route:
    // cached('feed-items', 60000, fn) at feeds.js:360. The literal pair is shared by
    // design with the RSS handler's cached('feed-items', 60000) call.
    assert.deepStrictEqual(cachedCalls, [['feed-items', 60000]]);

    // cached threw before invoking the closure, so the content tree was never walked.
    assert.equal(fs.readdirCalls, 0, 'the walk closure never ran (no readdirSync)');

    // The streaming success path was never taken.
    assert.equal(headCalls.length, 0, 'res.writeHead never fired');
    assert.equal(endCalls.length, 0, 'res.end never fired');
  });

  it('never emits the streaming 200 Atom success path (writeHead 200 + res.end) on the cached-throw seam', async () => {
    const { replies, headCalls, endCalls, res } = await runAtomFeed({ cached: throwingCached(), fs: recordingFs() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: res.writeHead was never called with 200, res.end never
    // fired, and no reply carries a 200 status, so the success Atom stream returned at
    // feeds.js:374 and :379 was bypassed entirely.
    assert.equal(headCalls.some((h) => h.status === 200), false, 'res.writeHead never called with 200');
    assert.equal(headCalls.length, 0, 'res.writeHead never fired at all');
    assert.equal(endCalls.length, 0, 'res.end never fired (the success Atom stream never ran)');
    assert.equal(replies.some((r) => r.status === 200), false);

    // The handler did reply: the json() stub ended the response, exactly as the live
    // dispatcher detects a sent reply.
    assert.equal(res.writableEnded, true);
  });

  it('returns the same 500 when the throw comes from INSIDE scanFeedItems (fs.readdirSync), with cached running it', async () => {
    const fs = throwingFs();
    const { replies, cachedCalls, headCalls, endCalls } = await runAtomFeed({ cached: passthroughCached(), fs });

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
