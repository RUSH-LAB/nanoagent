import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the sibling /api/graph route
// suites do (next-graph-hoist-wikire, next-graph-reuse-nodemap).
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// ── Why this hoist is behavior-preserving ───────────────────────────────────
// collectGraphFiles used to call entry.name.replace(/\.(mdx?|md)$/, '') TWICE per
// file: once to seed `title`, once again in the equality guard that decides whether
// to fall back to the first "# " heading. entry.name never changes between the two
// calls and the regex is NON-global (no lastIndex state), so both calls always
// returned the identical string. Computing it once into `const strippedName` and
// reusing it for both the seed and the guard cannot change which branch fires, so
// every node title is byte-identical. The separate line that derives the route `id`
// from `relPath` (a DIFFERENT receiver) is untouched.
//
// The fixture exercises every title branch the guard controls:
//   • plain-note.md  — no frontmatter, no heading  → title stays the stripped
//                       filename (guard fires, finds no heading)
//   • heading-note.md— no frontmatter, a "# " heading → guard fires, heading wins
//   • fm-note.md     — frontmatter title present → title differs from strippedName,
//                       so the guard must NOT fire (its "# " heading is ignored)
//   • fm-no-title.md — frontmatter present but with no title field → title stays the
//                       stripped filename, so the guard still fires (heading wins)
//   • books/algebra/intro.md — nested file whose route id comes from relPath, proving
//                       the id stays distinct from the stripped basename `intro`
const FIXTURE = {
  'plain-note.md': 'Just plain prose with no frontmatter and no heading line.\n',
  'heading-note.md': '# Heading From Hash\n\nSee [[plain-note]] for more.\n',
  'fm-note.md': '---\ntitle: Front Matter Wins\n---\n\n# Should Be Ignored\n\nbody text\n',
  'fm-no-title.md': '---\ndraft: false\n---\n\n# Heading Wins Anyway\n\nbody text\n',
  'books/algebra/intro.md': '---\ntitle: Algebra Intro\n---\n\n# Algebra\n\nIntro body.\n',
};

// One node per fixture file. Compared order-independently (the handler does not sort
// nodes and fs.readdirSync order is platform-defined). The nested file's id is the
// relPath-derived 'books/algebra/intro' (NOT the stripped basename 'intro'), and its
// category collapses books/<x> to <x>.
const EXPECTED_NODES = [
  { id: 'books/algebra/intro', path: path.join('books', 'algebra', 'intro.md'), title: 'Algebra Intro', category: 'algebra' },
  { id: 'fm-no-title', path: 'fm-no-title.md', title: 'Heading Wins Anyway', category: '' },
  { id: 'fm-note', path: 'fm-note.md', title: 'Front Matter Wins', category: '' },
  { id: 'heading-note', path: 'heading-note.md', title: 'Heading From Hash', category: '' },
  { id: 'plain-note', path: 'plain-note.md', title: 'plain-note', category: '' },
];

// The single wiki link [[plain-note]] in heading-note.md resolves to the own key
// 'plain-note' in nodeMap. No other file carries a link, so this is the only edge.
const EXPECTED_EDGES = [{ source: 'heading-note', target: 'plain-note' }];

const byId = (a, b) => a.id.localeCompare(b.id);

// Independent re-implementation of the PRE-hoist title resolution. It deliberately
// recomputes name.replace(...) TWICE, exactly as the code did before the hoist, and
// the hoisted handler must agree with it for every file (the behavior-preservation
// claim). `name` is the file's basename, i.e. the handler's entry.name.
function referenceTitle(name, content) {
  let title = name.replace(/\.(mdx?|md)$/, '');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (titleMatch) title = titleMatch[1];
  }
  if (title === name.replace(/\.(mdx?|md)$/, '')) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) title = headingMatch[1];
  }
  return title;
}

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-strippedname-'));
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

describe('GET /api/graph computes the extension-stripped filename once (strippedName)', () => {
  it('returns the expected nodes and the resolved edge', async () => {
    const { status, payload } = await runGraph();
    assert.equal(status, 200);
    assert.deepEqual([...payload.nodes].sort(byId), [...EXPECTED_NODES].sort(byId));
    assert.deepEqual(payload.edges, EXPECTED_EDGES);
  });

  it('every node title matches an independent re-implementation of the pre-hoist logic', async () => {
    const { payload } = await runGraph();
    // Key titles by a separator-normalized path so the comparison is platform-stable.
    const titleByPath = Object.fromEntries(
      payload.nodes.map(n => [n.path.split(path.sep).join('/'), n.title]),
    );
    for (const [rel, body] of Object.entries(FIXTURE)) {
      const base = rel.split('/').pop();
      assert.equal(
        titleByPath[rel],
        referenceTitle(base, body),
        `title for ${rel} must equal the pre-hoist reference`,
      );
    }
  });

  it('falls back to the bare filename when there is no frontmatter and no heading', async () => {
    const { payload } = await runGraph();
    const plain = payload.nodes.find(n => n.id === 'plain-note');
    assert.equal(plain.title, 'plain-note');
  });

  it('lets a heading win when the seed still equals the stripped filename (guard fires)', async () => {
    const { payload } = await runGraph();
    // No frontmatter at all: seed === strippedName, heading supplies the title.
    assert.equal(payload.nodes.find(n => n.id === 'heading-note').title, 'Heading From Hash');
    // Frontmatter present but no title field: seed still === strippedName, so the
    // guard fires and the heading still wins.
    assert.equal(payload.nodes.find(n => n.id === 'fm-no-title').title, 'Heading Wins Anyway');
  });

  it('keeps the frontmatter title and ignores the heading (guard does NOT fire)', async () => {
    const { payload } = await runGraph();
    const fm = payload.nodes.find(n => n.id === 'fm-note');
    assert.equal(fm.title, 'Front Matter Wins');
    // The "# Should Be Ignored" heading must never override a frontmatter title.
    assert.notEqual(fm.title, 'Should Be Ignored');
  });

  it('derives the route id from relPath, distinct from the stripped basename', async () => {
    const { payload } = await runGraph();
    const nested = payload.nodes.find(n => n.title === 'Algebra Intro');
    // strippedName for this file is the basename 'intro'; the id must instead be the
    // full relPath-derived route, proving the id computation was left untouched.
    assert.equal(nested.id, 'books/algebra/intro');
    assert.equal(nested.category, 'algebra');
  });

  it('is byte-identical across two back-to-back calls', async () => {
    const first = await runGraph();
    const second = await runGraph();
    assert.equal(first.status, 200);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
  });
});

describe('graph-trash-files.js source: the /api/graph handler strips each filename once', () => {
  it('computes const strippedName once and reuses it for both the seed and the guard', () => {
    const src = readFileSync(new URL('../server/routes/graph-trash-files.js', import.meta.url), 'utf-8');
    // Slice just the GET /api/graph handler block: from its pathname guard up to the
    // next handler (GET /api/trash). Both markers are ASCII string literals.
    const startIdx = src.indexOf("pathname === '/api/graph'");
    const endIdx = src.indexOf("pathname === '/api/trash'");
    assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, 'handler block anchors present and ordered');
    const block = src.slice(startIdx, endIdx);

    // The stripped filename is computed exactly once.
    assert.ok(block.includes('const strippedName = entry.name.replace'), 'expected the hoisted "const strippedName = entry.name.replace"');
    // Both the seed and the equality guard reuse it.
    assert.ok(block.includes('let title = strippedName'), 'the title seed must reuse strippedName');
    assert.ok(block.includes('if (title === strippedName)'), 'the equality guard must reuse strippedName');
    // The old second recompute in the guard is gone.
    assert.ok(!block.includes('title === entry.name.replace'), 'the old "title === entry.name.replace" second recompute must be gone');
    // The route id keeps deriving from relPath (a different receiver), untouched.
    assert.ok(block.includes('let id = relPath.replace('), 'the relPath-based id computation must stay intact');
  });
});
