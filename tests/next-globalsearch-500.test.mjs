import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load the REAL module via createRequire the way the sibling
// route suites do (next-duplicates-500 / next-orphans-500), so this characterization
// test drives the genuine GET /api/search/global handler in server/routes/file-tools.js
// rather than a reimplementation.
//
// It pins that handler's OUTER catch. After the pre-scan guard
// `if (!query) return json(res, 400, {error: 'Missing query'})` (file-tools.js:121), the
// whole search runs inside one try (opens at :123). The try's first failable step is
// `searchContent(contentDir)` (:141), whose body calls
// `fs.readdirSync(dir, {withFileTypes: true})` (:127). That readdirSync sits OUTSIDE every
// inner try/catch, so a throw there escapes to the outer catch (:173), which returns
// `json(res, 500, {error: 'Global search failed'})` (:174). The success projection
// `json(res, 200, {results, total, query})` (:172) is then never emitted.
//
// readdirSync is the ONLY clean seam: the per-file `fs.readFileSync` (:133) and the
// `loadReferencesCached` call (:144) are each wrapped in a swallowing inner catch, so a
// throw from either is absorbed and does NOT reach the 500. The final test below proves
// that contrast directly.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, in the {status, body} shape the json() stub
// records below.
const GOLDEN_500 = { status: 500, body: { error: 'Global search failed' } };

// An fs whose readdirSync throws on its first call. searchContent(contentDir) reaches it
// immediately, so the throw escapes the scan and lands in the outer catch. readFileSync
// and statSync are present for faithfulness but are never reached on this path.
function throwingReaddirFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
    readFileSync() { return ''; },
    statSync() { throw new Error('no stat'); },
  };
}

// An fs that lets searchContent walk one content file but throws inside the per-file
// readFileSync, the seam the handler wraps in a swallowing inner catch. readdirSync
// returns a single non-directory `.md` entry, so the scan enters the inner try, the read
// throws, the catch absorbs it, and the handler proceeds to its 200 reply. statSync throws
// so loadReferencesCached (also inner-caught) falls through to its empty-result branch.
function swallowedReadFileFs() {
  let readdirCalls = 0;
  let readFileCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get readFileCalls() { return readFileCalls; },
    readdirSync() { readdirCalls++; return [{ name: 'note.md', isDirectory: () => false }]; },
    readFileSync() { readFileCalls++; throw new Error('file unreadable'); },
    statSync() { throw new Error('no stat'); },
  };
}

// Drive the real GET /api/search/global handler over a mocked ctx. `query` becomes the
// ?q= value (omit it to leave the param absent and fire the 400 guard); `fs` is the
// steering seam; `loadJSON` backs the comments/discussions reads on the success path
// (defaults to empty stores). Every json(res, status, payload) write is captured in
// `replies` so a test can assert exactly which reply fired and that nothing else did.
async function runGlobalSearch({ fs, query, loadJSON } = {}) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    // file-tools.js imports numericParam from server-utils at module load, so the live
    // handler uses that copy, not ctx.numericParam; this entry only mirrors the ctx field
    // list the GOAL names for faithfulness and is intentionally never consulted.
    numericParam: (_raw, def) => def,
    loadJSON: loadJSON || (() => ({})),
    COMMENTS_FILE: '/virtual-root/data/comments.json',
    DISCUSSIONS_FILE: '/virtual-root/data/discussions.json',
  };
  const pathname = '/api/search/global';
  const qs = query === undefined ? '' : `?q=${encodeURIComponent(query)}`;
  const url = new URL(`http://localhost${pathname}${qs}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/search/global outer catch returns 500 Global search failed', () => {
  it('maps a throw from the fs.readdirSync scan seam straight into the 500 reply', async () => {
    const fs = throwingReaddirFs();
    const { replies } = await runGlobalSearch({ fs, query: 'foo' });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Global search failed'} body.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The scan actually reached the readdirSync seam rather than short-circuiting, so the
    // throw came from inside the try: this is genuinely the outer catch firing.
    assert.equal(fs.readdirCalls, 1, 'searchContent called readdirSync once before throwing');
  });

  it('never emits the success 200 {results, total, query} projection', async () => {
    const fs = throwingReaddirFs();
    const { replies } = await runGlobalSearch({ fs, query: 'foo' });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty array: the
    // handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // No reply carries a 200 status, and none carries any success-projection key, so the
    // results list returned at file-tools.js:172 was bypassed entirely.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && ('results' in r.body || 'total' in r.body || 'query' in r.body)),
      false,
    );
  });

  it('fires the pre-scan 400 Missing query guard before the try, never touching the scan', async () => {
    const fs = throwingReaddirFs();
    const { replies } = await runGlobalSearch({ fs, query: undefined });

    // An absent ?q hits `if (!query) return json(res, 400, ...)` at file-tools.js:121,
    // which returns before the try opens. This documents the guard the 500 tests clear
    // with q=foo and proves it is a distinct reply from the outer catch.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], { status: 400, body: { error: 'Missing query' } });

    // The throwing fs was never consulted, confirming the guard short-circuits ahead of
    // searchContent.
    assert.equal(fs.readdirCalls, 0, 'the 400 guard returned before any readdirSync');
  });

  it('does NOT 500 when the swallowed inner readFileSync seam throws; it reaches the 200 instead', async () => {
    const fs = swallowedReadFileFs();
    const { replies } = await runGlobalSearch({ fs, query: 'foo' });

    // readFileSync throws inside the per-file inner try/catch (file-tools.js:132 to :138),
    // which absorbs it; the scan finds no match and the handler completes normally. This
    // proves readFileSync is the wrong seam for the 500 and that readdirSync is the only
    // non-swallowed throwable op, exactly as the GOAL requires.
    assert.equal(fs.readdirCalls, 1, 'searchContent walked the content dir once');
    assert.ok(fs.readFileCalls > 0, 'the per-file read seam was reached and threw');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], { status: 200, body: { results: [], total: 0, query: 'foo' } });

    // The swallowed throw never produced the outer-catch 500.
    assert.equal(replies.some((r) => r.status === 500), false);
    assert.equal(replies.some((r) => r.body && r.body.error === 'Global search failed'), false);
  });
});
