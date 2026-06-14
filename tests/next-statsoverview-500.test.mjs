import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// route tests do (see tests/next-analytics-export-csv.test.mjs), so this
// characterization test drives the genuine GET /api/stats/overview handler and
// never a reimplementation.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

// The overview handler (content-analysis-a.js:236) wraps a memoized content scan,
// cached('stats-overview', 30000, () => { ... }) at content-analysis-a.js:245, in
// a try/catch and answers json(res, 500, {error: 'Overview failed'}) at
// content-analysis-a.js:278 when that scan throws. The success path answers
// json(res, 200, projection). Both replies flow through ctx.json, so the harness
// records every json(res, status, payload) call and asserts against the list.
const PROJECT_ROOT = '/fake/root';
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// A pass-through cached runs the real closure once with no memoization, matching
// the live helper's contract that a throwing fn propagates and is never stored.
// It keeps the genuine scan and projection code under test while a stubbed fs
// decides success versus failure.
const passThroughCached = (key, ttlMs, fn) => fn();

// Invoke the route module directly with a mocked ctx, recording every json reply.
// ctx.json is defined here (the variant ctx objects below never carry json) so the
// capture always wins, and `replies` lets a test prove the 200 projection is never
// emitted on the failure path. Fully in process: no network, no disk.
async function invoke(ctx) {
  const pathname = '/api/stats/overview';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const replies = [];
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  const fullCtx = {
    json(_res, status, payload) {
      replies.push({ status, payload });
      res.writableEnded = true;
      return { status, payload };
    },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { replies, res };
}

describe('GET /api/stats/overview: outer-catch 500', () => {
  it('answers 500 Overview failed when ctx.cached throws, and never a 200', async () => {
    // Stub cached to throw so the memoized scan call throws straight into the
    // outer catch.
    const ctx = { cached: () => { throw new Error('boom'); } };
    const { replies } = await invoke(ctx);

    assert.equal(replies.length, 1, 'the handler emits exactly one reply');
    assert.deepStrictEqual(replies[0], { status: 500, payload: { error: 'Overview failed' } });
    assert.equal(replies.some(r => r.status === 200), false, 'the 200 projection is never emitted');
  });

  it('answers the same 500 when the real closure runs and fs.readdirSync throws', async () => {
    // Alternative trigger: a pass-through cached runs the genuine closure, whose
    // first act is fs.readdirSync(contentDir); a throw there unwinds through the
    // closure and cached into the same outer catch.
    const ctx = {
      cached: passThroughCached,
      path,
      PROJECT_ROOT,
      ALLOWED_EXTS: ['.md', '.mdx'],
      fs: { readdirSync() { throw new Error('readdir failed'); } },
    };
    const { replies } = await invoke(ctx);

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], { status: 500, payload: { error: 'Overview failed' } });
    assert.equal(replies.some(r => r.status === 200), false);
  });
});

describe('GET /api/stats/overview: success projection (positive control)', () => {
  it('answers the 200 projection from the real scan over a controlled fs', async () => {
    // One content file with a known body lets the genuine closure compute every
    // projection field deterministically, proving a 200 IS reachable so the
    // no-200 assertions above are meaningful. references stays 0 because the
    // bibliography read throws and loadReferencesCached swallows it to {}.
    const FILE_CONTENT = '# Title\nalpha beta [@k] [[w]] [x](y)\n';
    const CONTENT_FILE = path.join(CONTENT_DIR, 'a.md');
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fakeFs = {
      readdirSync(dir) {
        if (dir === CONTENT_DIR) return [{ name: 'a.md', isDirectory: () => false }];
        throw enoent();
      },
      readFileSync(fp) {
        if (fp === CONTENT_FILE) return FILE_CONTENT;
        throw enoent();
      },
      statSync() { throw enoent(); },
    };
    const ctx = { cached: passThroughCached, path, PROJECT_ROOT, ALLOWED_EXTS: ['.md', '.mdx'], fs: fakeFs };
    const { replies } = await invoke(ctx);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, 200);
    // The exact projection (files, words, headings, citations, links, references,
    // avgWordsPerFile, avgHeadingsPerFile, avgCitationsPerFile, readingTimeHours)
    // for the body above: 7 whitespace tokens, 1 heading line, 1 [@ citation, and
    // 2 links ([[ plus ]( ). readingTimeHours rounds 7/200/60 down to 0.
    assert.deepStrictEqual(replies[0].payload, {
      files: 1,
      words: 7,
      headings: 1,
      citations: 1,
      links: 2,
      references: 0,
      avgWordsPerFile: 7,
      avgHeadingsPerFile: 1,
      avgCitationsPerFile: 1,
      readingTimeHours: 0,
    });
  });
});
