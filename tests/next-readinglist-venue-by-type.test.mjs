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

// One list referencing four entries that exercise every venue-mapping branch:
// inproceedings → booktitle, article → journal, and both an explicit `book` and a
// typeless entry → howpublished. Item order fixes the emitted entry order.
const LIST = {
  id: 'venue-list',
  name: 'Venue Mapping',
  items: [
    { path: 'conf2020', title: 'Conf', type: 'reference' },
    { path: 'book2018', title: 'Book', type: 'reference' },
    { path: 'art2017', title: 'Article', type: 'reference' },
    { path: 'notype2015', title: 'Untyped', type: 'reference' },
  ],
};

// Each entry carries a venue so the venue branch runs for all four types.
const REFS_YAML = `
conf2020:
  type: inproceedings
  title: A Conference Paper
  venue: NeurIPS
book2018:
  type: book
  title: A Book
  venue: MIT Press
art2017:
  type: article
  title: A Journal Paper
  venue: Nature
notype2015:
  title: An Untyped Work
  venue: arXiv
`;

// Byte-for-byte expected export body. Field order is title then the venue-mapped
// field; entries are joined by a blank line with a single trailing newline
// (`lines.join('\n\n') + '\n'`). The mapping mirrors the canonical research-tools
// exporter: booktitle for inproceedings, journal for article, howpublished
// otherwise (book and the typeless `@misc` entry).
const EXPECTED_BIBTEX =
`@inproceedings{conf2020,
  title = {A Conference Paper},
  booktitle = {NeurIPS}
}

@book{book2018,
  title = {A Book},
  howpublished = {MIT Press}
}

@article{art2017,
  title = {A Journal Paper},
  journal = {Nature}
}

@misc{notype2015,
  title = {An Untyped Work},
  howpublished = {arXiv}
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

describe('GET /api/reading-lists/:id/export?format=bibtex maps venue by entry type', () => {
  it('emits booktitle for an inproceedings entry, not journal', async () => {
    const out = await runBibtexExport(LIST, REFS_YAML);
    assert.equal(out.status, 200);
    assert.ok(out.body.includes('  booktitle = {NeurIPS}'), 'inproceedings venue should map to booktitle');
    assert.ok(!out.body.includes('  journal = {NeurIPS}'), 'inproceedings venue must not map to journal');
  });

  it('emits howpublished for a book entry and a typeless entry', async () => {
    const out = await runBibtexExport(LIST, REFS_YAML);
    assert.ok(out.body.includes('  howpublished = {MIT Press}'), 'book venue should map to howpublished');
    assert.ok(out.body.includes('  howpublished = {arXiv}'), 'typeless venue should map to howpublished');
  });

  it('keeps journal for an article entry (unchanged)', async () => {
    const out = await runBibtexExport(LIST, REFS_YAML);
    assert.ok(out.body.includes('  journal = {Nature}'), 'article venue should map to journal');
  });

  it('emits a byte-identical BibTeX body for the mixed-type fixture', async () => {
    const out = await runBibtexExport(LIST, REFS_YAML);
    assert.equal(out.body, EXPECTED_BIBTEX);
  });
});
