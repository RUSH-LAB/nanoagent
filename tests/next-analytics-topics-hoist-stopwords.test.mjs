import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// bookmarks-reading-lists.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// The topics handler makes three fs calls: existsSync (the content-dir guard),
// readdirSync (withFileTypes) and readFileSync. `emptyDirs` registers
// existing-but-empty directories so the handler can see an empty content dir.
function makeFs(fileMap, emptyDirs = []) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const rel of emptyDirs) ensureDir(path.join(PROJECT_ROOT, rel));

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
    existsSync(p) { return dirs.has(p) || fileContents.has(p); },
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

// A memoizing `cached` like the real one: the factory runs on the first call
// (cache miss) and is skipped on every later call (cache hit). `calls()` reports
// how many times the factory actually ran.
function makeMemoCached() {
  const store = new Map();
  let factoryCalls = 0;
  return {
    cached(key, _ttl, fn) {
      if (store.has(key)) return store.get(key);
      factoryCalls += 1;
      const value = fn();
      store.set(key, value);
      return value;
    },
    calls: () => factoryCalls,
  };
}

// Drive GET /api/analytics/topics with a mocked ctx and capture the json()
// response. `cached` defaults to a pass-through so the fixture fs is scanned on
// every call — exactly the cache-miss path the STOP_WORDS set now lives in.
async function getTopics(fs, cached = (_key, _ttl, fn) => fn()) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/analytics/topics');
  await bookmarksReadingListsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/analytics/topics', ctx);
  return captured;
}

// Frontmatter is stripped by the handler before counting, so the title words
// never reach the frequency table. Two nested files exercise the recursive
// content walk and cross-file accumulation. Stop words ("the", "and") are seeded
// MORE often than any content word, so they would top the list if the STOP_WORDS
// filter were skipped — pinning that the relocation kept the filter live.
//
// post1 (content/ml): machine×3, learning×2, neural×1, the×4, and×3
// post2 (content/dl): machine×2, learning×2, neural×2, network×2, algorithm×1, the×2, and×2
// totals:             machine 5, learning 4, neural 3, network 2, algorithm 1  (the 6, and 5 → filtered)
const POST1 = `---
title: Sample One
---

the machine and the machine learning and the neural machine learning the and
`;
const POST2 = `---
title: Sample Two
---

machine learning neural network the machine learning neural network the algorithm and and
`;

const FIXTURE = {
  'content/ml/post1.md': POST1,
  'content/dl/post2.md': POST2,
};

describe('GET /api/analytics/topics (STOP_WORDS built inside cached factory)', () => {
  it('returns the topic list and ordering unchanged', async () => {
    const res = await getTopics(makeFs(FIXTURE));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      topics: [
        { word: 'machine', count: 5 },
        { word: 'learning', count: 4 },
        { word: 'neural', count: 3 },
        { word: 'network', count: 2 },
        { word: 'algorithm', count: 1 },
      ],
    });

    // deepEqual already pins order; spell it out so the descending-count sort is explicit.
    assert.deepEqual(res.body.topics.map(t => t.word), ['machine', 'learning', 'neural', 'network', 'algorithm']);
  });

  it('still filters stop words even when they out-number every content word', async () => {
    const res = await getTopics(makeFs(FIXTURE));
    const words = res.body.topics.map(t => t.word);
    // Raw token counts are the=6 and and=5, above machine's 5; both must be dropped,
    // so a content word — not "the" — leads the ranking.
    assert.ok(!words.includes('the'), '"the" must be filtered out');
    assert.ok(!words.includes('and'), '"and" must be filtered out');
    assert.equal(words[0], 'machine');
  });

  it('returns an empty topic list when the content dir is missing or empty', async () => {
    // No content dir at all — the existsSync guard short-circuits the scan.
    const missing = await getTopics(makeFs({}));
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { topics: [] });

    // Content dir present but empty.
    const empty = await getTopics(makeFs({}, ['content']));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { topics: [] });
  });

  it('builds the list on a cache miss and reuses it on a hit (factory runs once)', async () => {
    const memo = makeMemoCached();
    const fs = makeFs(FIXTURE);
    const expected = {
      topics: [
        { word: 'machine', count: 5 },
        { word: 'learning', count: 4 },
        { word: 'neural', count: 3 },
        { word: 'network', count: 2 },
        { word: 'algorithm', count: 1 },
      ],
    };
    const first = await getTopics(fs, memo.cached);
    const second = await getTopics(fs, memo.cached);
    assert.deepEqual(first.body, expected);
    assert.deepEqual(second.body, expected); // identical payload served from the cache
    // The factory — which now also builds STOP_WORDS — ran only on the miss, not the hit.
    assert.equal(memo.calls(), 1);
  });
});
