import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the sibling reading-order
// suites do (next-readingorder-hoist-citere, next-content-b-ref-caches).
//
// This suite pins the inner O(n^2) loop of GET /api/references/reading-order,
// where each guarded iteration now binds `refs[a]`/`refs[b]` once into
// `ra`/`rb` and reads `ra.year`/`rb.year`. The dedupe is meant to be
// byte-identical, so the tests drive the real handler over a mocked ctx and
// assert the year comparison still produces the chronological reading order
// (older cited before newer), including the `|| 9999` fallback for an undated
// reference that the deduped reads feed.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`. The handler
// reads bibliography/references.yaml by path (parsed with the real js-yaml) and
// walks content/ via readdirSync({withFileTypes:true}) + readFileSync; the stub
// returns directory entries shaped the way the walk expects and ignores the
// encoding/options arg. Mirrors the makeFs helper in the sibling suites.
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
// payload handed to json(res, status, payload). The pass-through cached(key,
// ttl, fn) runs fn() on every call, so each invocation re-walks the fixture and
// re-runs the modified inner loop (no cache carried between calls).
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
    cached: (_k, _t, fn) => fn(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/references/reading-order', ctx);
  return captured;
}

// Three dated references, deliberately cited out of chronological order in a
// single grouped citation so the reading order can only come out right if the
// inner loop compares `ra.year`/`rb.year` rather than citation position. With
// three keys co-cited on one page the quadratic loop runs three guarded pairs,
// the home of the deduped `ra = refs[a], rb = refs[b]` binding.
const DATED_FIXTURE = {
  'bibliography/references.yaml': `older:
  title: Older Work
  year: 2010
  venue: V1
middle:
  title: Middle Work
  year: 2015
  venue: V2
newer:
  title: Newer Work
  year: 2020
  venue: V3
`,
  'content/survey.md': `# Survey

Background draws on [@newer; @older; @middle] across the field.
`,
};

// Year sort gives [older, middle, newer]; the older-before-newer edges are the
// pairwise comparisons within the single jumbled citation group. `newer` lists
// both earlier works as prerequisites even though it is cited first.
const EXPECTED_DATED_ORDER = [
  { order: 1, key: 'older', title: 'Older Work', year: 2010, venue: 'V1', prerequisites: [] },
  { order: 2, key: 'middle', title: 'Middle Work', year: 2015, venue: 'V2', prerequisites: ['older'] },
  { order: 3, key: 'newer', title: 'Newer Work', year: 2020, venue: 'V3', prerequisites: ['older', 'middle'] },
];

describe('GET /api/references/reading-order (refs[a]/refs[b] deduped into ra/rb)', () => {
  it('orders co-cited references chronologically from the ra.year/rb.year comparison', async () => {
    const r = await invokeReadingOrder(makeFs(DATED_FIXTURE));
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalOrdered, 3);
    // Older cited before newer: the jumbled `[@newer; @older; @middle]` group
    // resolves to older -> middle -> newer purely from the year comparison.
    assert.deepEqual(r.payload.readingOrder, EXPECTED_DATED_ORDER);
    // The newest entry depends on both earlier works, proving both the
    // `yearA < yearB` and `yearB < yearA` branches ran over the deduped binding.
    assert.deepEqual(r.payload.readingOrder[2].prerequisites, ['older', 'middle']);
  });

  it('treats an undated reference as newest via the ra.year || 9999 fallback', async () => {
    // `undated` has no year, so the deduped read evaluates `rb.year || 9999`
    // (and `ra.year || 9999`) to 9999, sorting it last and making the dated
    // `classic` its prerequisite. Without the fallback both comparisons against
    // `undefined` are false, no edge forms, and `undated` loses its prerequisite.
    const fixture = {
      'bibliography/references.yaml': `classic:
  title: Classic
  year: 2005
  venue: VC
undated:
  title: Undated
  venue: VU
`,
      'content/u.md': '# U\n\nSee [@undated; @classic] for context.\n',
    };
    const r = await invokeReadingOrder(makeFs(fixture));
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalOrdered, 2);
    assert.deepEqual(r.payload.readingOrder.map(e => e.key), ['classic', 'undated']);
    const undated = r.payload.readingOrder.find(e => e.key === 'undated');
    assert.deepEqual(undated.prerequisites, ['classic']);
  });
});
