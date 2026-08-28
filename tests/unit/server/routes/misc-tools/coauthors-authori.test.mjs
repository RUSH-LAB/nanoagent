import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other server route tests do
// (mirrors tests/next-byauthor-alower.test.mjs).
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const routes = require('../../../../../src/server/routes/misc-tools.js');

// A small bibliography that exercises the O(n^2) co-author pairing of
// GET /api/references/co-authors. paper1 and paper3 each list three authors, so
// the inner loop forms multiple pairs per entry. The hoist under test binds the
// fixed outer-row author authors[i] into `const authorI` once before the inner j
// loop; the pair key stays [authorI, authors[j]].sort().join('::'), which must be
// value-for-value identical to the former [authors[i], authors[j]] form. The
// per-pair tallies are:
//   Alice::Bob    -> paper1, paper2, paper3   = 3
//   Alice::Carol  -> paper1, paper3           = 2
//   Bob::Carol    -> paper1, paper3           = 2
//   Yan::Zoe      -> paper6                    = 1  (counted, below the edge threshold)
// paper4 (single author) and paper5 (no author field, exercising `entry.author
// || []`) contribute no pairs.
const REFS = {
  paper1: { title: 'Three Co-authors', author: ['Alice', 'Bob', 'Carol'] },
  paper2: { title: 'Alice and Bob Again', author: ['Alice', 'Bob'] },
  paper3: { title: 'Reordered Trio', author: ['Bob', 'Carol', 'Alice'] },
  paper4: { title: 'Solo', author: ['Dave'] },
  paper5: { title: 'No Authors' },
  paper6: { title: 'One-off Pair', author: ['Zoe', 'Yan'] },
};

// Drive the real handler over a minimal mocked ctx. `fs.readFileSync` serves the
// fixture as YAML so no real references.yaml is read, `cached` is a pass-through
// that runs the closure inline (exercising the real scan rather than a cache
// hit), and `json` captures the {status, payload} the handler emits.
async function coAuthors(readFileSync = () => yaml.dump(REFS)) {
  const url = new URL('http://localhost/api/references/co-authors');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    PROJECT_ROOT: '/fake-root',
    fs: { readFileSync },
    path,
    cached: (_key, _ttl, fn) => fn(),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/references/co-authors', ctx);
  return captured;
}

describe('GET /api/references/co-authors — co-author pair counting', () => {
  it('counts every within-entry pair across the O(n^2) loop', async () => {
    const r = await coAuthors();
    assert.equal(r.status, 200);

    // Four distinct pairs are counted; three clear the >= 2 edge threshold and
    // sort by paper count (descending, ties in first-seen order).
    assert.equal(r.payload.totalPairs, 4);
    assert.deepEqual(r.payload.edges, [
      { author1: 'Alice', author2: 'Bob', papers: 3 },
      { author1: 'Alice', author2: 'Carol', papers: 2 },
      { author1: 'Bob', author2: 'Carol', papers: 2 },
    ]);
    // authors are the unique endpoints of the surviving edges, in first-seen order.
    assert.deepEqual(r.payload.authors, ['Alice', 'Bob', 'Carol']);
  });

  it('keys a reordered author row to the same pair (the authorI hoist is value-stable)', async () => {
    // paper3 lists [Bob, Carol, Alice], so its Bob+Alice pair is built as i=Bob,
    // j=Alice; it must still key as 'Alice::Bob' and fold into the same tally as
    // paper1 and paper2, proving the hoisted authorI feeds the identical
    // [authorI, authors[j]].sort() pair build.
    const r = await coAuthors();
    const ab = r.payload.edges.find(e => e.author1 === 'Alice' && e.author2 === 'Bob');
    assert.ok(ab, 'the Alice/Bob edge must exist');
    assert.equal(ab.papers, 3);
  });

  it('forms no pair for single-author or author-less entries', async () => {
    // Dave (paper4, solo) and paper5 (no author field) form no pairs, so neither
    // appears among the edge authors. Yan::Zoe (paper6) is counted in totalPairs
    // but stays below the >= 2 edge threshold, so neither of its authors surfaces.
    const r = await coAuthors();
    const names = new Set(r.payload.authors);
    assert.ok(!names.has('Dave'), 'a solo author forms no co-author edge');
    assert.ok(!names.has('Yan') && !names.has('Zoe'), 'a one-off pair is below the edge threshold');
  });

  it('returns 500 when the bibliography cannot be read', async () => {
    const r = await coAuthors(() => { throw new Error('boom'); });
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Co-author network failed' });
  });
});
