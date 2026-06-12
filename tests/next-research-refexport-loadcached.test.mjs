import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');
// loadReferencesCached memoizes in a module-level singleton; clear it between
// scenarios so each case re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// A small fixture covering the two venue/type branches the export loop takes: a
// recognized type (article -> @article, venue -> journal) and a typeless entry
// (defaults to @misc, venue -> howpublished).
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
  volume: 12
  pages: 1-10
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
  doi = {10.1/a},
  volume = {12},
  pages = {1-10}
}

@misc{ref_b,
  title = {Untyped Entry},
  author = {Solo Author},
  year = {2021},
  howpublished = {Workshop X}
}
`;

// Drive the real GET /api/references/export handler over a mocked ctx and
// capture what it writes. The fs mock exposes statSync + readFileSync so the
// memo path in loadReferencesCached is exercised the way the live server hits it.
async function runExport(fsMock) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const pathname = '/api/references/export';
  const url = new URL(`http://localhost${pathname}`);
  const res = {
    writableEnded: false,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { out.body = body; this.writableEnded = true; },
  };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return out;
}

// An fs mock serving `yamlText` for references.yaml; every other path is ENOENT
// so a stray read surfaces instead of returning silent empty data. `reads`
// counts how often references.yaml is actually read so the memo can be asserted.
function makeFs(yamlText) {
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

describe('GET /api/references/export (refs via loadReferencesCached)', () => {
  beforeEach(() => _resetReferencesCache());

  it('exports BibTeX bytes matching the bibliography content', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const out = await runExport(fsMock);
    assert.equal(out.status, 200);
    assert.equal(out.body, EXPECTED_BIBTEX);
  });

  it('sends the BibTeX content-type and attachment headers', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const out = await runExport(fsMock);
    assert.equal(out.status, 200);
    assert.equal(out.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(out.headers['Content-Disposition'], 'attachment; filename="references.bib"');
    assert.equal(out.headers['Cache-Control'], 'no-cache');
  });

  it('memoizes the parse: a second export does not re-read references.yaml', async () => {
    const { fsMock, state } = makeFs(REFS_YAML);
    const first = await runExport(fsMock);
    const second = await runExport(fsMock);
    assert.equal(first.body, EXPECTED_BIBTEX);
    assert.equal(second.body, EXPECTED_BIBTEX);
    assert.equal(state.reads, 1, 'second export is served from the memo, not a re-read');
  });

  it('preserves the 500 fallback on a broken parse', async () => {
    const { fsMock } = makeFs('{ unclosed');
    const out = await runExport(fsMock);
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Export failed/);
  });

  it('preserves the 500 fallback when references.yaml is missing', async () => {
    const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
    const out = await runExport({ statSync: enoent, readFileSync: enoent });
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Export failed/);
  });

  it('returns an empty .bib (200) for an empty but valid bibliography', async () => {
    const { fsMock } = makeFs('{}');
    const out = await runExport(fsMock);
    assert.equal(out.status, 200);
    assert.equal(out.body, '\n');
  });
});
