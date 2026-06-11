import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const contentAnalysisBRoutes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// Invoke GET /api/references/analytics with a mocked ctx and capture the json()
// response. `cached` is collapsed to a pass-through so the fixture is parsed on
// every call, and fs.readFileSync only answers for the references.yaml path so an
// accidental extra read would surface as an ENOENT rather than silent reuse.
async function getAnalytics(yamlText) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    cached: (_key, _ttl, fn) => fn(),
    fs: {
      readFileSync(fp) {
        if (fp === REFS_PATH) return yamlText;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL('http://localhost/api/references/analytics');
  await contentAnalysisBRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/analytics', ctx);
  return captured;
}

// Six entries that deliberately share authors, venues, and types so the counts,
// the stable-sort tie-breaks, and the key-insertion order all carry signal:
//   authors: Alice(3) Bob(2) Carol(1) Dave(1)  (Carol before Dave is the tie-break)
//   venues:  ICML(3) NeurIPS(2)  (e6 has no venue, exercising the `if (e.venue)` skip)
//   types:   article(3) inproceedings(1) book(1) misc(1)  (e6 has no type, the `|| 'misc'` default)
const FIXTURE = `
e1:
  title: T1
  author: [Alice, Bob]
  venue: ICML
  type: article
  year: 2020
e2:
  title: T2
  author: [Alice]
  venue: NeurIPS
  type: article
  year: 2021
e3:
  title: T3
  author: [Alice, Carol]
  venue: ICML
  type: inproceedings
  year: 2019
e4:
  title: T4
  author: [Bob]
  venue: ICML
  type: article
  year: 2022
e5:
  title: T5
  venue: NeurIPS
  type: book
  year: 2018
e6:
  title: T6
  author: [Dave]
  year: 2023
`;

describe('GET /api/references/analytics single-pass counts', () => {
  it('deep-equals the expected analytics payload, ordering included', async () => {
    const res = await getAnalytics(FIXTURE);
    assert.equal(res.status, 200);

    // avgAge folds in the current calendar year; mirror the handler's own
    // computation so the deep-equal stays deterministic across years.
    const expectedAvgAge = Math.round(new Date().getFullYear() - 2021);
    assert.deepEqual(res.body, {
      totalReferences: 6,
      avgYear: 2021,
      medianYear: 2021,
      avgAge: expectedAvgAge,
      uniqueAuthors: 4,
      uniqueVenues: 2,
      topAuthors: [
        { name: 'Alice', count: 3 },
        { name: 'Bob', count: 2 },
        { name: 'Carol', count: 1 },
        { name: 'Dave', count: 1 },
      ],
      topVenues: [
        { venue: 'ICML', count: 3 },
        { venue: 'NeurIPS', count: 2 },
      ],
      typeDistribution: { article: 3, inproceedings: 1, book: 1, misc: 1 },
      yearRange: { min: 2018, max: 2023 },
    });

    // deepEqual ignores object key order, so pin typeDistribution's insertion
    // order explicitly; that order is exactly what the loop fusion must preserve.
    assert.deepEqual(Object.keys(res.body.typeDistribution), ['article', 'inproceedings', 'book', 'misc']);
  });

  it('returns the empty payload for an empty bibliography', async () => {
    const res = await getAnalytics('{}');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      totalReferences: 0,
      avgYear: 0,
      medianYear: 0,
      avgAge: 0,
      uniqueAuthors: 0,
      uniqueVenues: 0,
      topAuthors: [],
      topVenues: [],
      typeDistribution: {},
      yearRange: null,
    });
  });
});
