import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const referencesRoutes = require('../server/routes/references.js');
const yaml = require('js-yaml');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// Drive GET /api/references/by-author with a mocked ctx and capture the json()
// response. fs.readFileSync only answers for the references.yaml path so an
// accidental extra read would surface as an ENOENT rather than silent reuse.
async function getByAuthor(refs, search = '') {
  const yamlText = yaml.dump(refs);
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: {
      readFileSync(fp) {
        if (fp === REFS_PATH) return yamlText;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL(`http://localhost/api/references/by-author${search}`);
  await referencesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/by-author', ctx);
  return captured;
}

// Fixture exercising both branches of the hoisted `entry.author || UNKNOWN_AUTHORS`
// fallback:
//   - paper1, paper2 carry authors (Alice Smith is shared → her group has 2 papers).
//   - paper3, paper4 omit `author` entirely → both land in the synthesized 'Unknown'
//     group, giving it 2 papers.
// Alice Smith and Unknown both have count 2, so the descending-count sort ties; the
// stable tie-break keeps Alice (inserted first) ahead of Unknown, pinning the
// 'Unknown' group's sort position. Each group's papers sort by descending year.
const FIXTURE = {
  paper1: { title: 'Alpha Study', author: ['Alice Smith', 'Bob Jones'], year: 2020, venue: 'ICML' },
  paper2: { title: 'Beta Study', author: ['Alice Smith'], year: 2021, venue: 'NeurIPS' },
  paper3: { title: 'Gamma Study', year: 2019, venue: 'ICLR' },
  paper4: { title: 'Delta Study', year: 2022, venue: 'ACL' },
};

describe('GET /api/references/by-author (Unknown fallback hoisted to UNKNOWN_AUTHORS)', () => {
  it('deep-equals the expected payload: Unknown group, grouping, counts and order', async () => {
    const res = await getByAuthor(FIXTURE);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      authors: [
        {
          author: 'Alice Smith',
          count: 2,
          papers: [
            { key: 'paper2', title: 'Beta Study', year: 2021, venue: 'NeurIPS' },
            { key: 'paper1', title: 'Alpha Study', year: 2020, venue: 'ICML' },
          ],
        },
        {
          author: 'Unknown',
          count: 2,
          papers: [
            { key: 'paper4', title: 'Delta Study', year: 2022, venue: 'ACL' },
            { key: 'paper3', title: 'Gamma Study', year: 2019, venue: 'ICLR' },
          ],
        },
        {
          author: 'Bob Jones',
          count: 1,
          papers: [
            { key: 'paper1', title: 'Alpha Study', year: 2020, venue: 'ICML' },
          ],
        },
      ],
      totalAuthors: 3,
    });

    // Spell out the synthesized 'Unknown' group and its sort position explicitly.
    assert.deepEqual(res.body.authors.map(a => a.author), ['Alice Smith', 'Unknown', 'Bob Jones']);
    const unknown = res.body.authors.find(a => a.author === 'Unknown');
    assert.equal(unknown.count, 2, 'both author-less entries collapse into one Unknown group');
  });

  it('reuses the same frozen UNKNOWN_AUTHORS instance across many author-less entries', async () => {
    // Many entries with no author must still produce exactly one 'Unknown' group;
    // a shared frozen fallback (vs. a fresh array per entry) must not change the count.
    const many = {};
    for (let i = 0; i < 25; i++) many[`n${i}`] = { title: `Untitled ${i}`, year: 2000 + i };
    const res = await getByAuthor(many);
    assert.equal(res.status, 200);
    assert.equal(res.body.totalAuthors, 1, 'all author-less entries share the single Unknown group');
    assert.equal(res.body.authors[0].author, 'Unknown');
    assert.equal(res.body.authors[0].count, 25);
  });

  it('treats an empty author array as no authors (truthy [] short-circuits the fallback)', async () => {
    // `[] || UNKNOWN_AUTHORS` keeps the empty array (it is truthy), so an entry with
    // `author: []` contributes to no group at all — behavior the hoist must preserve.
    const res = await getByAuthor({
      withAuthor: { title: 'Has Author', author: ['Solo One'], year: 2015 },
      emptyAuthor: { title: 'Empty Author', author: [], year: 2016 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      authors: [
        {
          author: 'Solo One',
          count: 1,
          papers: [{ key: 'withAuthor', title: 'Has Author', year: 2015, venue: undefined }],
        },
      ],
      totalAuthors: 1,
    });
    assert.ok(!res.body.authors.some(a => a.author === 'Unknown'), 'empty array must NOT become an Unknown group');
  });
});
