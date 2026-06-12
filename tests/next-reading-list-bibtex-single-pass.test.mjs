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

// A list that mixes `reference` and `doc` items in a deliberate order, with a
// `doc` and a missing-from-bibliography `reference` sitting *between* two present
// references. After the single-pass refactor the emitted entries must stay
// attention2017 → bert2019: docs are skipped by `item.type !== 'reference'`, and
// the absent `ghost-ref` key is skipped by the `if (!entry) continue;` path.
const LIST = {
  id: 'test-list',
  name: 'Reading List Fixture',
  items: [
    { path: 'attention2017', title: 'Attention', type: 'reference' },
    { path: 'guides/setup', title: 'Setup Guide', type: 'doc' },
    { path: 'ghost-ref', title: 'Missing Paper', type: 'reference' },
    { path: 'bert2019', title: 'BERT', type: 'reference' },
    { path: 'guides/intro', title: 'Intro', type: 'doc' },
  ],
};

// attention2017 exercises every field branch (type/author/year/venue/url/doi);
// bert2019 has none of the optional fields, so it falls back to `@misc` and emits
// only title/author/year. `ghost-ref` is intentionally absent here.
const REFS_YAML = `
attention2017:
  type: article
  title: Attention Is All You Need
  author:
    - Vaswani
    - Shazeer
  year: 2017
  venue: NeurIPS
  url: https://example.com/attention
  doi: 10.1000/attn
bert2019:
  title: BERT
  author:
    - Devlin
  year: 2019
`;

// Byte-for-byte expected export body. Entries are joined by a blank line and the
// whole document ends with a single trailing newline (`lines.join('\n\n') + '\n'`).
const EXPECTED_BIBTEX =
`@article{attention2017,
  title = {Attention Is All You Need},
  author = {Vaswani and Shazeer},
  year = {2017},
  journal = {NeurIPS},
  url = {https://example.com/attention},
  doi = {10.1000/attn}
}

@misc{bert2019,
  title = {BERT},
  author = {Devlin},
  year = {2019}
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

describe('GET /api/reading-lists/:id/export?format=bibtex single pass', () => {
  it('emits a byte-identical BibTeX body for the mixed fixture list', async () => {
    const out = await runBibtexExport(LIST, REFS_YAML);
    assert.equal(out.status, 200);
    assert.equal(out.body, EXPECTED_BIBTEX);
  });

  it('sends the BibTeX content-type and attachment headers', async () => {
    const out = await runBibtexExport(LIST, REFS_YAML);
    assert.equal(out.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(out.headers['Content-Disposition'], 'attachment; filename="Reading_List_Fixture.bib"');
    assert.equal(out.headers['Access-Control-Allow-Origin'], 'https://example.test');
  });

  it('preserves item order while skipping docs and references absent from the bibliography', async () => {
    const out = await runBibtexExport(LIST, REFS_YAML);
    const attentionAt = out.body.indexOf('@article{attention2017,');
    const bertAt = out.body.indexOf('@misc{bert2019,');
    assert.ok(attentionAt !== -1 && bertAt !== -1, 'both present references should be emitted');
    assert.ok(attentionAt < bertAt, 'reference order from the list must be preserved');
    // The doc items never reach the bibliography, and the missing key is skipped.
    assert.ok(!out.body.includes('guides/setup'), 'doc items must not be exported');
    assert.ok(!out.body.includes('guides/intro'), 'doc items must not be exported');
    assert.ok(!out.body.includes('ghost-ref'), 'a reference missing from the bibliography is skipped');
    // Exactly the two resolved references, nothing more.
    assert.equal(out.body.match(/^@/gm).length, 2);
  });

  it('returns a lone trailing newline when no reference resolves', async () => {
    const docsOnly = {
      id: 'docs-only',
      name: 'Docs Only',
      items: [
        { path: 'guides/setup', title: 'Setup', type: 'doc' },
        { path: 'ghost-ref', title: 'Missing', type: 'reference' },
      ],
    };
    const out = await runBibtexExport(docsOnly, REFS_YAML);
    assert.equal(out.status, 200);
    // `[].join('\n\n') + '\n'` is just '\n', matching the original two-pass output.
    assert.equal(out.body, '\n');
  });
});
