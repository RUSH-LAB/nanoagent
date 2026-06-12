import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// Fixture for GET /api/graph. WIKI_LINK_RE was hoisted to module scope, so one
// shared instance now serves every file and every request. Wiki links live in
// two files (hub.md and alpha.md) so the shared regex is exercised across files
// within a single request, and the handler resets WIKI_LINK_RE.lastIndex = 0
// before each file's exec loop. The links cover every branch of the pattern:
//   • [[alpha]]            — plain target
//   • [[beta|Beta Page]]   — aliased target; the capture stops at the pipe so
//                            the edge target is "beta", never "beta|Beta Page"
//   • [[ghost]]            — no node, no fallback match → dropped
const FIXTURE = {
  'hub.md': '---\ntitle: Hub\n---\n\nSee [[alpha]] and [[beta|Beta Page]] and [[ghost]].\n',
  'alpha.md': '---\ntitle: Alpha\n---\n\n# Alpha\n\nBack to [[hub]].\n',
  'beta.md': '---\ntitle: Beta\n---\n\n# Beta\n',
};

// Expected nodes (one per fixture file), every file at the content root so the
// category is '' and the path carries no OS-specific separator.
const EXPECTED_NODES = [
  { id: 'alpha', path: 'alpha.md', title: 'Alpha', category: '' },
  { id: 'beta', path: 'beta.md', title: 'Beta', category: '' },
  { id: 'hub', path: 'hub.md', title: 'Hub', category: '' },
];

// Expected resolved edges. Compared order-independently because the edge order
// follows fs.readdirSync order across the two linking files, which is
// platform-defined; the set of edges is what must stay stable.
const EXPECTED_EDGES = [
  { source: 'alpha', target: 'hub' },
  { source: 'hub', target: 'alpha' },
  { source: 'hub', target: 'beta' },
];

const byId = (a, b) => a.id.localeCompare(b.id);
const byEdge = (a, b) =>
  a.source.localeCompare(b.source) || a.target.localeCompare(b.target);

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-hoist-wikire-'));
  for (const [rel, body] of Object.entries(FIXTURE)) {
    const full = path.join(root, 'content', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Drive the real GET /api/graph handler over the fixture and return the captured
// json() response.
async function runGraph() {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    ALLOWED_EXTS: ['.md', '.mdx'],
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/graph');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await graphRoutes(req, res, url, '/api/graph', ctx);
  return captured;
}

describe('GET /api/graph (hoisted module-scope WIKI_LINK_RE)', () => {
  it('returns identical responses on two back-to-back calls (no stale lastIndex bleed)', async () => {
    const first = await runGraph();
    const second = await runGraph();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The shared module-scope regex is reset before each file's exec loop, so a
    // second request over the same content produces a byte-identical payload. If
    // a future change leaked lastIndex across requests, the second pass would
    // miss leading links and this comparison would fail.
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
  });

  it('returns the expected nodes and resolved edges', async () => {
    const { status, payload } = await runGraph();
    assert.equal(status, 200);
    assert.deepEqual([...payload.nodes].sort(byId), EXPECTED_NODES);
    assert.deepEqual([...payload.edges].sort(byEdge), EXPECTED_EDGES);
  });

  it('captures only the target of an aliased link, stopping at the pipe', async () => {
    const { payload } = await runGraph();
    assert.ok(
      payload.edges.some(e => e.source === 'hub' && e.target === 'beta'),
      'aliased link [[beta|Beta Page]] should resolve to beta',
    );
    // The capture group must not swallow the alias text after the pipe.
    assert.ok(!payload.edges.some(e => e.target.includes('|')));
    assert.ok(!payload.edges.some(e => e.target === 'Beta Page'));
  });

  it('drops a wiki link with no matching node', async () => {
    const { payload } = await runGraph();
    assert.ok(!payload.edges.some(e => e.target === 'ghost'));
    assert.ok(!payload.edges.some(e => e.target.endsWith('ghost')));
  });
});
