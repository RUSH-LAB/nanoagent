import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Add-only characterization of the GET /api/references/search success path in
// server/routes/references.js (handler at line 244). After the `q` guard it
// builds, per entry,
//   searchable = [key, entry.title||'', (entry.author||[]).join(' '),
//                 entry.venue||'', String(entry.year||'')].join(' ').toLowerCase()
// pushes `{key, ...entry}` for every entry whose searchable text `.includes`
// the lowercased query, breaks once `results.length >= limit`, and returns
// `{results, total: results.length}`.
//
// The sibling suites pin only the 400 guards
// (tests/next-references-read-missing-param-guards.test.mjs) and the result
// COUNT for limit values via title-only matches
// (tests/next-references-limit-guards.test.mjs); none assert the result SHAPE,
// the non-title match fields (key / author / venue / String(year)), the empty
// no-match payload, or the subtle truncating `total`. This suite pins those.
//
// Every golden below was captured by running the real handler first, then frozen
// here with deepStrictEqual on the full {results, total} payload.
//
// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling references suites do. The ctx/fs-mock + res-capture harness is adapted
// from tests/next-references-yaml-cache.test.mjs: countingFs and freshState are
// reused as is, while invoke follows the same mocked-ctx and json-capture shape
// specialized to the single /api/references/search endpoint. This lets the
// loadReferencesCached path resolve our in-memory data from a yaml.dump(refs)
// string with the real `path` and a PROJECT_ROOT.
const require = createRequire(import.meta.url);
const referencesRoutes = require('../server/routes/references.js');
const yaml = require('js-yaml');
const { _resetReferencesCache } = referencesRoutes;

const PROJECT_ROOT = '/fake/root';

// A counting fs stub (verbatim shape from next-references-yaml-cache): statSync
// returns the current stat and readFileSync returns the current text, recording
// every path so an unexpected access would surface.
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

// Drive a single GET /api/references/search request over a fully mocked ctx and
// capture the response handed to json(res, status, body).
async function invoke(search, fs) {
  const pathname = '/api/references/search';
  const url = new URL(`http://localhost${pathname}${search}`);
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    fs,
    json(_res, status, body) { captured = { status, body }; return captured; },
  };
  await referencesRoutes({ method: 'GET' }, { writableEnded: false }, url, pathname, ctx);
  return captured;
}

// loadReferencesCached memoizes on path + mtimeMs + size at module scope. Every
// fixture below reuses the same default stat, so reset before each case to keep
// one test's parsed object from bleeding into the next.
beforeEach(() => {
  _resetReferencesCache();
});

// Search a fresh in-memory references.yaml built from `refs`.
async function search(refs, query) {
  const state = freshState({ text: yaml.dump(refs) });
  return invoke(query, countingFs(state));
}

describe('references GET /api/references/search match fields', () => {
  // Four entries whose match tokens are disjoint: "alpha" lives only in a key,
  // "bravo" only in an author, "charlie" only in a venue, and "2099" only in a
  // year. A deepStrictEqual on the full payload therefore proves both WHICH
  // field was searched (only the intended entry comes back) and the exact result
  // shape. None of these tokens appears in any other field of any entry.
  const fieldRefs = {
    alphaKey2001: { title: 'Title One', author: ['Writer One'], venue: 'Venue One', year: 2001 },
    ent2:         { title: 'Title Two', author: ['Bravo Person'], venue: 'Venue Two', year: 2002 },
    ent3:         { title: 'Title Three', author: ['Writer Three'], venue: 'Charlie Conference', year: 2003 },
    ent4:         { title: 'Title Four', author: ['Writer Four'], venue: 'Venue Four', year: 2099 },
  };

  it('matches via the citation key', async () => {
    // "alpha" appears only inside the key alphaKey2001 (lowercased to
    // "alphakey2001"), so a hit proves the key is part of `searchable`.
    const r = await search(fieldRefs, '?q=alpha');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      results: [{ key: 'alphaKey2001', title: 'Title One', author: ['Writer One'], venue: 'Venue One', year: 2001 }],
      total: 1,
    });
  });

  it('matches via an author name', async () => {
    // "bravo" appears only in ent2's author "Bravo Person".
    const r = await search(fieldRefs, '?q=bravo');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      results: [{ key: 'ent2', title: 'Title Two', author: ['Bravo Person'], venue: 'Venue Two', year: 2002 }],
      total: 1,
    });
  });

  it('matches via the venue', async () => {
    // "charlie" appears only in ent3's venue "Charlie Conference".
    const r = await search(fieldRefs, '?q=charlie');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      results: [{ key: 'ent3', title: 'Title Three', author: ['Writer Three'], venue: 'Charlie Conference', year: 2003 }],
      total: 1,
    });
  });

  it('matches via the stringified year', async () => {
    // "2099" appears only as ent4's year, exercising String(entry.year || '').
    const r = await search(fieldRefs, '?q=2099');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      results: [{ key: 'ent4', title: 'Title Four', author: ['Writer Four'], venue: 'Venue Four', year: 2099 }],
      total: 1,
    });
  });

  it('returns the full {key, ...entry} shape, including non-searchable fields', async () => {
    // The match is via the title, but the result spreads EVERY entry field,
    // including doi/url/abstract/pages/type which never feed `searchable`. This
    // pins that the projection is `{key, ...entry}`, not a hand-picked subset.
    const shapeRefs = {
      fullEntry42: {
        title: 'Comprehensive Paper',
        author: ['First Author', 'Second Author'],
        venue: 'Journal of Things',
        year: 2015,
        doi: '10.1234/xyz',
        url: 'https://example.com/paper',
        abstract: 'An overview that is excluded from searchable text.',
        pages: '1-20',
        type: 'article',
      },
    };
    const r = await search(shapeRefs, '?q=comprehensive');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      results: [{
        key: 'fullEntry42',
        title: 'Comprehensive Paper',
        author: ['First Author', 'Second Author'],
        venue: 'Journal of Things',
        year: 2015,
        doi: '10.1234/xyz',
        url: 'https://example.com/paper',
        abstract: 'An overview that is excluded from searchable text.',
        pages: '1-20',
        type: 'article',
      }],
      total: 1,
    });
  });

  it('returns an empty payload when nothing matches', async () => {
    // "qqzzxx" appears in no field of any entry.
    const r = await search(fieldRefs, '?q=qqzzxx');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, { results: [], total: 0 });
  });

  it('truncates results at the limit and reports the truncated total, not the full match count', async () => {
    // Five entries all match "shared"; with limit=2 the loop breaks after two
    // pushes, so `total` is the truncated results.length (2), NOT the full
    // match count (5). The default-limit call below confirms all five match.
    const manyRefs = {};
    for (let i = 1; i <= 5; i++) {
      manyRefs[`m${i}`] = { title: `shared topic ${i}`, author: [`Person ${i}`], venue: 'Proceedings', year: 2000 + i };
    }

    const truncated = await search(manyRefs, '?q=shared&limit=2');
    assert.equal(truncated.status, 200);
    assert.deepStrictEqual(truncated.body, {
      results: [
        { key: 'm1', title: 'shared topic 1', author: ['Person 1'], venue: 'Proceedings', year: 2001 },
        { key: 'm2', title: 'shared topic 2', author: ['Person 2'], venue: 'Proceedings', year: 2002 },
      ],
      total: 2,
    });

    // Same fixture without a limit (default 20 > 5) returns every match: total 5.
    const full = await search(manyRefs, '?q=shared');
    assert.equal(full.status, 200);
    assert.equal(full.body.results.length, 5);
    assert.equal(full.body.total, 5);
  });
});
