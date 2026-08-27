import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// misc-tools.js is CommonJS; load it via createRequire the way the sibling route
// tests do (next-content-health-pageids-hoist.test.mjs, next-quicknote-cache.test.mjs)
// and reuse the same in-memory-fs ctx-mocking shape. These tests drive the REAL
// GET /api/content-health handler over a virtual content tree, with no server.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../server/routes/misc-tools.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISC_TOOLS_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'server', 'routes', 'misc-tools.js');

const PROJECT_ROOT = '/proj';

// ── Why this hoist is behavior-preserving ───────────────────────────────────
// Inside `for (const link of allLinks)`, `target` is fixed for the whole
// iteration, so `'/' + target` is loop-invariant across the pageIdList scan. It
// was recomputed per page id in two places: once in the `.some(id => ... ||
// id.endsWith('/' + target))` membership probe and again, on the matched branch,
// in the `.find(id => ... || id.endsWith('/' + target))` resolution. Hoisting it
// once into `const slashTarget = '/' + target` changes nothing observable:
//   - `slashTarget === '/' + target` by construction, so each callback receives a
//     byte-identical argument;
//   - `String.prototype.endsWith` is pure, so `.some()` returns the same boolean
//     and `.find()` the same first match for every target;
//   - the `pageIds.has(target)` Set fast path still short-circuits first.
// Therefore brokenLinks, incomingLinks, the derived orphanPages, and every count
// in the returned health object are byte-identical. The fixture below exercises an
// exact `pageIds.has` hit, a suffix-only `.some`/`.find` fallback, and a genuinely
// broken link, so all three code paths the hoist touches are covered.

// In-memory content tree under <PROJECT_ROOT>/content. A string value is a file's
// contents; an object value is a directory. JS preserves insertion order for these
// non-integer keys, so directory listings (and thus Set insertion order) are
// deterministic: guide/ then concepts/ then index.md, and within each directory
// the files in declared order.
function buildContentTree() {
  return {
    guide: {
      // Exact-id link [[guide/setup]] plus a markdown link [..](/concepts/overview).
      'intro.md': [
        '---',
        'title: Intro Guide',
        '---',
        '',
        'See [[guide/setup]] and the [Overview](/concepts/overview).',
        '',
      ].join('\n'),
      // draft:true (the only draft). [[intro]] resolves ONLY by the suffix
      // fallback (no page id is exactly "intro"); [[totally-missing]] is broken.
      'setup.md': [
        '---',
        'title: Setup',
        'draft: true',
        '---',
        '',
        'Back to [[intro]]. Also [[totally-missing]].',
        '',
      ].join('\n'),
    },
    concepts: {
      // Exact-id link [[guide/intro]].
      'overview.md': [
        '---',
        'title: Concept Overview',
        '---',
        '',
        'Refers to [[guide/intro]].',
        '',
      ].join('\n'),
      // No outgoing links and nothing links to it, so it is the lone orphan.
      'appendix.md': [
        '---',
        'title: Appendix',
        '---',
        '',
        'A standalone note with no outgoing links.',
        '',
      ].join('\n'),
    },
    // id "index" contains the substring "index", so it is excluded from orphans
    // even though nothing links to it. Exact-id link [[guide/intro]].
    'index.md': [
      '---',
      'title: Home',
      '---',
      '',
      'Welcome. See [[guide/intro]].',
      '',
    ].join('\n'),
  };
}

// A counting in-memory fs serving the virtual tree. Only readdirSync (always
// called with {withFileTypes:true}) and readFileSync are exercised by the handler;
// the counters let a test prove a cache hit performs no fresh disk walk.
function makeFs(tree) {
  const contentDir = path.join(PROJECT_ROOT, 'content');
  const counts = { readdirSync: 0, readFileSync: 0 };
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
    readFileSync(file) {
      counts.readFileSync++;
      const node = nodeAt(file);
      if (typeof node !== 'string') {
        const err = new Error(`ENOENT: no such file, ${file}`);
        err.code = 'ENOENT';
        throw err;
      }
      return node;
    },
  };
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) mirroring the server/index.js helper: run fn and store
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

// Drive GET /api/content-health with a mocked ctx and capture what the handler
// hands to json(res, status, payload).
async function invoke({ fs, cached }) {
  const pathname = '/api/content-health';
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
  await miscToolsRoutes(req, res, url, pathname, ctx);
  return captured;
}

// Independent reference, hand-derived from the fixture (NOT a re-run of the
// handler). Derivation:
//   Pages, in scan/Set-insertion order: guide/intro, guide/setup,
//   concepts/overview, concepts/appendix, index  -> totalPages = 5.
//   Drafts: only setup.md is draft:true            -> draftCount = 1.
//   Links, in order (wiki before markdown per file):
//     1. guide/intro  -> "guide/setup"      (wiki)     exact hit  -> +1 guide/setup
//     2. guide/intro  -> "concepts/overview"(markdown) exact hit  -> +1 concepts/overview
//     3. guide/setup  -> "intro"            (wiki)     suffix only (slashTarget "/intro"
//                                                       matches guide/intro)  +1 guide/intro
//     4. guide/setup  -> "totally-missing"  (wiki)     BROKEN (no page, no suffix)
//     5. concepts/overview -> "guide/intro" (wiki)     exact hit  -> +1 guide/intro
//     6. index        -> "guide/intro"      (wiki)     exact hit  -> +1 guide/intro
//   totalLinks = 6.  brokenLinks = [link 4].  incomingLinks = {guide/setup:1,
//   concepts/overview:1, guide/intro:3}.  Orphans (no incoming, id has no "index"):
//   concepts/appendix only (index is excluded by the substring rule).
const EXPECTED_HEALTH = {
  totalPages: 5,
  draftCount: 1,
  brokenLinks: [{ source: 'guide/setup', target: 'totally-missing', type: 'wiki' }],
  brokenLinkCount: 1,
  orphanPages: [{ id: 'concepts/appendix', title: 'Appendix' }],
  orphanPageCount: 1,
  totalLinks: 6,
};

describe('GET /api/content-health (slashTarget hoisted once per link)', () => {
  it('returns the health object deep-equal to the independent reference computation', async () => {
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    assert.equal(r.status, 200);
    // Whole-object equality against the hand-derived reference.
    assert.deepEqual(r.payload, EXPECTED_HEALTH);

    // Field-by-field for clarity (mirrors the GOAL's enumerated fields).
    assert.equal(r.payload.totalPages, 5);
    assert.equal(r.payload.draftCount, 1);
    assert.deepEqual(r.payload.brokenLinks, [
      { source: 'guide/setup', target: 'totally-missing', type: 'wiki' },
    ]);
    assert.equal(r.payload.brokenLinkCount, 1);
    assert.deepEqual(r.payload.orphanPages, [{ id: 'concepts/appendix', title: 'Appendix' }]);
    assert.equal(r.payload.orphanPageCount, 1);
    assert.equal(r.payload.totalLinks, 6);
  });

  it('exercises all three resolution paths the slashTarget hoist touches', async () => {
    // The fixture is built so that:
    //   - the suffix-only link [[intro]] resolves (via .some + .find, through the
    //     hoisted slashTarget "/intro") to guide/intro, so guide/intro is NOT
    //     broken and NOT an orphan;
    //   - the exact links keep their pageIds.has fast-path hits;
    //   - [[totally-missing]] is the one broken link.
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    // Suffix fallback worked: guide/intro received incoming links (so it is absent
    // from orphans) and the only broken target is totally-missing.
    const orphanIds = r.payload.orphanPages.map((p) => p.id);
    assert.ok(!orphanIds.includes('guide/intro'), 'suffix-resolved target is not an orphan');
    assert.deepEqual(orphanIds, ['concepts/appendix']);
    assert.deepEqual(r.payload.brokenLinks.map((b) => b.target), ['totally-missing']);
    // The markdown-form link contributed too (concepts/overview is not an orphan).
    assert.ok(!orphanIds.includes('concepts/overview'), 'markdown link counted as incoming');
  });

  it('routes through cached("content-health", 60000) and serves a repeat from cache with no re-walk', async () => {
    const { fs, counts } = makeFs(buildContentTree());
    const { cached, store, calls } = makeMemoCached();

    const first = await invoke({ fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED_HEALTH);
    assert.ok(counts.readdirSync >= 1, 'first request walks the tree');
    assert.ok(counts.readFileSync >= 1, 'first request reads files');
    const afterFirst = { readdirSync: counts.readdirSync, readFileSync: counts.readFileSync };

    // Cache key and TTL are exactly as the handler passes them.
    assert.equal(calls[0].key, 'content-health');
    assert.equal(calls[0].ttl, 60000);

    const second = await invoke({ fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(counts.readdirSync, afterFirst.readdirSync, 'no repeat readdirSync on cache hit');
    assert.equal(counts.readFileSync, afterFirst.readFileSync, 'no repeat readFileSync on cache hit');
    assert.equal(store.size, 1, 'one cache entry under the content-health key');
  });

  it('is byte-identical whether memoized or computed fresh (the hoist changes nothing)', async () => {
    const fresh = await invoke({ ...makeFs(buildContentTree()), ...makePassThroughCached() });
    const memo = await invoke({ ...makeFs(buildContentTree()), ...makeMemoCached() });
    assert.equal(
      JSON.stringify(memo.payload),
      JSON.stringify(fresh.payload),
      'memoizing must not change the payload bytes',
    );
    assert.equal(JSON.stringify(fresh.payload), JSON.stringify(EXPECTED_HEALTH));
  });
});

describe('misc-tools.js source: the content-health loop hoists slashTarget', () => {
  it('declares const slashTarget once and both callbacks use id.endsWith(slashTarget)', () => {
    const src = readFileSync(MISC_TOOLS_PATH, 'utf8');
    // Slice just the GET /api/content-health handler block: from its pathname
    // guard up to the next handler (POST /api/snapshots). Both markers are ASCII.
    const start = src.indexOf("pathname === '/api/content-health'");
    assert.ok(start !== -1, 'content-health handler not found in source');
    const end = src.indexOf("pathname === '/api/snapshots'", start);
    assert.ok(end !== -1, 'snapshots handler (block end marker) not found in source');
    const block = src.slice(start, end);

    // The loop-invariant "/" + target probe is built exactly once per link.
    assert.ok(block.includes('const slashTarget ='), 'expected "const slashTarget =" inside the loop');
    // Both the .some and .find callbacks consume the hoisted value.
    const slashUses = block.split('id.endsWith(slashTarget)').length - 1;
    assert.equal(slashUses, 2, 'both the .some and .find callbacks should use id.endsWith(slashTarget)');
    // No per-id "/" + target concatenation remains inside an endsWith.
    assert.ok(!block.includes("endsWith('/' + target)"), "inline endsWith('/' + target) must be gone");
    // The prior pageIdList hoist and the Set membership fast path are preserved.
    assert.ok(block.includes('const pageIdList = [...pageIds]'), 'the pageIdList hoist must stay');
    assert.ok(block.includes('pageIds.has(target)'), 'pageIds.has(target) fast path must stay');
  });
});
