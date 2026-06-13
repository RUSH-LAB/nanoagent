import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real module via createRequire
// the way the sibling route tests do, so these cases exercise the shipped GET,
// POST, and DELETE /api/bookmarks handlers rather than a reimplementation.
// This is an ADD-ONLY characterization test: it pins the current, correct
// behavior of the bookmark trio so future refactors cannot silently change it.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

const BOOKMARKS_FILE = '/fake/data/bookmarks.json';

// Tagged sanitizeText mock, kept faithful to the real server-utils.js
// implementation (`typeof str !== 'string' ? '' : str.slice(0, MAX_TEXT_LENGTH)`):
// non-string and empty inputs both return '', the falsy value that makes the
// handler's `sanitizeText(title) || pagePath` fallback resolve to the RAW page
// path. Non-empty strings get an 'S:' prefix so a sanitized value is visibly
// distinct from the raw path the title fallback uses. The GOAL's example mock
// (`typeof s === 'string' ? 'S:' + s : s`) would instead make sanitizeText('')
// truthy ('S:') and sanitizeText(42) the number 42, mis-pinning the empty-title
// fallback and the non-string-title edge, so this faithful variant is used.
function taggedSanitize(s) {
  return (typeof s === 'string' && s.length > 0) ? 'S:' + s : '';
}

// Drive a real /api/bookmarks handler over a mocked ctx. saveJSON pushes onto
// `saved` (a write counter), rateLimit records every (key, limit) it is asked,
// readBody bumps a counter so a short-circuit before the body read is provable,
// and json captures the (status, body) the handler returns. No real filesystem,
// network, or git is ever touched.
async function invoke({ method, body = {}, doc = { bookmarks: [] }, rateLimitOk = true, readBodyThrows = false }) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount += 1;
      if (readBodyThrows) throw new Error('bad body');
      return body;
    },
    // Return a fresh deep copy per call so the object handed to saveJSON is
    // decoupled from the seed and the persisted state can be asserted directly.
    loadJSON: (fp) => {
      if (fp === BOOKMARKS_FILE) return JSON.parse(JSON.stringify(doc));
      throw new Error('unexpected loadJSON path: ' + fp);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    sanitizeText: taggedSanitize,
    json: (_res, status, b) => { captured = { status, body: b }; },
    BOOKMARKS_FILE,
  };
  const pathname = '/api/bookmarks';
  const url = new URL('http://localhost' + pathname);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await bookmarksReadingListsRoutes(req, res, url, pathname, ctx);
  return { captured, saved, rateLimitCalls, readBodyCount };
}

describe('GET /api/bookmarks', () => {
  it('returns 200 with an empty array when the store has no bookmarks (the || [] fallback) and never saves', async () => {
    const { captured, saved, rateLimitCalls } = await invoke({ method: 'GET', doc: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { bookmarks: [] });
    assert.equal(saved.length, 0);
    assert.equal(rateLimitCalls.length, 0); // GET is not rate limited
  });

  it('returns 200 echoing the stored bookmarks array on a populated store and never saves', async () => {
    const bookmarks = [
      { path: '/docs/a', title: 'A', addedAt: '2020-01-01T00:00:00.000Z' },
      { path: '/docs/b', title: 'B', addedAt: '2020-01-02T00:00:00.000Z' },
    ];
    const { captured, saved } = await invoke({ method: 'GET', doc: { bookmarks } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { bookmarks });
    assert.equal(saved.length, 0);
  });
});

describe('POST /api/bookmarks guards', () => {
  it('returns 429 before reading the body when rate limited, keyed bookmarks:<addr> with limit 30, and never saves', async () => {
    const { captured, saved, rateLimitCalls, readBodyCount } = await invoke({
      method: 'POST', rateLimitOk: false, body: { path: '/docs/a' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.deepEqual(rateLimitCalls, [{ key: 'bookmarks:127.0.0.1', limit: 30 }]);
    assert.equal(readBodyCount, 0); // the 429 short-circuits before the body is read
    assert.equal(saved.length, 0);
  });

  it('returns 400 Missing path for an omitted, non-string, or empty-string path and never saves', async () => {
    const omitted = await invoke({ method: 'POST', body: {} });
    assert.equal(omitted.captured.status, 400);
    assert.deepEqual(omitted.captured.body, { error: 'Missing path' });
    assert.equal(omitted.saved.length, 0);

    const nonString = await invoke({ method: 'POST', body: { path: 42 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing path' });
    assert.equal(nonString.saved.length, 0);

    const empty = await invoke({ method: 'POST', body: { path: '' } });
    assert.equal(empty.captured.status, 400);
    assert.deepEqual(empty.captured.body, { error: 'Missing path' });
    assert.equal(empty.saved.length, 0);
  });

  it('returns 400 when the path exceeds 500 characters and never saves', async () => {
    const { captured, saved } = await invoke({ method: 'POST', body: { path: 'p'.repeat(501) } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Path must be 500 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('returns 400 when a string title exceeds 500 characters and never saves', async () => {
    const { captured, saved } = await invoke({
      method: 'POST', body: { path: '/docs/a', title: 't'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Title must be 500 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('does not reject a non-string title (the length guard fires only for strings) and proceeds to the add path', async () => {
    // title 42 is not a string, so `typeof title === 'string'` is false and the
    // length guard is skipped: the handler proceeds to add. sanitizeText(42)
    // returns '' (faithful to server-utils), so the stored title falls back to
    // the raw page path rather than being rejected.
    const { captured, saved } = await invoke({
      method: 'POST', doc: { bookmarks: [] }, body: { path: '/docs/numtitle', title: 42 },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.ok(captured.body.bookmark, 'a single bookmark object is returned');
    assert.equal(captured.body.bookmark.title, '/docs/numtitle'); // raw-path fallback
    assert.equal(saved.length, 1);
  });

  it('returns 200 with the full bookmarks array and no save when the path is already bookmarked', async () => {
    // Dedup compares the RAW pagePath against stored b.path, so the seed path is raw.
    const doc = { bookmarks: [{ path: '/docs/dup', title: 'Existing' }] };
    const { captured, saved } = await invoke({ method: 'POST', doc, body: { path: '/docs/dup' } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, bookmarks: [{ path: '/docs/dup', title: 'Existing' }] });
    assert.equal(saved.length, 0); // idempotent: no write on a duplicate
  });

  it('adds a new bookmark: returns 200 with the single object, sanitizes the path, stamps a string addedAt, and saves once', async () => {
    const { captured, saved } = await invoke({
      method: 'POST', doc: { bookmarks: [] }, body: { path: '/docs/new', title: 'Hello' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    const bm = captured.body.bookmark;
    assert.equal(bm.path, 'S:/docs/new'); // path is the sanitizeText output
    assert.equal(bm.title, 'S:Hello');
    assert.equal(typeof bm.addedAt, 'string'); // clock value: assert type only
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, BOOKMARKS_FILE);
    assert.deepEqual(saved[0].data.bookmarks.map(b => b.path), ['S:/docs/new']);
  });

  it('falls back to the raw page path for the title when the title is omitted or empty, while the path stays sanitized', async () => {
    const omitted = await invoke({ method: 'POST', doc: { bookmarks: [] }, body: { path: '/docs/raw' } });
    assert.equal(omitted.captured.status, 200);
    assert.equal(omitted.captured.body.bookmark.title, '/docs/raw'); // raw, un-sanitized fallback
    assert.equal(omitted.captured.body.bookmark.path, 'S:/docs/raw'); // path is sanitized

    const empty = await invoke({ method: 'POST', doc: { bookmarks: [] }, body: { path: '/docs/raw2', title: '' } });
    assert.equal(empty.captured.status, 200);
    assert.equal(empty.captured.body.bookmark.title, '/docs/raw2');
    assert.equal(empty.captured.body.bookmark.path, 'S:/docs/raw2');
  });

  it('returns 400 Invalid request when reading the body throws (outer catch)', async () => {
    const { captured, saved } = await invoke({ method: 'POST', readBodyThrows: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid request' });
    assert.equal(saved.length, 0);
  });
});

describe('DELETE /api/bookmarks guards', () => {
  it('returns 400 Missing path for an omitted or non-string path and never saves', async () => {
    const omitted = await invoke({ method: 'DELETE', body: {} });
    assert.equal(omitted.captured.status, 400);
    assert.deepEqual(omitted.captured.body, { error: 'Missing path' });
    assert.equal(omitted.saved.length, 0);

    const nonString = await invoke({ method: 'DELETE', body: { path: 42 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing path' });
    assert.equal(nonString.saved.length, 0);
  });

  it('returns 404 Bookmark not found when the path is absent, whether the store is populated or lacks a bookmarks array, and never saves', async () => {
    const populated = await invoke({
      method: 'DELETE', doc: { bookmarks: [{ path: '/docs/other' }] }, body: { path: '/docs/a' },
    });
    assert.equal(populated.captured.status, 404);
    assert.deepEqual(populated.captured.body, { error: 'Bookmark not found' });
    assert.equal(populated.saved.length, 0);

    const noArray = await invoke({ method: 'DELETE', doc: {}, body: { path: '/docs/a' } });
    assert.equal(noArray.captured.status, 404);
    assert.deepEqual(noArray.captured.body, { error: 'Bookmark not found' });
    assert.equal(noArray.saved.length, 0);
  });

  it('removes the matching bookmark, keeps the siblings, returns 200, and saves once', async () => {
    const doc = { bookmarks: [{ path: '/keep1' }, { path: '/drop' }, { path: '/keep2' }] };
    const { captured, saved } = await invoke({ method: 'DELETE', doc, body: { path: '/drop' } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, BOOKMARKS_FILE);
    assert.deepEqual(saved[0].data.bookmarks.map(b => b.path), ['/keep1', '/keep2']);
  });
});
