import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// bookmarks-reading-lists.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');
// loadReferencesCached memoizes in a module-level singleton; clear it between
// scenarios so each case re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const READING_LISTS_FILE = '/fake/reading-lists.json';

// A list of two references that resolve in the bibliography, exercising both the
// recognized-type branch (article → @article, venue → journal) and the typeless
// branch (defaults to @misc, venue → howpublished).
const LIST = {
  id: 'cache-list',
  name: 'Cache Fixture',
  items: [
    { path: 'ref_a', title: 'A', type: 'reference' },
    { path: 'ref_b', title: 'B', type: 'reference' },
  ],
};

const REFS_YAML = `ref_a:
  type: article
  title: Sample Title
  author:
    - Ada Lovelace
    - Alan Turing
  year: 2020
  venue: Journal of Tests
  url: https://example.com/a
  doi: 10.1/a
ref_b:
  title: Untyped Entry
  author:
    - Solo Author
  year: 2021
  venue: Workshop X
`;

// Byte-for-byte expected export body: entries join with a blank line and the
// document ends with a single trailing newline (`lines.join('\n\n') + '\n'`).
const EXPECTED_BIBTEX =
`@article{ref_a,
  title = {Sample Title},
  author = {Ada Lovelace and Alan Turing},
  year = {2020},
  journal = {Journal of Tests},
  url = {https://example.com/a},
  doi = {10.1/a}
}

@misc{ref_b,
  title = {Untyped Entry},
  author = {Solo Author},
  year = {2021},
  howpublished = {Workshop X}
}
`;

// Drive the real GET /api/reading-lists/:id/export?format=bibtex handler over a
// mocked ctx and capture what it writes. loadJSON answers only for the reading
// lists file; the supplied fs mock answers only for references.yaml, so any stray
// read surfaces as an error instead of silently returning empty data.
async function runBibtexExport(list, fsMock) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    READING_LISTS_FILE,
    CORS_ORIGIN: 'https://example.test',
    loadJSON: (fp) => {
      if (fp === READING_LISTS_FILE) return { lists: [list] };
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    fs: fsMock,
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const pathname = `/api/reading-lists/${list.id}/export`;
  const url = new URL(`http://localhost${pathname}?format=bibtex`);
  const res = {
    writableEnded: false,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { out.body = body; this.writableEnded = true; },
  };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await bookmarksReadingListsRoutes(req, res, url, pathname, ctx);
  return out;
}

// A stat-bearing fs: serves references.yaml and counts reads so the memo can be
// asserted. Every other path is ENOENT so a stray read surfaces loudly.
function makeStatFs(yamlText) {
  const state = { reads: 0 };
  const fsMock = {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: yamlText.length };
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) { state.reads++; return yamlText; }
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return { fsMock, state };
}

// A stat-less fs: only readFileSync, mirroring the pre-existing reading-list
// export test mocks. loadReferencesCached's statSync call throws (undefined),
// is caught, and it falls through to a fresh read, so the export body must be
// byte-identical to the stat-bearing path.
function makeStatlessFs(yamlText) {
  return {
    readFileSync(fp) {
      if (fp === REFS_PATH) return yamlText;
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

describe('GET /api/reading-lists/:id/export?format=bibtex (refs via loadReferencesCached)', () => {
  beforeEach(() => _resetReferencesCache());

  it('emits identical BibTeX whether the fs mock exposes statSync or not', async () => {
    const { fsMock: statFs } = makeStatFs(REFS_YAML);
    const withStat = await runBibtexExport(LIST, statFs);
    const withoutStat = await runBibtexExport(LIST, makeStatlessFs(REFS_YAML));
    assert.equal(withStat.status, 200);
    assert.equal(withoutStat.status, 200);
    assert.equal(withStat.body, EXPECTED_BIBTEX);
    assert.equal(withoutStat.body, withStat.body);
  });

  it('sends the BibTeX content-type and attachment headers', async () => {
    const { fsMock } = makeStatFs(REFS_YAML);
    const out = await runBibtexExport(LIST, fsMock);
    assert.equal(out.status, 200);
    assert.equal(out.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(out.headers['Content-Disposition'], 'attachment; filename="Cache_Fixture.bib"');
    assert.equal(out.headers['Access-Control-Allow-Origin'], 'https://example.test');
  });

  it('memoizes the parse: a second export does not re-read references.yaml', async () => {
    const { fsMock, state } = makeStatFs(REFS_YAML);
    const first = await runBibtexExport(LIST, fsMock);
    const second = await runBibtexExport(LIST, fsMock);
    assert.equal(first.body, EXPECTED_BIBTEX);
    assert.equal(second.body, EXPECTED_BIBTEX);
    assert.equal(state.reads, 1, 'second export is served from the memo, not a re-read');
  });

  it('preserves the prior empty export when references.yaml is missing', async () => {
    const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
    const out = await runBibtexExport(LIST, { statSync: enoent, readFileSync: enoent });
    // The old code initialized `let refs = {}` and swallowed the read failure, so
    // no reference resolves and the body is the lone trailing newline of
    // `[].join('\n\n') + '\n'`. loadReferencesCached returns {} on the same miss.
    assert.equal(out.status, 200);
    assert.equal(out.body, '\n');
  });

  it('preserves the prior empty export when references.yaml is malformed', async () => {
    // A present but broken bibliography: statSync succeeds, readFileSync returns
    // invalid YAML, so yaml.load throws inside loadReferencesCached and it returns
    // {}, exactly as the old `try { yaml.load(...) } catch {}` swallowed the parse
    // error. No reference resolves, so the body is the lone trailing newline.
    const { fsMock } = makeStatFs('{ unclosed');
    const out = await runBibtexExport(LIST, fsMock);
    assert.equal(out.status, 200);
    assert.equal(out.body, '\n');
  });
});
