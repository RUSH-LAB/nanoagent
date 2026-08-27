import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other route tests do. The
// GET /api/references/citation-graph handler reads bibliography/references.yaml
// through its own require('js-yaml'), so the fs mock below only needs to serve
// that file plus the content tree the co-citation scan walks. These cases pin
// the `edges` array, i.e. the co-citation O(n^2) edge loop that binds
// `const ai = arr[i];` once per outer iteration before the inner j loop.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// An fs mock: readFileSync serves `refsYaml` for references.yaml and the `pages`
// map for the content tree; readdirSync prepends three entries the scan filters
// out by name before any read (a dotfile, an underscore file, and a non-markdown
// file), so the mocked directory mirrors realistic noise. The assertions below
// pin the edges array, not these name-filter branches. Any unmapped path throws
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

describe('GET /api/references/citation-graph edges (co-citation O(n^2) edge loop, const ai = arr[i] hoist)', () => {
  it('builds a pairwise edge per co-cited pair and aggregates weight across pages, sorted by weight desc', async () => {
    // ref_a, ref_b, ref_c already sort ascending, so [...cites].sort() yields
    // [ref_a, ref_b, ref_c] and the inner j loop runs more than once for the
    // first outer i. Binding `const ai = arr[i];` once per outer iteration must
    // leave every eid byte-identical. page1 co-cites all three (three pairs);
    // page2 re-cites ref_a with ref_b so that edge climbs to weight 2 and floats
    // to the top of the weight-desc sort, while the two weight-1 edges keep their
    // insertion order under the stable sort.
    const refsYaml = `ref_a:
  title: Paper A
  year: 2020
  author: Author A
ref_b:
  title: Paper B
  year: 2021
  author: Author B
ref_c:
  title: Paper C
  year: 2022
  author: Author C
`;
    const out = await runCitationGraph(makeFs(refsYaml, {
      'page1.md': 'Compare [@ref_a], [@ref_b], and [@ref_c].\n',
      'page2.md': 'Revisit [@ref_a] together with [@ref_b].\n',
    }));
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.edges, [
      { source: 'ref_a', target: 'ref_b', type: 'cites', weight: 2 },
      { source: 'ref_a', target: 'ref_c', type: 'cites', weight: 1 },
      { source: 'ref_b', target: 'ref_c', type: 'cites', weight: 1 },
    ]);
  });

  it('emits no edge for a page citing a single ref, while a co-citing page still yields its one edge', async () => {
    // page_solo cites just ref_a, so pageCites.size === 1 fails the size > 1 gate
    // and contributes no pair to the edge loop; page_pair co-cites ref_a with
    // ref_b for exactly one edge of weight 1. ref_c stays uncited, so it never
    // reaches the edge loop at all.
    const refsYaml = `ref_a:
  title: Paper A
  year: 2020
  author: Author A
ref_b:
  title: Paper B
  year: 2021
  author: Author B
ref_c:
  title: Paper C
  year: 2022
  author: Author C
`;
    const out = await runCitationGraph(makeFs(refsYaml, {
      'page_solo.md': 'Only [@ref_a] appears here.\n',
      'page_pair.md': 'Together [@ref_a] and [@ref_b].\n',
    }));
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.edges, [
      { source: 'ref_a', target: 'ref_b', type: 'cites', weight: 1 },
    ]);
  });
});
