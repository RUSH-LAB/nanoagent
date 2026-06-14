import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-diffsummary-500 / next-clusters-500 / next-formatall-500),
// so this characterization test drives the genuine GET /api/content-recommend handler
// instead of a reimplementation.
//
// It pins that handler's OUTER CATCH (content-analysis-b.js:635 through :683). The
// `const userId = url.searchParams.get('userId') || 'default'` (:636) runs BEFORE the try
// with no guard, so omitting ?userId simply defaults userId to 'default'. The try opens at
// :637 and its first failable step is the reading-progress load `loadJSON(PROGRESS_FILE)`
// at :639 (PROGRESS_FILE built at :638 from the real path.join). Any throw on the data-load
// prefix lands in the bindingless catch at :680 and :681, which returns
// json(res, 500, {error: 'Recommendation failed'}). The success 200 projection
// {recommendations, basedOn} returned at :679 is then never emitted; because the catch is
// bindingless the body is a fixed string with no err.message leak.
//
// IMPORTANT: 'Recommendation failed' is ALSO the golden of the SEPARATE
// GET /api/references/recommend-by-author handler (content-analysis-c.js:983, already
// pinned by next-content-c-ref-caches), and /api/content-recommend is a prefix of the
// unrelated /api/content-recommend-v2 handler in content-analysis-a.js. This suite both
// requires content-analysis-b.js AND drives the exact /api/content-recommend pathname (see
// runRecommend below), so it pins THIS handler, never the a.js or c.js siblings.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/virtual-root';
const BOOKMARKS_FILE = '/virtual-root/data/bookmarks.json';
// The reading-progress path the handler builds at content-analysis-b.js:638; it is the
// first loadJSON argument the try reaches (:639).
const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');

// The exact reply the outer catch emits, captured in the {status, body} shape used by the
// json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Recommendation failed' } };

// Every key the success projection returns, the object {recommendations, basedOn} sent by
// json(res, 200, ...) at content-analysis-b.js:679. The never-reached proof asserts that
// none of them surfaces in any captured reply.
const SUCCESS_KEYS = ['recommendations', 'basedOn'];

// Seam (a): the reading-progress load fails. A loadJSON that throws on its FIRST call
// models loadJSON(PROGRESS_FILE) at content-analysis-b.js:639 failing (the try's first
// failable step). It records each path it is handed so a test can prove the throw fired on
// PROGRESS_FILE and that the second load loadJSON(BOOKMARKS_FILE) at :641 was never reached.
function throwingFirstLoadJSON() {
  const fn = (file) => { fn.calls.push(file); throw new Error('reading-progress.json unreadable'); };
  fn.calls = [];
  return fn;
}

// Seam (b): the reading-progress load SUCCEEDS but the bookmarks load fails. The first call
// (PROGRESS_FILE) returns an empty object, so :640 builds an empty readPages set without
// throwing; the second call (BOOKMARKS_FILE) at :641 throws. This proves the throw can
// originate later on the data-load prefix and still converge on the SAME outer catch.
function throwOnBookmarksLoadJSON() {
  const fn = (file) => {
    fn.calls.push(file);
    if (file === BOOKMARKS_FILE) throw new Error('bookmarks.json unreadable');
    return {};
  };
  fn.calls = [];
  return fn;
}

// fs and isValidFilePath are destructured by the handler but never reached on either seam:
// loadJSON throws across :639 through :641, ahead of the isValidFilePath guard (:646), the
// interest-word readFileSync loop (:648), and the candidate scan's readdirSync (:656). Each
// records its calls so a test can prove the 500 short-circuited before the content walk
// (every counter stays 0).
function unreachedFs() {
  let readCalls = 0;
  let readdirCalls = 0;
  return {
    get readCalls() { return readCalls; },
    get readdirCalls() { return readdirCalls; },
    readFileSync() { readCalls++; throw new Error('readFileSync should not be reached'); },
    readdirSync() { readdirCalls++; throw new Error('readdirSync should not be reached'); },
  };
}

function recordingIsValidFilePath() {
  const fn = () => { fn.calls++; return true; };
  fn.calls = 0;
  return fn;
}

// Drive the real GET /api/content-recommend handler over a mocked ctx. The caller supplies
// the loadJSON seam that steers the single try into its catch; the remaining ctx fields the
// route touches before it throws are json, path, PROJECT_ROOT, and BOOKMARKS_FILE. fs,
// isValidFilePath, and ALLOWED_EXTS are supplied for faithfulness but are never reached on
// these seams. Every json(res, status, payload) write is captured in `replies` so a test
// can assert the 500 is the ONLY reply and the success projection never fired. The pathname
// is fixed to /api/content-recommend so this never exercises the a.js -v2 handler or the
// c.js recommend-by-author handler that shares the 'Recommendation failed' text.
async function runRecommend({ loadJSON, fs, isValidFilePath }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    loadJSON,
    fs,
    path,
    isValidFilePath,
    PROJECT_ROOT,
    BOOKMARKS_FILE,
    ALLOWED_EXTS: ['.md', '.mdx'],
  };
  const pathname = '/api/content-recommend';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/content-recommend outer catch returns 500 Recommendation failed', () => {
  it('maps a throw from the first loadJSON (reading-progress.json) into the lone 500 reply', async () => {
    const loadJSON = throwingFirstLoadJSON();
    const fs = unreachedFs();
    const isValidFilePath = recordingIsValidFilePath();
    const { replies } = await runRecommend({ loadJSON, fs, isValidFilePath });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact {error: 'Recommendation failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the FIRST data load the handler reaches: loadJSON was called
    // exactly once, on PROGRESS_FILE (content-analysis-b.js:639), so it threw before the
    // second loadJSON(BOOKMARKS_FILE) at :641 could run.
    assert.deepStrictEqual(loadJSON.calls, [PROGRESS_FILE]);

    // The 500 short-circuited ahead of the content walk: the isValidFilePath guard (:646),
    // the interest-word readFileSync loop (:648), and the candidate scan's readdirSync
    // (:656) were all never reached.
    assert.equal(isValidFilePath.calls, 0, 'no isValidFilePath: loadJSON threw first');
    assert.equal(fs.readCalls, 0, 'no readFileSync: loadJSON threw first');
    assert.equal(fs.readdirCalls, 0, 'no readdirSync: loadJSON threw first');
  });

  it('never emits the success 200 {recommendations, basedOn} projection', async () => {
    const { replies } = await runRecommend({
      loadJSON: throwingFirstLoadJSON(),
      fs: unreachedFs(),
      isValidFilePath: recordingIsValidFilePath(),
    });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies array:
    // the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries either
    // success-projection key, so the {recommendations, basedOn} returned at :679 was
    // bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)), false);
  });

  it('returns the SAME lone 500 when the throw comes from the later bookmarks load (:641)', async () => {
    const loadJSON = throwOnBookmarksLoadJSON();
    const fs = unreachedFs();
    const isValidFilePath = recordingIsValidFilePath();
    const { replies } = await runRecommend({ loadJSON, fs, isValidFilePath });

    // Same golden as seam (a), proving the 500 is independent of WHERE on the data-load
    // prefix the throw originates: here the first load succeeded and the second threw.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Both loads ran, in order: the reading-progress read succeeded and the bookmarks read
    // threw, so loadJSON was called twice, with PROGRESS_FILE then BOOKMARKS_FILE.
    assert.deepStrictEqual(loadJSON.calls, [PROGRESS_FILE, BOOKMARKS_FILE]);

    // The throw at :641 still precedes the content walk, so the same short-circuit holds.
    assert.equal(isValidFilePath.calls, 0, 'no isValidFilePath: the bookmarks load threw first');
    assert.equal(fs.readCalls, 0, 'no readFileSync: the bookmarks load threw first');
    assert.equal(fs.readdirCalls, 0, 'no readdirSync: the bookmarks load threw first');

    // Never-reached proof on this seam too.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)), false);
  });
});
