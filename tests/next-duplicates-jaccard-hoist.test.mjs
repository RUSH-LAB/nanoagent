import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// analysis-admin.js is CommonJS; load it via createRequire the way the sibling
// route tests do (next-content-health-pageids-hoist.test.mjs and friends) and
// reuse the same in-memory-fs ctx-mocking shape. These tests drive the REAL
// GET /api/analytics/duplicates handler over a virtual content tree, no server.
const require = createRequire(import.meta.url);
const analysisAdminRoutes = require('../server/routes/analysis-admin.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_ADMIN_PATH = path.join(__dirname, '..', 'server', 'routes', 'analysis-admin.js');

const PROJECT_ROOT = '/proj';

// ── Why this hoist is behavior-preserving ───────────────────────────────────
// The handler builds `fingerprints` via scanFiles BEFORE the all-pairs loop and
// never mutates it inside the loop (the only write is pairs.push). So for a fixed
// outer index i, fingerprints[i].words, its .size, and fingerprints[i].path are
// constant across the entire inner j loop. The change reads them once per i:
//   const a = fingerprints[i].words;
//   const aSize = a.size;
//   const pathI = fingerprints[i].path;
// then the inner loop uses `aSize` in the union and `pathI` for file1. The
// intersection loop still iterates the same Set `a`, the Jaccard math, the > 0.5
// threshold, the Math.round(... * 1000) / 1000, and the descending sort are all
// untouched. Therefore the returned duplicates array (paths, similarity values,
// and order) is byte-identical. The fixture below has two near-duplicate pairs at
// different similarities (so the sort must reorder them) plus a fully disjoint
// file (so every cross pair is excluded by the threshold).

// In-memory content tree under <PROJECT_ROOT>/content. A string value is a file's
// contents; an object value is a directory. JS preserves insertion order for these
// non-integer keys, so the directory listing (and thus fingerprint order) is
// deterministic, exactly the declared order below.
//
// Bodies are plain lowercase words separated by single spaces (no punctuation, no
// markdown), so each file's word Set is exactly the listed words after the handler
// strips frontmatter, lowercases, splits on whitespace, and dedupes into a Set.
function buildContentTree() {
  const file = (title, body) => ['---', `title: ${title}`, '---', '', body, ''].join('\n');
  return {
    // Low-similarity near-duplicate pair (declared first so it is compared first).
    //   L1 = {alpha,beta,gamma,delta,epsilon,zeta,eta,theta}            (size 8)
    //   L2 = {alpha,beta,gamma,delta,epsilon,zeta,iota,kappa}           (size 8)
    //   intersection = {alpha,beta,gamma,delta,epsilon,zeta}            (6)
    //   union = 8 + 8 - 6 = 10  ->  Jaccard = 6/10 = 0.6  (> 0.5, kept)
    'similar-low-1.md': file('Low One', 'alpha beta gamma delta epsilon zeta eta theta'),
    'similar-low-2.md': file('Low Two', 'alpha beta gamma delta epsilon zeta iota kappa'),
    // High-similarity near-duplicate pair (declared second). "the" repeats but the
    // Set dedupes it, so each side has 9 unique words.
    //   H1 = {the,quick,brown,fox,jumps,over,lazy,dog,today}            (size 9)
    //   H2 = {the,quick,brown,fox,jumps,over,lazy,cat,today}            (size 9)
    //   intersection = {the,quick,brown,fox,jumps,over,lazy,today}      (8)
    //   union = 9 + 9 - 8 = 10  ->  Jaccard = 8/10 = 0.8  (> 0.5, kept)
    'similar-high-1.md': file('High One', 'the quick brown fox jumps over the lazy dog today'),
    'similar-high-2.md': file('High Two', 'the quick brown fox jumps over the lazy cat today'),
    // Fully disjoint vocabulary: shares no word with any other file, so every pair
    // it takes part in has similarity 0 and is excluded by the > 0.5 threshold.
    'distinct.md': file('Distinct', 'completely unrelated vocabulary with totally separate wording everywhere here'),
  };
}

// A counting in-memory fs serving the virtual tree. The duplicates handler calls
// existsSync, readdirSync ({withFileTypes:true}), and readFileSync; the counters
// let a test prove a cache hit performs no fresh disk walk.
function makeFs(tree) {
  const contentDir = path.join(PROJECT_ROOT, 'content');
  const counts = { existsSync: 0, readdirSync: 0, readFileSync: 0 };
  function nodeAt(absPath) {
    const rel = path.relative(contentDir, absPath);
    if (rel === '') return tree;
    let node = tree;
    for (const seg of rel.split(path.sep)) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[seg];
    }
    return node;
  }
  const fs = {
    existsSync(p) {
      counts.existsSync++;
      const node = nodeAt(p);
      return node !== undefined && node !== null;
    },
    readdirSync(dir) {
      counts.readdirSync++;
      const node = nodeAt(dir);
      if (node === null || typeof node !== 'object') {
        const err = new Error(`ENOENT: not a directory, ${dir}`);
        err.code = 'ENOENT';
        throw err;
      }
      return Object.keys(node).map((name) => ({
        name,
        isDirectory: () => typeof node[name] === 'object',
      }));
    },
    readFileSync(filePath) {
      counts.readFileSync++;
      const node = nodeAt(filePath);
      if (typeof node !== 'string') {
        const err = new Error(`ENOENT: no such file, ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return node;
    },
  };
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) mirroring the server.js helper: run fn and store
// on a miss, return the stored value untouched on a hit. Records every call so a
// test can pin the exact key and TTL the handler passes.
function makeMemoCached() {
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

// A non-memoizing pass-through cached: always runs fn(), reproducing the exact
// pre-cache code path so the assertion is never served a stale cached() value.
function makePassThroughCached() {
  const calls = [];
  const cached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
  return { cached, calls };
}

// Drive GET /api/analytics/duplicates with a mocked ctx and capture what the
// handler hands to json(res, status, payload).
async function invoke({ fs, cached }) {
  const pathname = '/api/analytics/duplicates';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await analysisAdminRoutes(req, res, url, pathname, ctx);
  return captured;
}

// Independent reference, hand-derived from the fixture (NOT a re-run of the
// handler). Only two pairs clear the > 0.5 threshold: the high pair (0.8) and the
// low pair (0.6). They are generated in scan order as [low(0.6), high(0.8)], so the
// descending-by-similarity sort must reorder them to [high(0.8), low(0.6)]. Every
// other pair (anything touching distinct.md, or high vs low) shares no word and is
// excluded. relPath = path.relative('/proj', '/proj/content/<file>') = content/<file>.
const EXPECTED_DUPLICATES = [
  { file1: 'content/similar-high-1.md', file2: 'content/similar-high-2.md', similarity: 0.8 },
  { file1: 'content/similar-low-1.md', file2: 'content/similar-low-2.md', similarity: 0.6 },
];

describe('GET /api/analytics/duplicates (fingerprints[i] reads hoisted out of the inner Jaccard loop)', () => {
  it('returns the duplicates payload deep-equal to the independent reference computation', async () => {
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    assert.equal(r.status, 200);
    // Whole-object equality against the hand-derived reference: paths and values.
    assert.deepEqual(r.payload, { duplicates: EXPECTED_DUPLICATES });
    // Same values AND same key ordering as the response shape.
    assert.equal(
      JSON.stringify(r.payload),
      JSON.stringify({ duplicates: EXPECTED_DUPLICATES }),
    );
  });

  it('orders pairs by descending similarity (the sort reorders scan order)', async () => {
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    const sims = r.payload.duplicates.map((p) => p.similarity);
    assert.deepEqual(sims, [0.8, 0.6]);
    // Strictly descending, independent of the array literal above.
    for (let i = 1; i < sims.length; i++) {
      assert.ok(sims[i - 1] >= sims[i], 'pairs must be sorted by descending similarity');
    }
    // The first pair is the high-similarity one even though it is scanned last.
    assert.deepEqual(r.payload.duplicates[0], {
      file1: 'content/similar-high-1.md',
      file2: 'content/similar-high-2.md',
      similarity: 0.8,
    });
  });

  it('keeps only pairs above the 0.5 threshold and excludes the disjoint file', async () => {
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    // Exactly the two near-duplicate pairs survive; nothing else.
    assert.equal(r.payload.duplicates.length, 2);
    assert.ok(r.payload.duplicates.every((p) => p.similarity > 0.5));
    // distinct.md shares no word with any file, so it never appears in a pair.
    const mentioned = new Set(r.payload.duplicates.flatMap((p) => [p.file1, p.file2]));
    assert.ok(!mentioned.has('content/distinct.md'), 'disjoint file must not appear in any pair');
    // The high and low pairs never cross-match (greek vs english vocabularies).
    assert.ok(
      !r.payload.duplicates.some(
        (p) => /high/.test(p.file1) !== /high/.test(p.file2),
      ),
      'high and low pairs must not cross-match',
    );
  });

  it('routes through cached("analytics:duplicates", 60000) and serves a repeat from cache with no re-walk', async () => {
    const { fs, counts } = makeFs(buildContentTree());
    const { cached, store, calls } = makeMemoCached();

    const first = await invoke({ fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, { duplicates: EXPECTED_DUPLICATES });
    assert.ok(counts.readdirSync >= 1, 'first request walks the tree');
    assert.ok(counts.readFileSync >= 1, 'first request reads files');
    const afterFirst = { readdirSync: counts.readdirSync, readFileSync: counts.readFileSync };

    // Cache key and TTL are exactly as the handler passes them.
    assert.equal(calls[0].key, 'analytics:duplicates');
    assert.equal(calls[0].ttl, 60000);

    const second = await invoke({ fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(counts.readdirSync, afterFirst.readdirSync, 'no repeat readdirSync on cache hit');
    assert.equal(counts.readFileSync, afterFirst.readFileSync, 'no repeat readFileSync on cache hit');
    assert.equal(store.size, 1, 'one cache entry under the analytics:duplicates key');
  });

  it('is byte-identical whether memoized or computed fresh (cache changes nothing)', async () => {
    const fresh = await invoke({ ...makeFs(buildContentTree()), ...makePassThroughCached() });
    const memo = await invoke({ ...makeFs(buildContentTree()), ...makeMemoCached() });
    assert.equal(
      JSON.stringify(memo.payload),
      JSON.stringify(fresh.payload),
      'memoizing must not change the payload bytes',
    );
    assert.equal(JSON.stringify(fresh.payload), JSON.stringify({ duplicates: EXPECTED_DUPLICATES }));
  });
});

describe('analysis-admin.js source: the duplicates handler hoists the fingerprints[i] reads', () => {
  it('hoists words/size/path to the outer loop and drops the inner-loop re-reads', () => {
    const src = readFileSync(ANALYSIS_ADMIN_PATH, 'utf8');
    // Slice just the GET /api/analytics/duplicates handler block: from its pathname
    // guard up to the next handler (GET /api/analytics/orphans). Both markers ASCII.
    const start = src.indexOf("pathname === '/api/analytics/duplicates'");
    assert.ok(start !== -1, 'duplicates handler not found in source');
    const end = src.indexOf("pathname === '/api/analytics/orphans'", start);
    assert.ok(end !== -1, 'orphans handler (block end marker) not found in source');
    const block = src.slice(start, end);

    // The outer-i-invariant reads are hoisted above the inner j loop.
    assert.ok(block.includes('const a = fingerprints[i].words'), 'expected hoisted "const a = fingerprints[i].words"');
    assert.ok(block.includes('const aSize = a.size'), 'expected hoisted "const aSize = a.size"');
    assert.ok(
      block.includes('const pathI = fingerprints[i].path'),
      'expected hoisted "const pathI = fingerprints[i].path"',
    );
    // The inner loop now reads the hoisted bindings.
    assert.ok(block.includes('const union = aSize + b.size - intersection'), 'union must read the hoisted aSize');
    assert.ok(block.includes('file1: pathI'), 'pushed file1 must read the hoisted pathI');

    // The old per-iteration re-reads are gone.
    assert.ok(
      !block.includes('a.size + b.size - intersection'),
      'old inner re-read "a.size + b.size - intersection" must be gone',
    );
    assert.ok(
      !block.includes('file1: fingerprints[i].path'),
      'old inner re-read "file1: fingerprints[i].path" must be gone',
    );
    // The j-dependent reads stay inside the loop, untouched.
    assert.ok(block.includes('const b = fingerprints[j].words'), 'b must still be read per j');
    assert.ok(block.includes('file2: fingerprints[j].path'), 'file2 must still read fingerprints[j].path');
  });
});
