import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other route tests do. The
// GET /api/references/citation-graph handler reads bibliography/references.yaml
// through its own require('js-yaml'), so the fs mock below only needs to serve
// that file plus the content tree the co-citation scan walks.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'content', 'bibliography', 'references.yaml');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// An fs mock: readFileSync serves `refsYaml` for references.yaml and the `pages`
// map for the content tree; readdirSync prepends three entries the scan filters
// out by name before any read (a dotfile, an underscore file, and a non-markdown
// file), so the mocked directory mirrors realistic noise. The assertions below
// pin the nodes map, not these name-filter branches. Any unmapped path throws
// ENOENT to surface a stray references.yaml or content-dir access.
function makeFs(refsYaml, pages) {
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  const SKIP = ['.hidden.md', '_draft.md', 'notes.txt'];
  return {
    readFileSync(fp) {
      if (fp === REFS_PATH) return refsYaml;
      const rel = path.relative(CONTENT_DIR, fp);
      if (Object.hasOwn(pages, rel)) return pages[rel];
      return enoent(fp);
    },
    readdirSync(fp) {
      if (fp === CONTENT_DIR) {
        return [...SKIP, ...Object.keys(pages)].map(name => ({ name, isDirectory: () => false }));
      }
      return enoent(fp);
    },
  };
}

// Drive the real GET /api/references/citation-graph handler over a mocked ctx and
// capture what json() writes. The cached passthrough runs the builder on every
// call (no result-level memo), so each request recomputes the graph from scratch.
async function runCitationGraph(fsMock) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const pathname = '/api/references/citation-graph';
  const url = new URL(`http://localhost${pathname}`);
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await miscToolsRoutes(req, res, url, pathname, ctx);
  return out;
}

describe('GET /api/references/citation-graph nodes map (const ref = refs[key] reuse)', () => {
  it('builds nodes for cited refs, covering the array-author join and string-author paths', async () => {
    // ref_arr carries four authors so the Array.isArray branch is forced to
    // slice(0, 3) and join the first three; ref_str carries a plain string author
    // so the fallback branch is taken verbatim. ref_uncited sits in references.yaml
    // but is cited nowhere, so it lifts totalReferences to 3 while staying out of nodes.
    const refsYaml = `ref_arr:
  title: Array Author Paper
  year: 2020
  author:
    - Alice Smith
    - Bob Jones
    - Carol White
    - Dave Black
ref_str:
  title: String Author Paper
  year: 2021
  author: Solo Writer
ref_uncited:
  title: Never Cited
  year: 1999
`;
    // One page co-cites both refs, so pageCites.size > 1 yields a single edge and
    // both keys enter citedKeys in citation order (ref_arr then ref_str).
    const out = await runCitationGraph(makeFs(refsYaml, {
      'page1.md': 'Co-cite [@ref_arr] and [@ref_str] together.\n',
    }));
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, {
      nodes: [
        { id: 'ref_arr', title: 'Array Author Paper', year: 2020, authors: 'Alice Smith, Bob Jones, Carol White' },
        { id: 'ref_str', title: 'String Author Paper', year: 2021, authors: 'Solo Writer' },
      ],
      edges: [
        { source: 'ref_arr', target: 'ref_str', type: 'cites', weight: 1 },
      ],
      totalReferences: 3,
    });
  });

  it('falls back to key / null / empty author when those fields are absent', async () => {
    // ref_bare is a truthy object missing title, year, and author, so each node
    // field exercises the right-hand side of its || (title to key, year to null,
    // authors to ''). ref_partner shares the page so the co-citation gate passes
    // and both refs become nodes.
    const refsYaml = `ref_bare:
  type: misc
ref_partner:
  title: Partner Paper
  year: 2020
  author: Someone Else
`;
    const out = await runCitationGraph(makeFs(refsYaml, {
      'page1.md': 'See [@ref_bare] alongside [@ref_partner].\n',
    }));
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.nodes, [
      { id: 'ref_bare', title: 'ref_bare', year: null, authors: '' },
      { id: 'ref_partner', title: 'Partner Paper', year: 2020, authors: 'Someone Else' },
    ]);
  });
});
