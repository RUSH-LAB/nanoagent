import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Characterization test for the GET /api/references/by-venue SUCCESS path in
// server/routes/references.js (handler around lines 119-135). The sibling
// tests/next-references-yaml-cache.test.mjs already pins the cache behavior and
// the empty/corrupt fallbacks; this file pins the per-paper projection instead:
// the exact `{key, title, year, authors}` fields, the 'Unknown' venue fallback,
// the inner papers year-DESC sort, and the outer venues count-DESC sort.
//
// All goldens were captured by running the REAL handler. This is an add-only
// test: no source file is modified or lifted.

// references.js is CommonJS; load it the way the sibling route tests do.
const require = createRequire(import.meta.url);
const referencesRoutes = require('../server/routes/references.js');
const { _resetReferencesCache } = referencesRoutes;
const yaml = require('js-yaml');

const PROJECT_ROOT = '/fake/root';

// ── fs-mock + res-capture harness, copied from the sibling cache test ──
// A counting fs stub. `state` carries the current stat (mtimeMs/size) and file
// text; the recorded paths surface any unexpected access.
function countingFs(state) {
  return {
    statSync(fp) {
      state.statPaths.push(fp);
      return { mtimeMs: state.mtimeMs, size: state.size };
    },
    readFileSync(fp, encoding) {
      state.readPaths.push(fp);
      state.readEncodings.push(encoding);
      return state.text;
    },
  };
}

function freshState(over = {}) {
  return { mtimeMs: 1000, size: 100, text: '', statPaths: [], readPaths: [], readEncodings: [], ...over };
}

// The cache is module scope; start every case from a clean slate.
beforeEach(() => {
  _resetReferencesCache();
});

// Drive the REAL by-venue handler against an in-memory references map. The map
// is serialized to YAML (exactly what bibliography/references.yaml holds on
// disk) so the route's loadReferencesCached -> yaml.load path reconstructs it,
// preserving the entry insertion order that the grouping and tie-breaks depend
// on. Returns the captured `{status, body}`.
async function byVenue(refs) {
  const state = freshState({ text: yaml.dump(refs) });
  const url = new URL('http://localhost/api/references/by-venue');
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: countingFs(state),
    json(_res, status, body) { captured = { status, body }; return captured; },
  };
  await referencesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/by-venue', ctx);
  return captured;
}

describe('references GET /api/references/by-venue papers projection', () => {
  it('projects each paper as {key, title, year, authors} and applies both sorts', async () => {
    // Two NeurIPS papers and one CVPR paper. Pins the full response shape: the
    // exact per-paper projection (note `authors` is mapped from `entry.author`),
    // the inner year-DESC order (BERT 2019 before Attention 2017), and the outer
    // count-DESC order (NeurIPS with 2 papers before CVPR with 1).
    const r = await byVenue({
      paperA: { title: 'Attention Is All You Need', year: 2017, venue: 'NeurIPS', author: ['Ashish Vaswani', 'Noam Shazeer'] },
      paperB: { title: 'BERT', year: 2019, venue: 'NeurIPS', author: ['Jacob Devlin'] },
      paperC: { title: 'Deep Residual Learning', year: 2016, venue: 'CVPR', author: ['Kaiming He'] },
    });

    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      venues: [
        {
          venue: 'NeurIPS',
          count: 2,
          papers: [
            { key: 'paperB', title: 'BERT', year: 2019, authors: ['Jacob Devlin'] },
            { key: 'paperA', title: 'Attention Is All You Need', year: 2017, authors: ['Ashish Vaswani', 'Noam Shazeer'] },
          ],
        },
        {
          venue: 'CVPR',
          count: 1,
          papers: [
            { key: 'paperC', title: 'Deep Residual Learning', year: 2016, authors: ['Kaiming He'] },
          ],
        },
      ],
      totalVenues: 2,
    });
  });

  it("buckets an entry with no venue under 'Unknown'", async () => {
    // `entry.venue || 'Unknown'` routes a venue-less entry into the 'Unknown'
    // group; the projection is otherwise identical to a normal entry.
    const r = await byVenue({
      paperX: { title: 'A Paper Without A Venue', year: 2020, author: ['Solo Author'] },
    });

    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      venues: [
        {
          venue: 'Unknown',
          count: 1,
          papers: [
            { key: 'paperX', title: 'A Paper Without A Venue', year: 2020, authors: ['Solo Author'] },
          ],
        },
      ],
      totalVenues: 1,
    });
  });

  it('sorts the inner papers by year DESC, treating a missing year as 0', async () => {
    // Within one venue, papers sort by `(b.year || 0) - (a.year || 0)`. The
    // year-less entry projects to `year: undefined` (the handler always sets the
    // key from `entry.year`) and, scored as 0, sorts last.
    const r = await byVenue({
      p1: { title: 'T1', year: 2018, venue: 'ICML', author: ['A'] },
      p2: { title: 'T2', venue: 'ICML', author: ['B'] },
      p3: { title: 'T3', year: 2022, venue: 'ICML', author: ['C'] },
      p4: { title: 'T4', year: 2020, venue: 'ICML', author: ['D'] },
    });

    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.venues[0].papers.map((p) => p.year), [2022, 2020, 2018, undefined]);
    assert.deepStrictEqual(r.body, {
      venues: [
        {
          venue: 'ICML',
          count: 4,
          papers: [
            { key: 'p3', title: 'T3', year: 2022, authors: ['C'] },
            { key: 'p4', title: 'T4', year: 2020, authors: ['D'] },
            { key: 'p1', title: 'T1', year: 2018, authors: ['A'] },
            { key: 'p2', title: 'T2', year: undefined, authors: ['B'] },
          ],
        },
      ],
      totalVenues: 1,
    });
  });

  it('sorts the outer venues by paper count DESC', async () => {
    // BIGCONF (3), CCC (2), AAAI (1) are inserted in count-ascending order, so a
    // count-DESC sort must reverse them.
    const r = await byVenue({
      a1: { title: 'A1', year: 2020, venue: 'AAAI', author: ['x'] },
      b1: { title: 'B1', year: 2020, venue: 'BIGCONF', author: ['x'] },
      b2: { title: 'B2', year: 2019, venue: 'BIGCONF', author: ['x'] },
      b3: { title: 'B3', year: 2018, venue: 'BIGCONF', author: ['x'] },
      c1: { title: 'C1', year: 2020, venue: 'CCC', author: ['x'] },
      c2: { title: 'C2', year: 2019, venue: 'CCC', author: ['x'] },
    });

    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.venues.map((v) => [v.venue, v.count]), [['BIGCONF', 3], ['CCC', 2], ['AAAI', 1]]);
    assert.deepStrictEqual(r.body, {
      venues: [
        {
          venue: 'BIGCONF',
          count: 3,
          papers: [
            { key: 'b1', title: 'B1', year: 2020, authors: ['x'] },
            { key: 'b2', title: 'B2', year: 2019, authors: ['x'] },
            { key: 'b3', title: 'B3', year: 2018, authors: ['x'] },
          ],
        },
        {
          venue: 'CCC',
          count: 2,
          papers: [
            { key: 'c1', title: 'C1', year: 2020, authors: ['x'] },
            { key: 'c2', title: 'C2', year: 2019, authors: ['x'] },
          ],
        },
        {
          venue: 'AAAI',
          count: 1,
          papers: [
            { key: 'a1', title: 'A1', year: 2020, authors: ['x'] },
          ],
        },
      ],
      totalVenues: 3,
    });
  });
});
