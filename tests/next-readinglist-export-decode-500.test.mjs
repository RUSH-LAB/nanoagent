import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real module via createRequire
// the way the sibling route suites do (next-readinglist-export-loadcached,
// next-discussions-decode-guard), so this characterization test drives the genuine
// GET /api/reading-lists/:id/export handler rather than a reimplementation.
//
// It pins that handler's OUTER CATCH on a malformed path id. The route matches when
// READING_LIST_EXPORT_RE (/^\/api\/reading-lists\/[^/]+\/export$/) tests true, and its
// [^/]+ segment accepts a single '%', so the pathname '/api/reading-lists/%/export'
// enters the GET export branch. Inside the outer try the first statements split the
// pathname and run decodeURIComponent(parts[3]); for this pathname parts[3] is '%', and
// decodeURIComponent('%') throws a URIError. That throw precedes the loadJSON data load,
// the not-found 404 guard, the url.searchParams.get('format') read, and both success
// streams (the bibtex and markdown res.writeHead(200, …) / res.end(…)), so it escapes to
// the outer catch, which returns json(res, 500, {error: 'Export failed'}). loadJSON
// swallows a missing or broken file to {}, so it is not itself a 500 seam; the bare '%'
// decode is the clean trigger. (Symbolic anchors are used over raw line numbers so this
// note cannot silently drift if the source above the handler shifts.)
const require = createRequire(import.meta.url);
const routes = require('../server/routes/bookmarks-reading-lists.js');

// The exact reply the outer catch emits, in the {status, payload} shape the json()
// stub records below.
const GOLDEN_500 = { status: 500, payload: { error: 'Export failed' } };

// The bare '%' id that matches the export regex yet makes decodeURIComponent throw.
const BAD_EXPORT_PATH = '/api/reading-lists/%/export';

// Build one invocation of the real export handler over a minimal mocked ctx, driving
// the bare-'%' export pathname. Returns a thunk so each test can wrap the actual call
// in assert.doesNotReject and then read the recorded state. Every json(res, status,
// payload) write is captured into `replies`; res.writeHead flips headersSent and
// res.end flips writableEnded, so a test can prove no 200 download stream began.
// loadJSON is a tripwire: it counts its calls and must never run, because the decode
// throws before the data load. path, fs, PROJECT_ROOT, CORS_ORIGIN, and saveJSON are
// reached only after the decode, so they are omitted.
function prepareExport() {
  const replies = [];
  const state = { loadJSONCalls: 0 };
  const res = {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    end() { this.writableEnded = true; },
  };
  const ctx = {
    json(_res, status, payload) {
      const r = { status, payload };
      replies.push(r);
      _res.writableEnded = true;
      return r;
    },
    loadJSON() { state.loadJSONCalls++; return { lists: [] }; },
    READING_LISTS_FILE: '/virtual/reading-lists.json',
  };
  const url = new URL(`http://localhost${BAD_EXPORT_PATH}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const invoke = () => routes(req, res, url, BAD_EXPORT_PATH, ctx);
  return { invoke, replies, res, state };
}

describe('GET /api/reading-lists/:id/export outer catch returns 500 Export failed on a malformed id', () => {
  it('returns the 500 {error: "Export failed"} golden and never rejects when the id is a bare %', async () => {
    const { invoke, replies } = prepareExport();

    // The handler swallows the URIError internally, so the call resolves instead of
    // rejecting. Before any try/catch this throw would surface as an unhandled
    // rejection; assert.doesNotReject proves the outer catch absorbs it.
    await assert.doesNotReject(invoke, 'a bare "%" id must be caught, not rejected');

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Export failed'} payload shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
  });

  it('throws at the decode before any data load or response stream (provenance proof)', async () => {
    const { invoke, replies, res, state } = prepareExport();

    await assert.doesNotReject(invoke);

    // Anchor the never-reached checks so none of them can pass vacuously: the handler
    // emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // decodeURIComponent('%') threw at the decode, before the loadJSON data load, so the
    // loadJSON tripwire never ran.
    assert.equal(state.loadJSONCalls, 0, 'the decode threw before loadJSON');

    // No 200 download stream began: res.writeHead (the bibtex and markdown stream heads)
    // was never called, so headersSent stays false.
    assert.equal(res.headersSent, false, 'no res.writeHead(200, …) stream head was written');

    // The catch did send its 500 through json(), which flips writableEnded; this is the
    // positive counterpart proving the lone reply really went out.
    assert.equal(res.writableEnded, true, 'the catch sent its 500 reply via json');

    // Neither the streamed success 200 nor the not-found 404 fired: the throw preceded
    // the list lookup and both stream branches.
    assert.equal(replies.some((r) => r.status === 200), false, 'no 200 success reply');
    assert.equal(replies.some((r) => r.status === 404), false, 'the not-found guard never fired');
  });
});
