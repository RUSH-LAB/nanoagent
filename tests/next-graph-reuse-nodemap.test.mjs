import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// Fixture for GET /api/graph. Only hub.md carries wiki links, so the resolved
// edge order is deterministic (document order of the [[...]] matches). The hub
// exercises every edge-resolution branch:
//   • [[docs/algebra]]  — resolves by full node id            (own key of nodeMap)
//   • [[calculus]]      — resolves by the last-segment fallback to guides/calculus
//   • [[ghost]]         — no node, no fallback match → dropped
//   • [[constructor]]   — names an inherited Object property → must be dropped
//   • [[toString]]      — names an inherited Object property → must be dropped
// The last two guard the own-key check: a plain `targetId in nodeMap` (or a
// truthiness test) would falsely resolve them against Object.prototype.
const FIXTURE = {
  'hub.md': '---\ntitle: Hub\n---\n\nLinks: [[docs/algebra]] [[calculus]] [[ghost]] [[constructor]] [[toString]]\n',
  'docs/algebra.md': '---\ntitle: Algebra\n---\n\n# Algebra\n',
  'guides/calculus.md': '---\ntitle: Calculus\n---\n\n# Calculus\n',
};

// Expected nodes (one per fixture file). Compared order-independently because
// the handler does not sort nodes and fs.readdirSync order is platform-defined.
const EXPECTED_NODES = [
  { id: 'docs/algebra', path: 'docs/algebra.md', title: 'Algebra', category: 'docs' },
  { id: 'guides/calculus', path: 'guides/calculus.md', title: 'Calculus', category: 'guides' },
  { id: 'hub', path: 'hub.md', title: 'Hub', category: '' },
];

// Expected resolved edges, in document order. The fallback link resolves to the
// FULL node id (guides/calculus), and every unresolvable target is dropped.
const EXPECTED_EDGES = [
  { source: 'hub', target: 'docs/algebra' },
  { source: 'hub', target: 'guides/calculus' },
];

const byId = (a, b) => a.id.localeCompare(b.id);

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-reuse-nodemap-'));
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

describe('GET /api/graph reuses nodeMap for edge resolution', () => {
  it('returns the exact {nodes, edges} payload (resolved edges unchanged after the refactor)', async () => {
    const { status, payload } = await runGraph();
    assert.equal(status, 200);
    assert.deepEqual([...payload.nodes].sort(byId), EXPECTED_NODES);
    assert.deepEqual(payload.edges, EXPECTED_EDGES);
  });

  it('resolves a wiki link that matches a full node id', async () => {
    const { payload } = await runGraph();
    assert.ok(
      payload.edges.some(e => e.source === 'hub' && e.target === 'docs/algebra'),
      'full-id link [[docs/algebra]] should resolve to docs/algebra',
    );
  });

  it('resolves a last-segment fallback wiki link to the full node id', async () => {
    const { payload } = await runGraph();
    assert.ok(
      payload.edges.some(e => e.source === 'hub' && e.target === 'guides/calculus'),
      'fallback link [[calculus]] should resolve to guides/calculus',
    );
    // It must NOT keep the bare last segment as the target.
    assert.ok(!payload.edges.some(e => e.target === 'calculus'));
  });

  it('drops an unresolvable wiki link', async () => {
    const { payload } = await runGraph();
    assert.ok(!payload.edges.some(e => e.target === 'ghost'));
    assert.ok(!payload.edges.some(e => e.target.endsWith('ghost')));
  });

  it('drops wiki links naming inherited Object properties (own-key check, not `in`)', async () => {
    const { payload } = await runGraph();
    // With a plain `in` test these would falsely match Object.prototype members.
    assert.ok(!payload.edges.some(e => e.target === 'constructor'));
    assert.ok(!payload.edges.some(e => e.target === 'toString'));
    assert.equal(payload.edges.length, EXPECTED_EDGES.length);
  });
});
