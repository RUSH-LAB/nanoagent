import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the sibling /api/graph route
// suites do (next-graph-hoist-wikire, next-graph-reuse-nodemap,
// next-graph-strippedname-hoist).
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// ── Why this hoist is behavior-preserving ───────────────────────────────────
// In the edge-resolution loop, when a wiki-link targetId is NOT a direct nodeMap
// key, the else branch scans every node with nodes.find(...). It used to rebuild
// `'/' + targetId` inside the predicate, re-concatenating it for every node tried
// before a match. targetId is fixed for the whole .find: it is `let targetId =
// edge.target` and is only READ between that declaration and this .find (the
// earlier hasOwnProperty branch that could reassign it pushes/returns and never
// falls through to the else). Binding `'/' + targetId` once into `const
// slashTarget` and reusing it therefore yields the identical endsWith(...) boolean
// for every node, hence the same first match (find order preserved) and the same
// resolvedEdges. There is no await in the loop and the result is memoized under
// the static 'graph-data' cache key, so the cached payload is byte-identical.
//
// Note the two disjuncts are not independent: any id ending with `/` + targetId
// also ends with targetId, so n.id.endsWith(slashTarget) is logically subsumed by
// n.id.endsWith(targetId) and, under the ||, can never flip the result. The hoist's
// only effect is to skip rebuilding `/` + targetId for each non-matching node the
// .find scans. These tests therefore pin that the else-branch nodes.find (the line
// that now reads slashTarget) still resolves edges identically; they do not claim
// slashTarget is the deciding disjunct, since no input can make it the sole match.
//
// The fixture exercises every edge-resolution branch, with hub.md the only file
// carrying links so the resolved-edge order is deterministic (document order of
// the [[...]] matches):
//   • [[linear-algebra]] — bare last segment, NOT a nodeMap key, so it falls to
//                          the else branch and runs nodes.find (the line that now
//                          reads slashTarget), resolving to the node id
//                          guides/linear-algebra (matched by the bare
//                          endsWith(targetId) disjunct, per the note above).
//   • [[docs/intro]]     — a full node id, resolved by the own-key hasOwnProperty
//                          branch (it never reaches the else / .find).
//   • [[ghost]]          — no node ends with `ghost` or `/ghost`, so the else
//                          branch's .find returns undefined and the edge is dropped.
const FIXTURE = {
  'hub.md': '---\ntitle: Hub\n---\n\nLinks: [[linear-algebra]] [[docs/intro]] [[ghost]]\n',
  'guides/linear-algebra.md': '---\ntitle: Linear Algebra\n---\n\n# Linear Algebra\n',
  'docs/intro.md': '---\ntitle: Intro\n---\n\n# Intro\n',
};

// One node per fixture file. Compared order-independently (the handler does not
// sort nodes and fs.readdirSync order is platform-defined). Nested paths use
// path.join so the `path` field is platform-stable.
const EXPECTED_NODES = [
  { id: 'docs/intro', path: path.join('docs', 'intro.md'), title: 'Intro', category: 'docs' },
  { id: 'guides/linear-algebra', path: path.join('guides', 'linear-algebra.md'), title: 'Linear Algebra', category: 'guides' },
  { id: 'hub', path: 'hub.md', title: 'Hub', category: '' },
];

// Resolved edges, in document order. The bare last segment resolves to the FULL
// node id via the else-branch nodes.find, the full id resolves by own key, and
// the unresolvable target is dropped.
const EXPECTED_EDGES = [
  { source: 'hub', target: 'guides/linear-algebra' },
  { source: 'hub', target: 'docs/intro' },
];

const byId = (a, b) => a.id.localeCompare(b.id);

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-slashtarget-'));
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
// json() response. A pass-through cached() keeps the suite exercising the real
// fs-backed walk (mirrors the sibling /api/graph suites).
async function runGraph() {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/graph');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await graphRoutes(req, res, url, '/api/graph', ctx);
  return captured;
}

describe('GET /api/graph hoists the "/" + targetId concat into slashTarget', () => {
  it('returns the exact {nodes, edges} payload (resolved edges unchanged after the hoist)', async () => {
    const { status, payload } = await runGraph();
    assert.equal(status, 200);
    assert.deepEqual([...payload.nodes].sort(byId), [...EXPECTED_NODES].sort(byId));
    assert.deepEqual(payload.edges, EXPECTED_EDGES);
  });

  it('resolves a bare last-segment link through the else-branch nodes.find', async () => {
    const { payload } = await runGraph();
    // [[linear-algebra]] is not a nodeMap key, so it must fall to the else branch
    // and resolve to the FULL node id whose tail is `/linear-algebra`.
    assert.ok(
      payload.edges.some(e => e.source === 'hub' && e.target === 'guides/linear-algebra'),
      'fallback link [[linear-algebra]] should resolve to guides/linear-algebra',
    );
    // It must NOT keep the bare last segment as the target.
    assert.ok(!payload.edges.some(e => e.target === 'linear-algebra'));
  });

  it('resolves a full node id by own key without touching the else branch', async () => {
    const { payload } = await runGraph();
    assert.ok(
      payload.edges.some(e => e.source === 'hub' && e.target === 'docs/intro'),
      'full-id link [[docs/intro]] should resolve to docs/intro',
    );
  });

  it('drops an unresolvable wiki link (else-branch .find returns undefined)', async () => {
    const { payload } = await runGraph();
    assert.ok(!payload.edges.some(e => e.target === 'ghost'));
    assert.ok(!payload.edges.some(e => e.target.endsWith('ghost')));
    assert.equal(payload.edges.length, EXPECTED_EDGES.length);
  });

  it('is byte-identical across two back-to-back calls', async () => {
    const first = await runGraph();
    const second = await runGraph();
    assert.equal(first.status, 200);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
  });
});

describe('graph-trash-files.js source: the /api/graph else branch binds slashTarget once', () => {
  it('declares const slashTarget once and the .find predicate reuses it', () => {
    const src = fs.readFileSync(new URL('../server/routes/graph-trash-files.js', import.meta.url), 'utf-8');
    // Slice just the GET /api/graph handler block: from its pathname guard up to
    // the next handler (GET /api/trash). Both markers are ASCII string literals.
    const startIdx = src.indexOf("pathname === '/api/graph'");
    const endIdx = src.indexOf("pathname === '/api/trash'");
    assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, 'handler block anchors present and ordered');
    const block = src.slice(startIdx, endIdx);

    // The slash-prefixed target is concatenated exactly once, immediately before
    // the nodes.find scan.
    assert.ok(block.includes("const slashTarget = '/' + targetId;"), 'expected the hoisted "const slashTarget = \'/\' + targetId;"');
    // The .find predicate reuses slashTarget for the path-boundary suffix test.
    assert.ok(block.includes('n.id.endsWith(slashTarget)'), 'the .find predicate must read n.id.endsWith(slashTarget)');
    // The first (bare-suffix) disjunct stays intact.
    assert.ok(block.includes('n.id.endsWith(targetId)'), 'the bare-suffix disjunct n.id.endsWith(targetId) must remain');
    // The old per-iteration concat inside the predicate is gone.
    assert.ok(!block.includes("n.id.endsWith('/' + targetId)"), "the old inline \"n.id.endsWith('/' + targetId)\" must be gone");
  });
});
