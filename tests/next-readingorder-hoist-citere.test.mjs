import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// The /api/references/reading-order handler reads bibliography/references.yaml by
// path (parsed with the real js-yaml) and walks content/ via readdirSync
// ({withFileTypes:true}) + readFileSync; the stub returns directory entries
// shaped the way the walk expects and ignores the encoding/options arg. Mirrors
// the makeFs helper in next-graphexport-hoist-wikire.test.mjs.
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

// Drive GET /api/references/reading-order with a mocked ctx and capture the
// payload the handler hands to json(res, status, payload).
async function invokeReadingOrder(fs) {
  const url = new URL('http://localhost/api/references/reading-order');
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/references/reading-order', ctx);
  return captured;
}

// Four references with strictly increasing years, so the year sort and the
// citation-derived prerequisites are both deterministic.
const REFERENCES_YAML = `alpha:
  title: Alpha Foundations
  year: 2015
  venue: VenueA
bravo:
  title: Bravo Methods
  year: 2018
  venue: VenueB
charlie:
  title: Charlie Systems
  year: 2021
  venue: VenueC
delta:
  title: Delta Survey
  year: 2023
  venue: VenueD
`;

// intro.md is the FIRST file walked and is the only source of the cross-year
// prerequisites that distinguish a correct scan from one that drops it (see the
// stale-lastIndex test). Each `[@a; @b]` grouped citation exercises the
// `(?:\s*;\s*@[\w-]+)*` tail of READING_ORDER_CITE_RE: a per-request regex (or a
// single-key pattern) that captured only the first key would miss every second
// reference and yield empty prerequisites.
const FIXTURE = {
  'bibliography/references.yaml': REFERENCES_YAML,
  'content/intro.md': `# Intro

This builds on [@charlie; @alpha] and then on [@delta; @bravo].
`,
  'content/more.md': `# More

Further reading: [@delta; @charlie].
`,
};

// Year sort gives [alpha, bravo, charlie, delta]; prerequisites come from the
// pairwise older-before-newer edges within each page's citation list. delta's
// three prerequisites can only appear if intro.md's two grouped citations are
// both fully parsed.
const EXPECTED_READING_ORDER = [
  { order: 1, key: 'alpha', title: 'Alpha Foundations', year: 2015, venue: 'VenueA', prerequisites: [] },
  { order: 2, key: 'bravo', title: 'Bravo Methods', year: 2018, venue: 'VenueB', prerequisites: ['alpha'] },
  { order: 3, key: 'charlie', title: 'Charlie Systems', year: 2021, venue: 'VenueC', prerequisites: ['alpha', 'bravo'] },
  { order: 4, key: 'delta', title: 'Delta Survey', year: 2023, venue: 'VenueD', prerequisites: ['charlie', 'alpha', 'bravo'] },
];

describe('GET /api/references/reading-order (READING_ORDER_CITE_RE hoisted to module scope)', () => {
  it('extracts grouped citations and topologically orders the references', async () => {
    const r = await invokeReadingOrder(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalOrdered, 4);
    assert.deepEqual(r.payload.readingOrder, EXPECTED_READING_ORDER);
    // The grouped-citation tail is load-bearing: charlie and delta both gain
    // prerequisites only because the second `@key` of each `[@a; @b]` group is
    // captured, not just the first.
    assert.deepEqual(r.payload.readingOrder[3].prerequisites, ['charlie', 'alpha', 'bravo']);
  });

  it('returns an identical reading order on a second back-to-back request', async () => {
    const fs = makeFs(FIXTURE);
    const first = await invokeReadingOrder(fs);
    const second = await invokeReadingOrder(fs);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // READING_ORDER_CITE_RE is shared module state across requests, so two
    // identical requests must yield the same reading order, both matching the
    // expected output.
    assert.deepEqual(second.payload.readingOrder, EXPECTED_READING_ORDER);
    assert.deepEqual(second.payload.readingOrder, first.payload.readingOrder);
    assert.equal(second.payload.totalOrdered, first.payload.totalOrdered);
  });

  it('stays correct when READING_ORDER_CITE_RE carries a stale lastIndex (per-file reset is load-bearing)', async () => {
    // The handler resets READING_ORDER_CITE_RE.lastIndex to 0 before each file's
    // exec loop. Pre-seed a large lastIndex to simulate state leaking in from a
    // prior request, then confirm the full reading order still renders. Without
    // the reset the first file walked (intro.md) would start its scan past its
    // own content, exec would return null at once, and intro's two grouped
    // citations (and therefore charlie's and delta's prerequisites) would
    // silently vanish; this proves the reset, not the loop's natural
    // drain-to-null, is what guarantees correctness against a leaked lastIndex.
    assert.ok(routes.READING_ORDER_CITE_RE instanceof RegExp, 'handler regex is exported for this guard');
    routes.READING_ORDER_CITE_RE.lastIndex = 100000;
    const r = await invokeReadingOrder(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.readingOrder, EXPECTED_READING_ORDER);
  });

  it('returns 500 when the bibliography file cannot be read', async () => {
    // No bibliography/references.yaml in this fixture, so the initial
    // readFileSync throws and the handler's catch returns the error envelope.
    const r = await invokeReadingOrder(makeFs({ 'content/intro.md': 'See [@alpha; @bravo].\n' }));
    assert.deepEqual(r, { status: 500, payload: { error: 'Reading order failed' } });
  });
});
