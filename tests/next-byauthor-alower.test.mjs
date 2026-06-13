import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do (mirrors tests/next-jsonld-mtime-iso.test.mjs).
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const routes = require('../server/routes/content-analysis-c.js');

// A small bibliography that exercises the coauthor + preferred-venue scoring of
// GET /api/references/recommend-by-author. The queried author is "Alice"; her
// only entry (alice2020) establishes "bob jones" as a coauthor and "NeurIPS" as
// a preferred venue. The remaining entries are NOT by Alice and score against
// those two facts:
//   coauthor match  = +2 per matching author
//   preferred venue = +1
// bobsolo2022 deliberately spells the coauthor "BOB JONES" in upper case to pin
// the behavior the dedup preserves: the coauthors Set stores the lowercased name
// (coauthors.add(aLower)), so a differently cased author still matches.
const REFS = {
  alice2020: { title: "Alice's Foundational Work", author: ['Alice Smith', 'Bob Jones'], venue: 'NeurIPS', year: 2020 },
  bobsolo2022: { title: 'Bob Solo at NeurIPS', author: ['BOB JONES'], venue: 'NeurIPS', year: 2022 },
  carol2023: { title: 'Bob and Frank, Newer', author: ['Bob Jones', 'Frank Green'], venue: 'ICML', year: 2023 },
  bob2021: { title: 'Bob and Carol Collaborate', author: ['Bob Jones', 'Carol White'], venue: 'ICML', year: 2021 },
  dave2019: { title: 'Dave Solo at NeurIPS', author: ['Dave Brown'], venue: 'NeurIPS', year: 2019 },
  eve2018: { title: 'Eve Unrelated', author: ['Eve Black'], venue: 'AAAI', year: 2018 },
};

// Drive the real handler over a minimal mocked ctx. `fs.readFileSync` serves the
// fixture as YAML so no real references.yaml is read, `cached` is a pass-through
// that runs the closure inline (exercising the real scan rather than a cache
// hit), and `json` captures the {status, payload} the handler emits.
async function recommend(name) {
  const qs = name === undefined ? '' : '?name=' + encodeURIComponent(name);
  const url = new URL('http://localhost/api/references/recommend-by-author' + qs);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    PROJECT_ROOT: '/fake-root',
    fs: { readFileSync: () => yaml.dump(REFS) },
    path,
    cached: (_key, _ttl, fn) => fn(),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/references/recommend-by-author', ctx);
  return captured;
}

describe('GET /api/references/recommend-by-author — coauthor scan dedup', () => {
  it('scores coauthor + preferred-venue matches and sorts by score then year', async () => {
    const r = await recommend('Alice');
    assert.equal(r.status, 200);
    assert.equal(r.payload.author, 'Alice');

    // bobsolo2022: coauthor (+2) and preferred venue (+1) = 3
    // carol2023 / bob2021: coauthor (+2) only = 2, ordered newer-year-first
    // dave2019: preferred venue (+1) only = 1
    // alice2020 is excluded (it is by Alice); eve2018 scores 0 and is dropped.
    assert.deepEqual(r.payload.recommendations, [
      { key: 'bobsolo2022', title: 'Bob Solo at NeurIPS', year: 2022, venue: 'NeurIPS', score: 3 },
      { key: 'carol2023', title: 'Bob and Frank, Newer', year: 2023, venue: 'ICML', score: 2 },
      { key: 'bob2021', title: 'Bob and Carol Collaborate', year: 2021, venue: 'ICML', score: 2 },
      { key: 'dave2019', title: 'Dave Solo at NeurIPS', year: 2019, venue: 'NeurIPS', score: 1 },
    ]);
  });

  it('matches a coauthor regardless of case, pinning the lowercased coauthor Set', async () => {
    // bobsolo2022 lists "BOB JONES" while alice2020 lists "Bob Jones"; the +2
    // coauthor score only lands if the Set holds the lowercased name, which is
    // exactly what coauthors.add(aLower) (the dedup) preserves.
    const r = await recommend('Alice');
    const bobsolo = r.payload.recommendations.find(x => x.key === 'bobsolo2022');
    assert.ok(bobsolo, 'upper-cased coauthor entry should be recommended');
    assert.equal(bobsolo.score, 3);
  });

  it('never recommends an entry authored by the queried author', async () => {
    const r = await recommend('Alice');
    assert.ok(!r.payload.recommendations.some(x => x.key === 'alice2020'));
  });

  it('returns 400 when the name query parameter is missing', async () => {
    const r = await recommend(undefined);
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Missing name' });
  });
});
