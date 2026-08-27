import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// The three handlers under test touch only readFileSync (page reads) and
// readdirSync (recursive content walk with {withFileTypes:true}); the stub
// returns entries shaped the way the walk expects and ignores the encoding or
// options argument.
function makeFs(fileMap) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const [rel, content] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    fileContents.set(cur, content);
  }

  return {
    readdirSync(dir) {
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Invoke a content-analysis-a route handler with a mocked ctx and capture the
// response handed to `json(res, status, payload)`.
async function invoke({ pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/file/similarity (SIMILARITY_STOP_WORDS hoisted to module scope)', () => {
  // f1 carries three content words plus three length>3 stop words ("would",
  // "that", "this"); f2 carries only the three content words. Only the stop set
  // removes the function words, so with it live both keyword sets collapse to
  // {machine, learning, networks} and the score is a clean 1.0. Were the set
  // dropped, f1 would keep size 6 and the score would fall to 0.5, so asserting
  // 1.0 proves SIMILARITY_STOP_WORDS is consulted.
  const FIXTURE = {
    'f1.md': 'machine learning networks would that this',
    'f2.md': 'machine learning networks',
  };
  // /api/file/similarity now wraps its two reads and Jaccard math in cached(key, ttl,
  // fn); supply a pass-through so this fs-backed test still exercises the real
  // SIMILARITY_STOP_WORDS filtering.
  const ctx = { fs: makeFs(FIXTURE), path, PROJECT_ROOT, isValidFilePath: () => true, cached: (_k, _t, fn) => fn() };

  it('filters stop words from both files before scoring Jaccard overlap', async () => {
    const r = await invoke({ pathname: '/api/file/similarity', search: '?path1=f1.md&path2=f2.md', ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      similarity: 1,
      sharedWords: ['machine', 'learning', 'networks'],
      uniqueToFile1: 0,
      uniqueToFile2: 0,
      sharedCount: 3,
    });
  });

  it('rejects an invalid path with 400', async () => {
    const r = await invoke({
      pathname: '/api/file/similarity',
      search: '?path1=f1.md&path2=f2.md',
      ctx: { ...ctx, isValidFilePath: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid paths' });
  });
});

describe('GET /api/stats/word-frequency (WORD_FREQ_STOP_WORDS hoisted to module scope)', () => {
  // The fixture file repeats "machine" twice and adds three length>3 stop words
  // ("would", "very", "also"). Only the stop set removes them, so with it live
  // the frequency table is exactly {machine:2, learning:1} and the unique count
  // is 2. Were the set dropped, "would", "very", and "also" would survive and
  // the unique count would be 5, so the assertion pins the filter as live.
  const FIXTURE = { 'content/doc.md': 'machine machine learning would very also' };
  // word-frequency now wraps its scan in cached(key, ttl, fn); supply a pass-through
  // so this fs-backed test still exercises the real WORD_FREQ_STOP_WORDS filtering.
  const ctx = { fs: makeFs(FIXTURE), path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached: (_k, _t, fn) => fn() };

  it('omits stop words from the frequency table', async () => {
    const r = await invoke({ pathname: '/api/stats/word-frequency', search: '?dir=content', ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      directory: 'content',
      words: [{ word: 'machine', count: 2 }, { word: 'learning', count: 1 }],
      totalUniqueWords: 2,
    });
  });

  it('rejects an invalid directory with 400', async () => {
    const r = await invoke({
      pathname: '/api/stats/word-frequency',
      search: '?dir=../etc',
      ctx: { ...ctx, isValidDir: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid directory' });
  });
});

describe('GET /api/content-recommend-v2 (RECOMMEND_STOP_WORDS hoisted to module scope)', () => {
  // The source body holds four length>4 content words plus the length-5 stop
  // word "other". Only RECOMMEND_STOP_WORDS removes "other", so the source
  // keyword set (reported as basedOn.keywords) is 4 with the set live and would
  // be 5 without it. The lone candidate shares all four keywords, so it scores
  // and leads the recommendations.
  const FIXTURE = {
    'content/source.md': '---\ntitle: Source\n---\nmachine learning networks algorithms other\n',
    'content/cand.md': 'machine learning networks algorithms other\n',
  };
  // content-recommend-v2 now wraps its per-path scan in cached(key, ttl, fn); supply a
  // pass-through so this fs-backed test still exercises the real RECOMMEND_STOP_WORDS filter.
  const ctx = { fs: makeFs(FIXTURE), path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached: (_key, _ttl, fn) => fn() };

  it('drops stop words from the source keyword set and ranks the overlapping page', async () => {
    const r = await invoke({ pathname: '/api/content-recommend-v2', search: '?path=content/source.md', ctx });
    assert.equal(r.status, 200);
    assert.equal(r.payload.sourcePath, 'content/source.md');
    assert.deepEqual(r.payload.basedOn, { tags: 0, keywords: 4, citations: 0 });
    assert.deepEqual(r.payload.recommendations, [
      { path: 'content/cand.md', title: 'cand', score: 5, sharedTags: [], sharedCitations: 0 },
    ]);
  });

  it('rejects an invalid path with 400', async () => {
    const r = await invoke({
      pathname: '/api/content-recommend-v2',
      search: '?path=../secret',
      ctx: { ...ctx, isValidFilePath: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid path' });
  });
});
