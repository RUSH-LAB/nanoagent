import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the sibling reading-order
// suites do (next-readorder-refdedup, next-readingorder-hoist-citere).
//
// This suite pins the result `.map` of GET /api/references/reading-order, where
// each entry now binds `refs[key]` once into `const r` and reads `r.title`,
// `r.year`, `r.venue` (replacing the three `refs[key].title/.year/.venue`
// reads). The hoist is meant to be byte-identical, so the tests drive the real
// handler over a mocked ctx and assert the produced `readingOrder` array
// (order / key / title / year / venue / prerequisites) is exactly as expected,
// proving `r` is rebound per iteration and every field is sourced from the
// entry's own reference.
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
// rebuilds the `readingOrder` map (no cache carried between calls).
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

// Three dated references, each with a distinct title/year/venue, co-cited in a
// single jumbled citation group so the topological scan produces a non-trivial
// prerequisite ordering. The year sort yields [found, build, apply]; the older
// works become prerequisites of the newer ones.
const FIXTURE = {
  'bibliography/references.yaml': `found:
  title: Foundations
  year: 2012
  venue: JMLR
build:
  title: Building Blocks
  year: 2016
  venue: ICLR
apply:
  title: Applications
  year: 2022
  venue: CVPR
`,
  'content/survey.md': `# Survey

Background draws on [@apply; @build; @found] across the field.
`,
};

// The map walks the chronological order and, for each key, emits the entry's own
// title/year/venue (via `const r = refs[key]`) plus its prerequisites. `apply`
// lists both earlier works (insertion order build -> found from the pair loop).
const EXPECTED_ORDER = [
  { order: 1, key: 'found', title: 'Foundations', year: 2012, venue: 'JMLR', prerequisites: [] },
  { order: 2, key: 'build', title: 'Building Blocks', year: 2016, venue: 'ICLR', prerequisites: ['found'] },
  { order: 3, key: 'apply', title: 'Applications', year: 2022, venue: 'CVPR', prerequisites: ['build', 'found'] },
];

describe('GET /api/references/reading-order (refs[key] hoisted into const r in the result map)', () => {
  it('builds each readingOrder entry from its own reference via the hoisted r', async () => {
    const r = await invokeReadingOrder(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalOrdered, 3);
    // Full-array deepEqual: order / key / title / year / venue / prerequisites
    // must all match, which only holds if `r = refs[key]` is rebound per
    // iteration and every field reads from that per-entry object.
    assert.deepEqual(r.payload.readingOrder, EXPECTED_ORDER);
  });

  it('sources title, year, and venue per key (r is not captured from one entry)', async () => {
    const r = await invokeReadingOrder(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    // Per-entry field check: were `r` hoisted outside the map (capturing only the
    // last key), every entry would carry `apply`'s fields. Asserting each
    // entry's three fields against its own reference proves the per-iteration bind.
    const byKey = Object.fromEntries(r.payload.readingOrder.map(e => [e.key, e]));
    assert.deepEqual(
      { title: byKey.found.title, year: byKey.found.year, venue: byKey.found.venue },
      { title: 'Foundations', year: 2012, venue: 'JMLR' },
    );
    assert.deepEqual(
      { title: byKey.build.title, year: byKey.build.year, venue: byKey.build.venue },
      { title: 'Building Blocks', year: 2016, venue: 'ICLR' },
    );
    assert.deepEqual(
      { title: byKey.apply.title, year: byKey.apply.year, venue: byKey.apply.venue },
      { title: 'Applications', year: 2022, venue: 'CVPR' },
    );
  });
});
