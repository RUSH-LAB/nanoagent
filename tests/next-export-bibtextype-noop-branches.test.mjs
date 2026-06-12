import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// A fixture that mixes every relevant entry type so the @-header for each is
// pinned: a recognized type that the dead chain used to re-assign (article,
// inproceedings, book), a missing type that defaults to @misc, and a genuinely
// unknown type (phdthesis) that the chain never matched and so passed through
// verbatim. Removing the no-op branches must leave all five byte-identical.
const REFS_YAML = `
article1:
  type: article
  title: Attention Is All You Need
  author:
    - Vaswani
    - Shazeer
  year: 2017
  venue: NeurIPS
  url: https://example.com/attention
  doi: 10.1000/attn
  volume: 30
  pages: 5998-6008
inproc1:
  type: inproceedings
  title: BERT Pretraining
  author:
    - Devlin
  year: 2019
  venue: NAACL
book1:
  type: book
  title: Deep Learning
  author:
    - Goodfellow
    - Bengio
  year: 2016
  venue: MIT Press
notype1:
  title: A Note Without A Type
  author:
    - Anonymous
  year: 2020
  venue: arXiv
thesis1:
  type: phdthesis
  title: An Unknown Entry Type
  author:
    - Student
  year: 2021
`;

// Byte-for-byte expected export body. Entries join with a blank line and the
// whole document ends with one trailing newline (`lines.join('\n\n') + '\n'`).
// The @-header equals the reference type for every entry: recognized types stay
// themselves, a missing type is the 'misc' default, and phdthesis (never matched
// by the removed chain) passes straight through. The venue field name follows
// bibtexType: booktitle for inproceedings, journal for article, howpublished
// otherwise.
const EXPECTED_BIBTEX =
`@article{article1,
  title = {Attention Is All You Need},
  author = {Vaswani and Shazeer},
  year = {2017},
  journal = {NeurIPS},
  url = {https://example.com/attention},
  doi = {10.1000/attn},
  volume = {30},
  pages = {5998-6008}
}

@inproceedings{inproc1,
  title = {BERT Pretraining},
  author = {Devlin},
  year = {2019},
  booktitle = {NAACL}
}

@book{book1,
  title = {Deep Learning},
  author = {Goodfellow and Bengio},
  year = {2016},
  howpublished = {MIT Press}
}

@misc{notype1,
  title = {A Note Without A Type},
  author = {Anonymous},
  year = {2020},
  howpublished = {arXiv}
}

@phdthesis{thesis1,
  title = {An Unknown Entry Type},
  author = {Student},
  year = {2021}
}
`;

// Drive the real GET /api/references/export handler over a mocked ctx and
// capture what it writes. fs.readFileSync only answers for the references.yaml
// path, so any stray read surfaces as an ENOENT instead of silent empty data.
async function runExport(yamlText) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: {
      readFileSync(fp) {
        if (fp === REFS_PATH) return yamlText;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
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

describe('GET /api/references/export (bibtexType no-op branches removed)', () => {
  it('emits a byte-identical BibTeX body across all entry types', async () => {
    const out = await runExport(REFS_YAML);
    assert.equal(out.status, 200);
    assert.equal(out.body, EXPECTED_BIBTEX);
  });

  it('keeps the @-header equal to the reference type for every entry', async () => {
    const out = await runExport(REFS_YAML);
    // The recognized types the dead chain used to re-assign.
    assert.ok(out.body.includes('@article{article1,'), 'article stays @article');
    assert.ok(out.body.includes('@inproceedings{inproc1,'), 'inproceedings stays @inproceedings');
    assert.ok(out.body.includes('@book{book1,'), 'book stays @book');
    // A missing type defaults to @misc.
    assert.ok(out.body.includes('@misc{notype1,'), 'a typeless entry is @misc');
    // An unknown type the chain never matched passes through verbatim, proving the
    // removed branches were a no-op rather than a normalizer to @misc.
    assert.ok(out.body.includes('@phdthesis{thesis1,'), 'an unknown type passes through unchanged');
    // Exactly five entries, one @-header each, in fixture order.
    assert.deepEqual(out.body.match(/^@\w+\{/gm), [
      '@article{', '@inproceedings{', '@book{', '@misc{', '@phdthesis{',
    ]);
  });

  it('sends the BibTeX content-type and attachment headers', async () => {
    const out = await runExport(REFS_YAML);
    assert.equal(out.status, 200);
    assert.equal(out.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(out.headers['Content-Disposition'], 'attachment; filename="references.bib"');
  });
});
