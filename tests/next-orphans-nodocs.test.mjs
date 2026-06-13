import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// analysis-admin.js is CommonJS; load it via createRequire the way the sibling
// route tests do (next-duplicates-jaccard-hoist.test.mjs and friends) and reuse
// the same in-memory-fs ctx-mocking shape. These tests drive the REAL
// GET /api/analytics/orphans handler over a virtual content tree, no server.
const require = createRequire(import.meta.url);
const analysisAdminRoutes = require('../server/routes/analysis-admin.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_ADMIN_PATH = path.join(__dirname, '..', 'server', 'routes', 'analysis-admin.js');

const PROJECT_ROOT = '/proj';

// ── Why the hoist under test is behavior-preserving ──────────────────────────
// In the orphans handler `withoutExt` is a `const` derived from `relFromContent`,
// and the enclosing block is straight-line synchronous code. The last two
// `isLinked` operands both computed `withoutExt.replace(/^docs\//, '')` (once raw,
// once `.toLowerCase()`). `String.prototype.replace` with a literal regex and a
// constant string is pure, so both calls yield the identical string. Computing it
// once into `const withoutExtNoDocs` and reusing it feeds the identical value to
// both `.has()` checks, so `isLinked` (and the orphans list, its membership
// decisions, and its ordering) is byte-identical.
//
// The fixture exercises both reads of the deduped binding. Every page under
// `docs/` is reachable ONLY through its docs-stripped form, so the docs-stripped
// operands (`linkedTargets.has(withoutExtNoDocs)` and its `.toLowerCase()`
// sibling) are the sole reason those pages are not flagged; the baseName and
// withoutExt operands never match them. `foo` has an already-lowercase stripped
// form (`sub/foo`), so both deduped operands compute the same string and the
// match exercises the raw read; `Bar` is linked only in lowercase (`sub/bar`)
// while its stripped form is mixed-case (`sub/Bar`), so ONLY the `.toLowerCase()`
// operand can match it, pinning the lowercased read. A control page under the
// same `docs/` tree that nothing links to still surfaces as an orphan, proving
// the rescue comes from the link match and not merely from living under `docs/`.
//
// Note: the raw operand (`withoutExtNoDocs`) cannot be isolated as the SOLE
// decider behaviorally, because the handler adds every link target together with
// its lowercase form, so linkedTargets is always closed under lowercasing and a
// raw-read match implies a lowercased-read match. The source-shape test below
// pins the raw operand's presence directly instead.

// In-memory content tree under <PROJECT_ROOT>/content. A string value is a file's
// contents; an object value is a directory. JS preserves insertion order for these
// non-integer keys, so the directory listing (and thus scan order) is deterministic,
// exactly the declared order below.
function buildContentTree() {
  const file = (title, body) => ['---', `title: ${title}`, '---', '', body, ''].join('\n');
  // Hub page links every docs page ONLY by its docs-stripped form. A markdown
  // link `[text](sub/foo.md)` is cleaned to `sub/foo`, so linkedTargets ends up
  // holding `sub/foo` and `sub/bar` and nothing else. index.md is navigational,
  // so the handler skips it as an orphan candidate; using it as the hub keeps the
  // hub itself out of the orphans list without anything having to link back to it.
  const hub = ['# Hub', '', '[Foo](sub/foo.md)', '', '[Bar](sub/bar.md)', ''].join('\n');
  return {
    'index.md': hub,
    // Two genuinely orphan pages, declared zeta-before-alpha so the path sort has
    // to reorder them. Bodies are plain words so word counts are obvious after the
    // handler strips frontmatter.
    'zeta-orphan.md': file('Zeta', 'four five six seven'),
    'alpha-orphan.md': file('Alpha', 'one two three'),
    docs: {
      sub: {
        // foo: stripped form 'sub/foo' is already lowercase, so BOTH deduped
        //      operands (the raw read and the .toLowerCase() read) compute
        //      'sub/foo' and match; operands 1 through 4 (baseName 'foo',
        //      withoutExt 'docs/sub/foo') never do.
        'foo.md': file('Foo Page', 'foo body words here'),
        // Bar: stripped form is mixed-case 'sub/Bar' but the only link is the
        //      lowercase 'sub/bar', so ONLY the .toLowerCase() read matches.
        'Bar.md': file('Bar Page', 'bar body words here'),
        // Control: a docs page nothing links to. Living under docs/ does not save
        // it; it must still surface as an orphan.
        'lonely.md': file('Lonely', 'lonely page text'),
      },
    },
  };
}

// A counting in-memory fs serving the virtual tree. The orphans handler calls
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

// Drive GET /api/analytics/orphans with a mocked ctx and capture what the handler
// hands to json(res, status, payload). A fresh ctx (and fresh cached) per call
// means no module state leaks between tests.
async function invoke({ fs, cached }) {
  const pathname = '/api/analytics/orphans';
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
// handler). Orphans are every non-index page no link target reaches:
//   - alpha-orphan.md, zeta-orphan.md: nothing links to them.
//   - docs/sub/lonely.md: under docs/, but nothing links to its docs-stripped
//     form `sub/lonely`, so it is an orphan too.
// foo.md and Bar.md are NOT orphans: linkedTargets holds `sub/foo` and `sub/bar`.
// foo matches both deduped reads (its stripped form `sub/foo` is already lowercase);
// Bar matches only the lowercased read (`sub/Bar`.toLowerCase() === `sub/bar`).
// The list is sorted by path.localeCompare ascending, which reorders scan order
// (zeta was scanned before alpha). wordCount is the body word count after the
// handler strips frontmatter, fenced code, and inline code.
const EXPECTED_ORPHANS = [
  { path: 'content/alpha-orphan.md', name: 'alpha-orphan.md', wordCount: 3 },
  { path: 'content/docs/sub/lonely.md', name: 'lonely.md', wordCount: 3 },
  { path: 'content/zeta-orphan.md', name: 'zeta-orphan.md', wordCount: 4 },
];

describe('GET /api/analytics/orphans (withoutExt.replace(/^docs//) deduped into withoutExtNoDocs)', () => {
  it('returns the orphans payload deep-equal to the independent reference computation', async () => {
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    assert.equal(r.status, 200);
    // Whole-object equality against the hand-derived reference: paths, names, counts.
    assert.deepEqual(r.payload, { orphans: EXPECTED_ORPHANS });
    // Same values AND same key ordering as the response shape.
    assert.equal(
      JSON.stringify(r.payload),
      JSON.stringify({ orphans: EXPECTED_ORPHANS }),
    );
  });

  it('does not flag a docs page reachable only through its docs-stripped form', async () => {
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    const orphanPaths = new Set(r.payload.orphans.map((o) => o.path));
    // foo is rescued by the docs-stripped operands (its stripped form 'sub/foo' is
    // already lowercase, so both deduped reads match); Bar is rescued only by the
    // lowercased read (withoutExtNoDocs.toLowerCase() === 'sub/bar'). Neither is
    // matched by the baseName or withoutExt operands, so both must be absent here.
    assert.ok(!orphanPaths.has('content/docs/sub/foo.md'), 'foo.md must not be an orphan (docs-stripped match)');
    assert.ok(!orphanPaths.has('content/docs/sub/Bar.md'), 'Bar.md must not be an orphan (lowercased docs-stripped match)');
    // The control proves living under docs/ does not by itself rescue a page.
    assert.ok(orphanPaths.has('content/docs/sub/lonely.md'), 'an unlinked docs page is still an orphan');
  });

  it('orders the orphans by ascending path (the sort reorders scan order)', async () => {
    const { fs } = makeFs(buildContentTree());
    const { cached } = makePassThroughCached();
    const r = await invoke({ fs, cached });

    const paths = r.payload.orphans.map((o) => o.path);
    assert.deepEqual(paths, [
      'content/alpha-orphan.md',
      'content/docs/sub/lonely.md',
      'content/zeta-orphan.md',
    ]);
    // Strictly ascending, independent of the array literal above. zeta-orphan.md
    // was scanned first yet sorts last, so this is a real reorder.
    for (let i = 1; i < paths.length; i++) {
      assert.ok(paths[i - 1].localeCompare(paths[i]) < 0, 'orphans must be sorted by ascending path');
    }
  });

  it('routes through cached("analytics:orphans", 60000) and serves a repeat from cache with no re-walk', async () => {
    const { fs, counts } = makeFs(buildContentTree());
    const { cached, store, calls } = makeMemoCached();

    const first = await invoke({ fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, { orphans: EXPECTED_ORPHANS });
    assert.ok(counts.readdirSync >= 1, 'first request walks the tree');
    assert.ok(counts.readFileSync >= 1, 'first request reads files');
    const afterFirst = { readdirSync: counts.readdirSync, readFileSync: counts.readFileSync };

    // Cache key and TTL are exactly as the handler passes them.
    assert.equal(calls[0].key, 'analytics:orphans');
    assert.equal(calls[0].ttl, 60000);

    const second = await invoke({ fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(counts.readdirSync, afterFirst.readdirSync, 'no repeat readdirSync on cache hit');
    assert.equal(counts.readFileSync, afterFirst.readFileSync, 'no repeat readFileSync on cache hit');
    assert.equal(store.size, 1, 'one cache entry under the analytics:orphans key');
  });

  it('is byte-identical whether memoized or computed fresh (cache changes nothing)', async () => {
    const fresh = await invoke({ ...makeFs(buildContentTree()), ...makePassThroughCached() });
    const memo = await invoke({ ...makeFs(buildContentTree()), ...makeMemoCached() });
    assert.equal(
      JSON.stringify(memo.payload),
      JSON.stringify(fresh.payload),
      'memoizing must not change the payload bytes',
    );
    assert.equal(JSON.stringify(fresh.payload), JSON.stringify({ orphans: EXPECTED_ORPHANS }));
  });
});

describe('analysis-admin.js source: the orphans handler dedupes the docs-strip into withoutExtNoDocs', () => {
  it('binds withoutExtNoDocs once and routes both trailing operands through it', () => {
    const src = readFileSync(ANALYSIS_ADMIN_PATH, 'utf8');
    // Slice just the GET /api/analytics/orphans handler block: from its pathname
    // guard up to the next handler (POST /api/lint). Both markers are ASCII.
    const start = src.indexOf("pathname === '/api/analytics/orphans'");
    assert.ok(start !== -1, 'orphans handler not found in source');
    const end = src.indexOf("pathname === '/api/lint'", start);
    assert.ok(end !== -1, 'lint handler (block end marker) not found in source');
    const block = src.slice(start, end);

    // The docs-stripped form is computed once, right after withoutExt.
    assert.ok(
      block.includes("const withoutExtNoDocs = withoutExt.replace(/^docs\\//, '');"),
      'expected a single "const withoutExtNoDocs = withoutExt.replace(/^docs//, \'\');" binding',
    );
    // Both trailing operands read the hoisted binding.
    assert.ok(
      block.includes('linkedTargets.has(withoutExtNoDocs)'),
      'the 5th operand must read linkedTargets.has(withoutExtNoDocs)',
    );
    assert.ok(
      block.includes('linkedTargets.has(withoutExtNoDocs.toLowerCase())'),
      'the 6th operand must read linkedTargets.has(withoutExtNoDocs.toLowerCase())',
    );
    // The old per-operand re-reads are gone.
    assert.ok(
      !block.includes('linkedTargets.has(withoutExt.replace'),
      'old inline "linkedTargets.has(withoutExt.replace(...))" operands must be gone',
    );
    // The untouched operands stay as they were.
    assert.ok(block.includes('linkedTargets.has(withoutExt)'), 'the withoutExt operand stays');
    assert.ok(block.includes('linkedTargets.has(baseName)'), 'the baseName operand stays');
  });
});
