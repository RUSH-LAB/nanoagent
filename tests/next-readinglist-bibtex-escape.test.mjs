import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// bookmarks-reading-lists.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const READING_LISTS_FILE = '/fake/reading-lists.json';

// A reference whose title, author, and venue all carry LaTeX specials. The
// values are single-quoted so YAML keeps the `&`, `%`, and `:` literal.
const SPECIALS_LIST = {
  id: 'specials-list',
  name: 'Specials',
  items: [{ path: 'specials', title: 'Specials', type: 'reference' }],
};
const SPECIALS_YAML = `
specials:
  type: article
  title: 'Scaling & Efficiency: 100%'
  author:
    - 'A_B'
  year: 2020
  venue: 'R&D'
`;
// Field order follows the handler: title, author, year, journal (from venue).
// Each LaTeX special is escaped, so the body compiles under BibTeX.
const EXPECTED_ESCAPED =
`@article{specials,
  title = {Scaling \\& Efficiency: 100\\%},
  author = {A\\_B},
  year = {2020},
  journal = {R\\&D}
}
`;

// A reference with plain, single-spaced values and no specials. cleanBibtexValue
// returns such values unchanged, so the export stays byte identical to the
// pre-change format.
const CLEAN_LIST = {
  id: 'clean-list',
  name: 'Clean',
  items: [{ path: 'clean', title: 'Clean', type: 'reference' }],
};
const CLEAN_YAML = `
clean:
  type: article
  title: Clean Title
  author:
    - Alice
    - Bob
  year: 2021
  venue: Journal of Testing
  url: https://example.com/clean
  doi: 10.1/clean
`;
const EXPECTED_CLEAN =
`@article{clean,
  title = {Clean Title},
  author = {Alice and Bob},
  year = {2021},
  journal = {Journal of Testing},
  url = {https://example.com/clean},
  doi = {10.1/clean}
}
`;

// Drive the real GET /api/reading-lists/:id/export?format=bibtex handler over a
// mocked ctx and capture what it writes. loadJSON answers only for the reading
// lists file and fs.readFileSync only for references.yaml, so any stray read
// surfaces as an error instead of silently returning empty data.
async function runBibtexExport(list, yamlText) {
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
    fs: {
      readFileSync(fp) {
        if (fp === REFS_PATH) return yamlText;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
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

describe('GET /api/reading-lists/:id/export?format=bibtex escapes LaTeX specials', () => {
  it('escapes &, %, and _ so the BibTeX compiles', async () => {
    const out = await runBibtexExport(SPECIALS_LIST, SPECIALS_YAML);
    assert.equal(out.status, 200);
    assert.ok(out.body.includes('\\&'), 'ampersand should be escaped');
    assert.ok(out.body.includes('\\%'), 'percent should be escaped');
    assert.ok(out.body.includes('\\_'), 'underscore should be escaped');
  });

  it('leaves no bare ampersand in the exported body', async () => {
    const out = await runBibtexExport(SPECIALS_LIST, SPECIALS_YAML);
    // Every `&` must be preceded by a backslash (i.e. part of `\&`).
    assert.ok(!/(?<!\\)&/.test(out.body), 'no bare ampersand should remain');
  });

  it('emits the fully escaped body byte for byte', async () => {
    const out = await runBibtexExport(SPECIALS_LIST, SPECIALS_YAML);
    assert.equal(out.body, EXPECTED_ESCAPED);
  });

  it('keeps clean, specials-free values byte identical to the pre-change format', async () => {
    const out = await runBibtexExport(CLEAN_LIST, CLEAN_YAML);
    assert.equal(out.status, 200);
    assert.equal(out.body, EXPECTED_CLEAN);
  });
});
