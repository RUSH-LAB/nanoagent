import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the real module via createRequire the way the
// sibling route suites do (next-backlinkrank-500 / next-content-c-mentions-cache), so this
// characterization test drives the genuine GET /api/content-backlink-ranking handler
// (content-analysis-c.js:137 to :186) rather than a reimplementation.
//
// It pins the handler's SUCCESS path: the per-page incoming wiki-link counting, the
// exact-or-suffix target resolution, the descending rank by incomingLinks, and the
// mostLinked (top 5) / leastLinked (zero-incoming, top 10) projections. It is DISTINCT from:
//   1. next-backlinkrank-500.test.mjs, which pins the outer catch 500 arm; and
//   2. next-backlink-ranking-negative-limit-clamp.test.mjs, which stubs `cached` to return a
//      PRE-BUILT ranking array, so the real scan closure never runs.
// Here `cached` is a pass-through that runs the real closure against an in-memory fixture fs,
// so the genuine readdirSync/readFileSync scan and its incremental resolution are exercised.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Ordered content/ fixture. The scan walks readdirSync entries in this insertion order,
// recursing each directory inline as it is met, so the order fixes the incremental
// resolution: a [[target]] resolves only against the pages scanned SO FAR.
//
// Coverage built into the tree:
//   1. guide/ is walked before gamma.md, so gamma's bare [[setup]] resolves through the
//      endsWith('/' + target) suffix branch onto the nested id "guide/setup" (not a bare
//      "setup" fallback key).
//   2. guide/index.md exercises the trailing "/index" trim, giving it the id "guide".
//   3. hub.md and guide/index.md carry a frontmatter title that overrides the filename.
//   4. The dot-prefixed file, the underscore-prefixed directory, and the non-markdown file
//      each also point at [[hub]] yet are skipped, so a hub count of exactly 3 (alpha, beta,
//      gamma) proves all three skip branches.
//   5. orphan.md has no links in or out, anchoring the zero-incoming leastLinked slice.
const FIXTURE = [
  ['content/_drafts/wip.md', 'Draft pointing at [[hub]] [[hub]] [[hub]]; the _ directory is skipped.\n'],
  ['content/guide/index.md', '---\ntitle: Guide Home\n---\n\nThe guide landing page.\n'],
  ['content/guide/setup.md', '# Setup\n\nNo outgoing links live here.\n'],
  ['content/hub.md', '---\ntitle: Knowledge Hub\n---\n\nThe central hub; nothing links out.\n'],
  ['content/alpha.md', 'Alpha references [[hub]], [[guide]] and [[guide/setup]].\n'],
  ['content/beta.md', 'Beta references [[hub]].\n'],
  ['content/gamma.md', 'Gamma jumps to [[setup]] and back to [[hub]].\n'],
  ['content/orphan.md', 'A lonely page with no links and no backlinks.\n'],
  ['content/.hidden.md', 'Hidden file pointing at [[hub]]; the dot prefix is skipped.\n'],
  ['content/notes.txt', 'Plain text pointing at [[hub]]; a non-markdown extension is skipped.\n'],
];

// In-memory fs whose readdirSync returns Dirent-likes in insertion order (so the scan
// order above is honored) and whose readFileSync serves the fixture bodies. Mirrors the
// shape of the sibling cache suites' fs stub, narrowed to the two calls this scan makes.
function makeFs(pairs) {
  const dirs = new Map();  // absDir -> Map<name, isDir> (insertion order preserved)
  const files = new Map(); // absFile -> content
  const ensureDir = (d) => { if (!dirs.has(d)) dirs.set(d, new Map()); };

  for (const [rel, content] of pairs) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    files.set(cur, content);
  }

  return {
    readdirSync(dir) {
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (files.has(fp)) return files.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Drive GET /api/content-backlink-ranking once over a mocked ctx. `cached` is a faithful
// pass-through that actually runs the scan closure (as the live memo does on a cold key),
// so the real readdirSync/readFileSync walk and ranking run against the fixture fs.
async function runRanking(fs, search = '') {
  let captured = null;
  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; return captured; },
    cached: (_key, _ttl, fn) => fn(),
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
  };
  const pathname = '/api/content-backlink-ranking';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// Each ranked entry keeps the handler's field order: id, path, title, incomingLinks.
const HUB    = { id: 'hub', path: 'content/hub.md', title: 'Knowledge Hub', incomingLinks: 3 };
const SETUP  = { id: 'guide/setup', path: 'content/guide/setup.md', title: 'setup', incomingLinks: 2 };
const GUIDE  = { id: 'guide', path: 'content/guide/index.md', title: 'Guide Home', incomingLinks: 1 };
const ALPHA  = { id: 'alpha', path: 'content/alpha.md', title: 'alpha', incomingLinks: 0 };
const BETA   = { id: 'beta', path: 'content/beta.md', title: 'beta', incomingLinks: 0 };
const GAMMA  = { id: 'gamma', path: 'content/gamma.md', title: 'gamma', incomingLinks: 0 };
const ORPHAN = { id: 'orphan', path: 'content/orphan.md', title: 'orphan', incomingLinks: 0 };

// Ranking sorted descending by incomingLinks. The four zero-incoming pages keep their scan
// order (alpha, beta, gamma, orphan) because V8's Array.prototype.sort is stable.
const RANKED = [HUB, SETUP, GUIDE, ALPHA, BETA, GAMMA, ORPHAN];

// Default limit is numericParam(null, 30, 200) = 30, so the page window is the whole
// 7-page ranking; mostLinked is the top 5, leastLinked the zero-incoming pages (top 10).
const EXPECTED_DEFAULT = {
  pages: RANKED,
  totalPages: 7,
  mostLinked: [HUB, SETUP, GUIDE, ALPHA, BETA],
  leastLinked: [ALPHA, BETA, GAMMA, ORPHAN],
};

// ?limit=1 slices the page window to the single top page; the count and both summary
// slices are untouched by the limit.
const EXPECTED_LIMIT_1 = {
  pages: [HUB],
  totalPages: 7,
  mostLinked: [HUB, SETUP, GUIDE, ALPHA, BETA],
  leastLinked: [ALPHA, BETA, GAMMA, ORPHAN],
};

describe('GET /api/content-backlink-ranking success-path ranking golden', () => {
  it('scans the fixture, counts incoming wiki-links, and pins the full ranking payload', async () => {
    const fs = makeFs(FIXTURE);
    const res = await runRanking(fs);

    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.payload, EXPECTED_DEFAULT);

    // Hand-asserted invariants behind the golden, each pinning one computed behavior:
    // descending rank order by id.
    assert.deepStrictEqual(res.payload.pages.map((p) => p.id), [
      'hub', 'guide/setup', 'guide', 'alpha', 'beta', 'gamma', 'orphan',
    ]);
    // The suffix branch landed gamma's [[setup]] on the nested id, so no bare "setup"
    // page exists and guide/setup carries both the exact (alpha) and suffix (gamma) links.
    assert.equal(res.payload.pages.some((p) => p.id === 'setup'), false);
    assert.equal(res.payload.pages.find((p) => p.id === 'guide/setup').incomingLinks, 2);
    // The trailing "/index" trim plus the frontmatter title override.
    assert.equal(res.payload.pages.find((p) => p.id === 'guide').title, 'Guide Home');
    assert.equal(res.payload.pages.find((p) => p.id === 'hub').title, 'Knowledge Hub');
    // hub keeps exactly three incoming links, proving the dot-file, underscore-directory,
    // and non-markdown linkers were all skipped before counting.
    assert.equal(res.payload.pages.find((p) => p.id === 'hub').incomingLinks, 3);
    assert.equal(res.payload.totalPages, 7);
  });

  it('honors ?limit=1 on the real ranking while totalPages and the summaries stay full', async () => {
    const fs = makeFs(FIXTURE);
    const res = await runRanking(fs, '?limit=1');

    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.payload, EXPECTED_LIMIT_1);
    assert.equal(res.payload.pages.length, 1);
    assert.equal(res.payload.totalPages, 7);
  });
});
