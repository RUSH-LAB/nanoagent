import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS, so load the REAL module via createRequire (the
// same way the sibling content/ walk suite next-content-b-update-suggestions.test.mjs
// does) and reuse its ctx-mocking shape.
//
// This is an ADD-ONLY characterization test. It pins the CURRENT, correct behavior of
// three GET aggregation handlers that walk the content/ tree and had ZERO coverage
// before this file: GET /api/stats/heading-depth, GET /api/stats/word-leaderboard, and
// GET /api/stats/reading-time. Each wraps a cached(key, ttl, fn) recursive walk that
// skips dotfiles, underscore-prefixed names, and non-ALLOWED_EXTS files, then derives a
// deterministic success shape, with a try/catch that returns a 500 on a throwing fs.
// The handlers read no clock, randomness, or network, so every asserted value is fully
// determined by the seeded in-memory fs tree. No source file is touched.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from a flat `${rel-from-PROJECT_ROOT}: content` map. It
// synthesizes the directory tree so readdirSync({withFileTypes:true}) returns
// Dirent-like entries (name + isDirectory()) and readFileSync serves the fixture.
// readdirSync of a directory that was never declared throws ENOENT, which is the hook
// the 500 path relies on. Listing order is the declaration order; every assertion below
// is order independent (aggregate counts) or re-sorted by the handler, so the tests do
// not depend on a platform fs ordering.
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

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js helper:
// run fn and store on a miss, return the stored value on a hit, store nothing when fn
// throws (so a 500 stays uncached). Every call records its key and ttl so a test can pin
// the exact arguments the handler passes.
function makeCached() {
  const store = new Map();
  const calls = [];
  const cached = (key, ttl, fn) => {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store, calls };
}

// Build a fresh ctx bundle for one fixture: the in-memory fs plus a memoizing cached and
// its observable store/calls.
function harness(fileMap) {
  const fs = makeFs(fileMap);
  const { cached, store, calls } = makeCached();
  return { fs, cached, store, calls };
}

// A harness whose fs throws on every access, driving the handler's outer catch. The
// cached store stays observable so a test can prove a thrown scan caches nothing.
function throwingHarness() {
  const { cached, store, calls } = makeCached();
  const fs = {
    readdirSync() { throw new Error('disk failure'); },
    readFileSync() { throw new Error('disk failure'); },
  };
  return { fs, cached, store, calls };
}

// Invoke a GET handler with a mocked ctx and capture the response handed to
// json(res, status, payload).
async function invoke(pathname, { fs, cached }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// Build a body of exactly n whitespace-separated words. Word count throughout these
// handlers is content.split(/\s+/).filter(Boolean).length, so n single-space-joined
// tokens contribute exactly n.
const words = n => Array(n).fill('word').join(' ');

describe('GET /api/stats/heading-depth (cached("heading-depth", 60000))', () => {
  // Heading lines match /^(#{1,6})\s+/gm, so the depth is the count of leading hashes on
  // an anchored line. a.md carries depths 1, 2, 2, 3; sub/c.md carries 4, 5, 6; b.md has
  // only an inline hash (not anchored) so it counts as a file without headings. The
  // dot-prefixed, underscore-prefixed, and wrong-extension entries are skipped entirely.
  const HD = {
    'content/a.md': '# H1\n## H2\n## H2b\n### H3\nsome text',
    'content/b.md': 'text with # inline hash\nmore text',
    'content/sub/c.md': '#### H4\n##### H5\n###### H6\nbody',
    'content/skip.txt': 'ignored wrong ext # not a heading',
    'content/_draft.md': '# Hidden\n## Should not count',
    'content/.hidden.md': '# Dot\n## Skip',
  };

  it('returns the exact depth distribution and file tallies for the fixture tree', async () => {
    const res = await invoke('/api/stats/heading-depth', harness(HD));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.depthCounts, { 1: 1, 2: 2, 3: 1, 4: 1, 5: 1, 6: 1 });
    assert.equal(res.payload.totalHeadings, 7);
    assert.equal(res.payload.filesWithHeadings, 2);
    assert.equal(res.payload.filesWithoutHeadings, 1);
    // Exact key set and order, so a refactor cannot quietly add, drop, or reorder fields.
    assert.deepEqual(Object.keys(res.payload), ['depthCounts', 'totalHeadings', 'filesWithHeadings', 'filesWithoutHeadings']);
  });

  it('routes through cached() under key "heading-depth" with a 60000 ms TTL', async () => {
    const h = harness(HD);
    await invoke('/api/stats/heading-depth', h);
    assert.ok(h.calls.length >= 1, 'the handler routes through cached()');
    assert.equal(h.calls[0].key, 'heading-depth');
    assert.equal(h.calls[0].ttl, 60000);
  });

  it('returns 500 {error: "Heading analysis failed"} when the scan throws, caching nothing', async () => {
    const h = throwingHarness();
    const res = await invoke('/api/stats/heading-depth', h);
    assert.deepEqual(res, { status: 500, payload: { error: 'Heading analysis failed' } });
    assert.equal(h.store.size, 0);
  });
});

describe('GET /api/stats/word-leaderboard (cached("word-leaderboard", 60000))', () => {
  // Distinct word counts (12, 9, 6, 3) make the descending sort unambiguous. beta.md
  // carries a frontmatter title block, so its title is read from the block rather than
  // the filename; the others fall back to the filename without extension. The
  // dot-prefixed, underscore-prefixed, and wrong-extension entries are skipped.
  const WL = {
    'content/alpha.md': 'a b c d e f g h i j k l',
    'content/beta.md': '---\ntitle: Beta Heading\n---\nw x y z',
    'content/gamma.md': 'p q r s t u',
    'content/sub/delta.md': 'm n o',
    'content/skip.txt': 'x y z',
    'content/_draft.md': 'p q r',
    'content/.hidden.md': 's t u',
  };

  it('ranks longest descending, shortest as the reversed tail, with total and rounded average', async () => {
    const h = harness(WL);
    const res = await invoke('/api/stats/word-leaderboard', h);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.longest, [
      { path: 'content/alpha.md', title: 'alpha', wordCount: 12 },
      { path: 'content/beta.md', title: 'Beta Heading', wordCount: 9 },
      { path: 'content/gamma.md', title: 'gamma', wordCount: 6 },
      { path: 'content/sub/delta.md', title: 'delta', wordCount: 3 },
    ]);
    // shortest is leaderboard.slice(-10).reverse(): the four-entry list reversed into
    // ascending word-count order.
    assert.deepEqual(res.payload.shortest, [
      { path: 'content/sub/delta.md', title: 'delta', wordCount: 3 },
      { path: 'content/gamma.md', title: 'gamma', wordCount: 6 },
      { path: 'content/beta.md', title: 'Beta Heading', wordCount: 9 },
      { path: 'content/alpha.md', title: 'alpha', wordCount: 12 },
    ]);
    assert.equal(res.payload.total, 4);
    // Math.round((12 + 9 + 6 + 3) / 4) = Math.round(7.5) = 8 (rounds up at the half).
    assert.equal(res.payload.avgWordCount, 8);
    assert.deepEqual(Object.keys(res.payload), ['longest', 'shortest', 'total', 'avgWordCount']);
    assert.equal(h.calls[0].key, 'word-leaderboard');
    assert.equal(h.calls[0].ttl, 60000);
  });

  it('caps longest at 20 and shortest at 10 over a larger tree (slice boundaries)', async () => {
    // 22 files with word counts 1..22, so the descending leaderboard has 22 entries.
    const big = {};
    for (let n = 1; n <= 22; n++) big['content/w' + String(n).padStart(2, '0') + '.md'] = words(n);
    const res = await invoke('/api/stats/word-leaderboard', harness(big));
    assert.equal(res.status, 200);
    assert.equal(res.payload.longest.length, 20);
    assert.deepEqual(res.payload.longest[0], { path: 'content/w22.md', title: 'w22', wordCount: 22 });
    assert.deepEqual(res.payload.longest[19], { path: 'content/w03.md', title: 'w03', wordCount: 3 });
    assert.equal(res.payload.shortest.length, 10);
    assert.deepEqual(res.payload.shortest[0], { path: 'content/w01.md', title: 'w01', wordCount: 1 });
    assert.deepEqual(res.payload.shortest[9], { path: 'content/w10.md', title: 'w10', wordCount: 10 });
    assert.equal(res.payload.total, 22);
    // Math.round((1 + 2 + ... + 22) / 22) = Math.round(253 / 22) = Math.round(11.5) = 12.
    assert.equal(res.payload.avgWordCount, 12);
  });

  it('returns zero counts and a zero average for an empty content tree (Math.max(len, 1) guard)', async () => {
    // The content directory exists but every entry is skipped (a dotfile), so the
    // leaderboard is empty and the average divides by Math.max(0, 1) instead of zero.
    const res = await invoke('/api/stats/word-leaderboard', harness({ 'content/.keep': 'ignored' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, { longest: [], shortest: [], total: 0, avgWordCount: 0 });
  });

  it('returns 500 {error: "Leaderboard failed"} when the scan throws, caching nothing', async () => {
    const h = throwingHarness();
    const res = await invoke('/api/stats/word-leaderboard', h);
    assert.deepEqual(res, { status: 500, payload: { error: 'Leaderboard failed' } });
    assert.equal(h.store.size, 0);
  });
});

describe('GET /api/stats/reading-time (cached("reading-time-stats", 60000))', () => {
  // Words bucket under the first directory beneath content/. blog/nested/p3.md still
  // counts toward 'blog' because the recursion keeps the first level name once set
  // (dirName || entry.name). Per-directory totals: blog = 600 + 250 + 50 = 900,
  // notes = 400. The wrong-extension and underscore-prefixed entries add nothing.
  const RT = {
    'content/blog/p1.md': words(600),
    'content/blog/p2.md': words(250),
    'content/blog/nested/p3.md': words(50),
    'content/notes/n1.md': words(400),
    'content/blog/skip.txt': words(999),
    'content/blog/_d.md': words(999),
  };

  it('totals words, ceils the minutes, rounds the hours, and buckets per top-level directory', async () => {
    const h = harness(RT);
    const res = await invoke('/api/stats/reading-time', h);
    assert.equal(res.status, 200);
    // totalMinutes = Math.ceil(1300 / 200) = 7; totalHours = Math.round(7 / 60 * 10) / 10 = 0.1.
    assert.deepEqual(res.payload, {
      totalWords: 1300,
      totalReadingMinutes: 7,
      totalReadingHours: 0.1,
      directories: [
        // blog (900 words) sorts ahead of notes (400). blog minutes = ceil(900/200) = 5,
        // hours = round(900/200/60*10)/10 = 0.1. notes minutes = ceil(400/200) = 2, hours = 0.
        { name: 'blog', words: 900, readingTimeMinutes: 5, readingTimeHours: 0.1 },
        { name: 'notes', words: 400, readingTimeMinutes: 2, readingTimeHours: 0 },
      ],
    });
    assert.equal(h.calls[0].key, 'reading-time-stats');
    assert.equal(h.calls[0].ttl, 60000);
  });

  it('buckets files directly under content/ into the "root" directory', async () => {
    // A top-level file has no first-level directory name, so dirName || 'root' lands it
    // in a 'root' bucket alongside the named directory.
    const res = await invoke('/api/stats/reading-time', harness({
      'content/top.md': words(150),
      'content/guide/g1.md': words(500),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, {
      totalWords: 650,
      totalReadingMinutes: 4,
      totalReadingHours: 0.1,
      directories: [
        { name: 'guide', words: 500, readingTimeMinutes: 3, readingTimeHours: 0 },
        { name: 'root', words: 150, readingTimeMinutes: 1, readingTimeHours: 0 },
      ],
    });
  });

  it('returns 500 {error: "Reading time calculation failed"} when the scan throws, caching nothing', async () => {
    const h = throwingHarness();
    const res = await invoke('/api/stats/reading-time', h);
    assert.deepEqual(res, { status: 500, payload: { error: 'Reading time calculation failed' } });
    assert.equal(h.store.size, 0);
  });
});
