import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
// The handler's module-scope require('./references.js') resolves
// loadReferencesCached from the repo, exactly as the live server wires it.
const require = createRequire(import.meta.url);
const contentAnalysisARoutes = require('../../../src/server/routes/content-analysis-a.js');
// loadReferencesCached memoizes in a module-level singleton; clear it between
// scenarios so each case re-stats and re-reads deterministically. Imported
// read-only; the test never mutates references.js.
const { _resetReferencesCache } = require('../../../src/server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'content', 'bibliography', 'references.yaml');

// One bibliography exercising every branch of GET /api/references/autofill:
//   - target is MISSING type, doi, and url (three of the four FIELDS) but HAS a
//     venue, so venue must be skipped and never suggested.
//   - cand1..cand4 each share an author with target (cand2 lowercases the name to
//     prove the match is case-insensitive) and carry assorted fields.
//   - cand4 only matters for doi: it would be a fourth doi suggestion, so it must
//     be dropped by the cap of 3, while it IS the third url suggestion (cand3 has
//     no url) so order across fields differs.
//   - nonmatch shares no author, so none of its fields are ever suggested.
//   - noauthor has no author array at all, used by a separate scenario.
const REFS_YAML = `target:
  title: Target Paper
  author:
    - Ada Lovelace
    - Grace Hopper
  venue: Present Venue
  year: 2020
cand1:
  title: Cand One
  author:
    - Ada Lovelace
  type: article
  doi: "10.1/c1"
  url: "http://c1"
  venue: V1
cand2:
  title: Cand Two
  author:
    - ada lovelace
  doi: "10.1/c2"
  url: "http://c2"
cand3:
  title: Cand Three
  author:
    - Grace Hopper
  type: inproceedings
  doi: "10.1/c3"
cand4:
  title: Cand Four
  author:
    - Ada Lovelace
  doi: "10.1/c4"
  url: "http://c4"
nonmatch:
  title: Non Match
  author:
    - Someone Else
  type: book
  doi: "10.1/nm"
  url: "http://nm"
noauthor:
  title: No Author Paper
  year: 2019
`;

// fs mock serving REFS_YAML for references.yaml only. statSync returns a stable
// (mtimeMs, size) so loadReferencesCached can memo the way the live server does;
// any other path is ENOENT so a stray access surfaces immediately.
function makeFs(yaml) {
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  return {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: yaml.length };
      return enoent(fp);
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) return yaml;
      return enoent(fp);
    },
  };
}

// Drive the real GET /api/references/autofill handler over a mocked ctx and
// capture what json() writes. Pass key=undefined to omit the query parameter.
async function runAutofill(fsMock, key) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const pathname = '/api/references/autofill';
  const query = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  const url = new URL(`http://localhost${pathname}${query}`);
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await contentAnalysisARoutes(req, res, url, pathname, ctx);
  return out;
}

describe('GET /api/references/autofill (refEntries hoist)', () => {
  beforeEach(() => _resetReferencesCache());

  it('suggests each missing field from author-sharing entries, capped at 3, in scan order', async () => {
    const out = await runAutofill(makeFs(REFS_YAML), 'target');
    assert.equal(out.status, 200);
    // Full payload pinned so the hoist stays behavior preserving:
    //   - venue is absent (target already has one),
    //   - doi caps at 3 (cand4 dropped) and follows cand1, cand2, cand3 order,
    //   - url skips cand3 (no url) so its third entry is cand4,
    //   - type only has the two candidates that carry a type and share an author.
    assert.deepEqual(out.json, {
      key: 'target',
      currentEntry: {
        title: 'Target Paper',
        author: ['Ada Lovelace', 'Grace Hopper'],
        venue: 'Present Venue',
        year: 2020,
      },
      suggestions: {
        type: [
          { value: 'article', source: 'cand1' },
          { value: 'inproceedings', source: 'cand3' },
        ],
        doi: [
          { value: '10.1/c1', source: 'cand1' },
          { value: '10.1/c2', source: 'cand2' },
          { value: '10.1/c3', source: 'cand3' },
        ],
        url: [
          { value: 'http://c1', source: 'cand1' },
          { value: 'http://c2', source: 'cand2' },
          { value: 'http://c4', source: 'cand4' },
        ],
      },
    });
  });

  it('returns empty suggestions when the source entry has no authors', async () => {
    // noauthor is missing all four fields, but with no author array every field
    // hits the `srcAuthors.length === 0` short-circuit, so nothing is suggested.
    const out = await runAutofill(makeFs(REFS_YAML), 'noauthor');
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, {
      key: 'noauthor',
      currentEntry: { title: 'No Author Paper', year: 2019 },
      suggestions: {},
    });
  });

  it('returns 404 for an unknown key', async () => {
    const out = await runAutofill(makeFs(REFS_YAML), 'does-not-exist');
    assert.equal(out.status, 404);
    assert.deepEqual(out.json, { error: 'Reference not found' });
  });

  it('returns 400 when the key query parameter is missing', async () => {
    const out = await runAutofill(makeFs(REFS_YAML), undefined);
    assert.equal(out.status, 400);
    assert.deepEqual(out.json, { error: 'Missing key' });
  });
});
