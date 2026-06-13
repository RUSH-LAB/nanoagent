import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS, so load the REAL module via createRequire (the
// same way the sibling walk suite next-stats-content-walk-aggregations.test.mjs does)
// and reuse its ctx-mocking shape.
//
// This is an ADD-ONLY characterization test. It pins the CURRENT, correct behavior of
// three GET aggregation handlers that walk the content/ tree and had ZERO coverage
// before this file: GET /api/content-calendar, GET /api/content-audience, and
// GET /api/content-coverage. These are DIFFERENT handlers from the content-walk stats
// aggregations (heading-depth, word-leaderboard, reading-time) pinned in the sibling
// suite; this file is fully disjoint. Each wraps a recursive content scan in
// cached(key, ttl, fn) and reads the filesystem only through ctx.fs, with a try/catch
// that returns a 500 on a throwing fs. The handlers read no randomness or network, so
// every asserted value is fully determined by the seeded in-memory fs tree (the one
// clock read, content-calendar's statSync mtime fallback, is fed a fixed Date). No
// source file is touched.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Fixed mtime fed to content-calendar's statSync fallback (used only when a file has no
// frontmatter date). toISOString().slice(0, 7) yields the year-month bucket '2023-12',
// so the fallback is deterministic and clock independent.
const STAT_MTIME = new Date('2023-12-25T00:00:00.000Z');

// In-memory fs stub built from a flat `${rel-from-PROJECT_ROOT}: content` map. It
// synthesizes the directory tree so readdirSync({withFileTypes:true}) returns
// Dirent-like entries (name + isDirectory()) and readFileSync serves the fixture.
// readdirSync of a directory that was never declared throws ENOENT. statSync returns a
// controlled mtime so content-calendar's no-date fallback is deterministic. Listing
// order is the declaration order; every assertion below is either order independent
// (aggregate counts) or re-sorted by the handler, so the tests do not depend on a
// platform fs ordering.
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
    statSync() { return { mtime: STAT_MTIME }; },
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
// cached store stays observable so a test can prove a thrown scan caches nothing. For
// content-coverage the first fs touch is the references.yaml read, so readFileSync
// throwing is enough to reach the 500.
function throwingHarness() {
  const { cached, store, calls } = makeCached();
  const fs = {
    readdirSync() { throw new Error('disk failure'); },
    readFileSync() { throw new Error('disk failure'); },
    statSync() { throw new Error('disk failure'); },
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

// Build a body of exactly n whitespace-separated words. The audience handler counts
// words as text.split(/\s+/).filter(w => w.length > 0).length, and each lowercase
// 'word' token scores exactly one syllable under the handler's heuristic, so an
// n-word body has n words and n syllables, making the Flesch-Kincaid grade a simple
// function of n.
const words = n => Array(n).fill('word').join(' ');

describe('GET /api/content-calendar (cached("content-calendar", 60000))', () => {
  // Frontmatter dates capture YEAR-MONTH only even when the source carries a full day:
  // jan-a and jan-b both land in 2024-01. jan-b has no title in its frontmatter, so it
  // falls back to the filename. nodate.md has no frontmatter date, so it falls back to
  // the statSync mtime month (2023-12). The dot-prefixed, underscore-prefixed, and
  // wrong-extension entries are skipped entirely.
  const CAL = {
    'content/jan-a.md': '---\ndate: 2024-01-15\ntitle: January A\n---\nbody text',
    'content/jan-b.md': '---\ndate: "2024-01-20"\n---\nbody text',
    'content/feb.md': '---\ndate: 2024-02-03\ntitle: February Post\n---\nbody text',
    'content/nodate.md': 'no frontmatter at all, body only',
    'content/sub/mar.md': '---\ndate: 2024-03-01\n---\nbody text',
    'content/skip.txt': 'wrong ext ignored',
    'content/_draft.md': '---\ndate: 2024-09-09\n---\nx',
    'content/.hidden.md': '---\ndate: 2024-09-09\n---\nx',
  };

  it('groups pages by ascending month with year-month dates, title and statSync fallbacks', async () => {
    const res = await invoke('/api/content-calendar', harness(CAL));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.calendar, [
      { month: '2023-12', count: 1, pages: [{ path: 'content/nodate.md', title: 'nodate' }] },
      { month: '2024-01', count: 2, pages: [
        { path: 'content/jan-a.md', title: 'January A' },
        { path: 'content/jan-b.md', title: 'jan-b' },
      ] },
      { month: '2024-02', count: 1, pages: [{ path: 'content/feb.md', title: 'February Post' }] },
      { month: '2024-03', count: 1, pages: [{ path: 'content/sub/mar.md', title: 'mar' }] },
    ]);
    assert.equal(res.payload.totalMonths, 4);
    assert.deepEqual(Object.keys(res.payload), ['calendar', 'totalMonths']);
  });

  it('caps each month pages array at 5 while count reflects the full total', async () => {
    // Seven files all dated in 2024-05, so count is 7 but pages is sliced to the first 5.
    const cap = {};
    for (let i = 1; i <= 7; i++) cap['content/p' + i + '.md'] = '---\ndate: 2024-05-0' + i + '\n---\nbody';
    const res = await invoke('/api/content-calendar', harness(cap));
    assert.equal(res.status, 200);
    assert.equal(res.payload.totalMonths, 1);
    assert.equal(res.payload.calendar[0].month, '2024-05');
    assert.equal(res.payload.calendar[0].count, 7);
    assert.equal(res.payload.calendar[0].pages.length, 5);
    assert.deepEqual(res.payload.calendar[0].pages[0], { path: 'content/p1.md', title: 'p1' });
  });

  it('routes through cached("content-calendar", 60000) and short-circuits without re-walking', async () => {
    const h = harness({ 'content/x.md': '---\ndate: 2024-07-01\ntitle: X\n---\nb' });
    const res1 = await invoke('/api/content-calendar', h);
    assert.equal(res1.status, 200);
    assert.equal(h.calls[0].key, 'content-calendar');
    assert.equal(h.calls[0].ttl, 60000);
    assert.ok(h.store.has('content-calendar'));
    // A second call with an fs that throws on any access must still return the cached
    // value, proving the handler served the memoized result instead of re-walking.
    const poisoned = {
      fs: {
        readdirSync() { throw new Error('should not walk'); },
        readFileSync() { throw new Error('should not walk'); },
        statSync() { throw new Error('should not walk'); },
      },
      cached: h.cached,
    };
    const res2 = await invoke('/api/content-calendar', poisoned);
    assert.deepEqual(res2, res1);
    assert.equal(h.calls.length, 2);
  });

  it('returns 500 {error: "Calendar failed"} when the scan throws, caching nothing', async () => {
    const h = throwingHarness();
    const res = await invoke('/api/content-calendar', h);
    assert.deepEqual(res, { status: 500, payload: { error: 'Calendar failed' } });
    assert.equal(h.store.size, 0);
  });
});

describe('GET /api/content-audience (cached("content-audience", 120000))', () => {
  // Each document is a plain run of n 'word' tokens (no frontmatter), so its grade is a
  // pure function of n: b20 -> beginner, i35 -> intermediate, a45 -> advanced,
  // e55 -> expert. tiny.md has only 10 words (< 20), so the handler skips it entirely.
  // With no surviving title: line, every title falls back to the filename. The
  // dot-prefixed, underscore-prefixed, and wrong-extension entries are skipped.
  const AUD = {
    'content/b20.md': words(20),
    'content/i35.md': words(35),
    'content/a45.md': words(45),
    'content/e55.md': words(55),
    'content/tiny.md': words(10),
    'content/skip.txt': words(99),
    'content/_draft.md': words(99),
    'content/.hidden.md': words(99),
  };

  it('buckets each file by Flesch-Kincaid grade, skipping documents under 20 words', async () => {
    const h = harness(AUD);
    const res = await invoke('/api/content-audience', h);
    assert.equal(res.status, 200);
    // counts are the full per-level lengths; tiny.md (10 words) is absent from every bucket.
    assert.deepEqual(res.payload.counts, { beginner: 1, intermediate: 1, advanced: 1, expert: 1 });
    assert.deepEqual(res.payload.beginner, [{ path: 'content/b20.md', title: 'b20', grade: 4 }]);
    assert.deepEqual(res.payload.intermediate, [{ path: 'content/i35.md', title: 'i35', grade: 9.9 }]);
    assert.deepEqual(res.payload.advanced, [{ path: 'content/a45.md', title: 'a45', grade: 13.8 }]);
    assert.deepEqual(res.payload.expert, [{ path: 'content/e55.md', title: 'e55', grade: 17.7 }]);
    assert.deepEqual(Object.keys(res.payload), ['counts', 'beginner', 'intermediate', 'advanced', 'expert']);
    assert.equal(h.calls[0].key, 'content-audience');
    assert.equal(h.calls[0].ttl, 120000);
  });

  it('reads the title from a title: line that survives frontmatter stripping', async () => {
    // The handler strips a leading frontmatter block before reading the title, so a
    // title that lived only inside frontmatter would be lost. Here the document has no
    // such block, so its title: line survives and is used verbatim.
    const res = await invoke('/api/content-audience', harness({
      'content/titled.md': 'title: Custom Title\n' + words(25),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.counts, { beginner: 0, intermediate: 1, advanced: 0, expert: 0 });
    assert.deepEqual(res.payload.intermediate, [{ path: 'content/titled.md', title: 'Custom Title', grade: 8.4 }]);
  });

  it('counts the full level before slicing each level array to 10', async () => {
    // Twelve identical 20-word beginner documents: the count stays 12 while the returned
    // beginner array is sliced to the first 10.
    const slice = {};
    for (let i = 1; i <= 12; i++) slice['content/s' + String(i).padStart(2, '0') + '.md'] = words(20);
    const res = await invoke('/api/content-audience', harness(slice));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.counts, { beginner: 12, intermediate: 0, advanced: 0, expert: 0 });
    assert.equal(res.payload.beginner.length, 10);
    assert.deepEqual(res.payload.beginner[0], { path: 'content/s01.md', title: 's01', grade: 4 });
    assert.deepEqual(res.payload.beginner[9], { path: 'content/s10.md', title: 's10', grade: 4 });
  });

  it('returns 500 {error: "Audience analysis failed"} when the scan throws, caching nothing', async () => {
    const h = throwingHarness();
    const res = await invoke('/api/content-audience', h);
    assert.deepEqual(res, { status: 500, payload: { error: 'Audience analysis failed' } });
    assert.equal(h.store.size, 0);
  });
});

describe('GET /api/content-coverage (cached("content-coverage", 120000))', () => {
  // references.yaml seeds three venues: ICML (ref1, ref2), NeurIPS (ref3), and the
  // Unknown fallback for ref4 (no venue). Cited counts are per file: a file contributes
  // one increment per distinct cited key present in refs, so the same key cited twice in
  // one file counts once (doc-dup), while the same key cited across two files counts
  // twice. coverage is cited/references as a percentage and can exceed 100.
  const COV_YAML = [
    'ref1:',
    '  title: First Paper',
    '  venue: ICML',
    'ref2:',
    '  title: Second Paper',
    '  venue: ICML',
    'ref3:',
    '  title: Third Paper',
    '  venue: NeurIPS',
    'ref4:',
    '  title: Fourth Paper',
    '',
  ].join('\n');

  // QUIRK: content-coverage skips ONLY dot-prefixed names. Unlike content-calendar and
  // content-audience, it does NOT skip underscore-prefixed names, so _underscore.md IS
  // scanned and its [@ref3] citation counts toward NeurIPS. The dot-prefixed .hidden.md
  // and the wrong-extension skip.txt are still ignored.
  const COV = {
    'bibliography/references.yaml': COV_YAML,
    'content/doc1.md': 'see [@ref1] and [@ref2]',
    'content/doc2.md': 'see [@ref3]',
    'content/doc3.md': 'see [@ref4] and [@nope]',
    'content/doc-dup.md': '[@ref1] repeated [@ref1]',
    'content/_underscore.md': 'cites [@ref3]',
    'content/.hidden.md': 'cites [@ref2]',
    'content/skip.txt': 'cites [@ref1]',
  };

  it('maps venues to reference and citation coverage, scanning underscore-prefixed files', async () => {
    const h = harness(COV);
    const res = await invoke('/api/content-coverage', h);
    assert.equal(res.status, 200);
    // ICML cited = 3 (doc1 contributes ref1 + ref2, doc-dup contributes ref1 once after
    // the per-file Set dedups its repeat). NeurIPS cited = 2 (doc2 plus the scanned
    // _underscore.md). Unknown cited = 1 (doc3's ref4; [@nope] is not in refs). The list
    // is sorted by references descending, with the references=1 tie kept in venue
    // insertion order (NeurIPS before Unknown).
    assert.deepEqual(res.payload.coverage, [
      { venue: 'ICML', references: 2, cited: 3, coverage: 150 },
      { venue: 'NeurIPS', references: 1, cited: 2, coverage: 200 },
      { venue: 'Unknown', references: 1, cited: 1, coverage: 100 },
    ]);
    assert.equal(res.payload.total, 3);
    assert.deepEqual(Object.keys(res.payload), ['coverage', 'total']);
    assert.equal(h.calls[0].key, 'content-coverage');
    assert.equal(h.calls[0].ttl, 120000);
  });

  it('returns 500 {error: "Coverage map failed"} when references.yaml read throws, caching nothing', async () => {
    const h = throwingHarness();
    const res = await invoke('/api/content-coverage', h);
    assert.deepEqual(res, { status: 500, payload: { error: 'Coverage map failed' } });
    assert.equal(h.store.size, 0);
  });
});
