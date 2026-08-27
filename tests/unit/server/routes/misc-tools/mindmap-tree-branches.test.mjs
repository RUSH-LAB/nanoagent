import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Characterization test for the GET /api/file/mindmap handler in
// server/routes/misc-tools.js. The sibling suite next-misc-mindmap-cache.test.mjs
// pins the cache wrapper (filemindmap: key, 30000 ms TTL, per-path keying, 400/404)
// over ONE flat fixture, so the inner transform's branch logic is uncovered. This
// add-only suite pins that transform's tree arms: the heading-text cleanup regex,
// the level cap (headings one through four only, five and six silently dropped), the
// stack-based dedent, and the level-jump / sibling-resumption shape. No source is
// touched; goldens were captured from the REAL handler and spliced in below.
//
// misc-tools.js is CommonJS; load it via createRequire the way the sibling per-path
// cache suites do, and reuse the same ctx-mocking shape: a pass-through cached
// (_k, _t, fn) => fn() that reproduces the exact pre-cache code path, plus an
// in-memory fs.readFileSync keyed by absolute path. No network, no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';

// Drive GET /api/file/mindmap with a mocked ctx for a single file whose content is
// `body`, keyed (as the handler reads it) by path.join(PROJECT_ROOT, filePath). The
// pass-through cached() runs fn() inline, so what is captured is exactly the inner
// transform's output. Returns the { status, payload } handed to json().
async function invoke(filePath, body) {
  const pathname = '/api/file/mindmap';
  const url = new URL(`http://localhost${pathname}?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  const absPath = path.join(PROJECT_ROOT, filePath);
  let captured = null;
  const ctx = {
    fs: {
      readFileSync(fp) {
        if (fp === absPath) return body;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
    path,
    PROJECT_ROOT,
    isValidFilePath: () => true,
    cached: (_k, _t, fn) => fn(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// Collect every node's text in a depth-first walk, so a negative assertion can prove
// a heading (e.g. the dropped level-five) is ABSENT from the whole tree, not merely
// missing at one position.
function allTexts(node, acc = []) {
  acc.push(node.text);
  for (const c of node.children) allTexts(c, acc);
  return acc;
}

describe('GET /api/file/mindmap tree branches (characterization)', () => {
  // ── heading-text cleanup regex ──────────────────────────────────────────────
  // m[2].replace(/[*_`\[\]]/g, '').trim(): a heading carrying bold (**), italic (_),
  // inline code (`), and a bracketed token has every one of those markers stripped
  // and the remainder trimmed. The four words survive in order, single-spaced.
  it('strips markdown markers (** _ ` [ ]) from heading text', async () => {
    const rel = 'content/cleanup-sample.md';
    const body = '# **Bold** _italic_ `code` [bracket]\n\nBody text.\n';
    const r = await invoke(rel, body);
    assert.equal(r.status, 200);
    // Full payload golden captured from the real handler.
    assert.deepEqual(r.payload, {
      root: {
        text: 'cleanup-sample',
        children: [
          { text: 'Bold italic code bracket', children: [] },
        ],
      },
    });
    // Non-vacuous spotlight on the cleaned node text per the cleanup arm.
    assert.deepEqual(r.payload.root.children[0].text, 'Bold italic code bracket');
    // Every stripped marker is provably gone from the cleaned text.
    for (const marker of ['*', '_', '`', '[', ']']) {
      assert.ok(!r.payload.root.children[0].text.includes(marker), `marker ${marker} stripped`);
    }
  });

  // ── level cap: headings one through four only ────────────────────────────────
  // /^(#{1,4})\s+(.+)/ matches at most four leading #, so a level-five heading never
  // matches (the fifth # sits where \s+ expects whitespace). Level four nests under
  // level three; level five is absent from the tree entirely.
  it('caps headings at level four and drops level five', async () => {
    const rel = 'content/levels-sample.md';
    const body = '# Level One\n## Level Two\n### Level Three\n#### Level Four\n##### Level Five\n';
    const r = await invoke(rel, body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      root: {
        text: 'levels-sample',
        children: [
          {
            text: 'Level One',
            children: [
              {
                text: 'Level Two',
                children: [
                  {
                    text: 'Level Three',
                    children: [
                      { text: 'Level Four', children: [] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    // Level four really is the deepest node, nested under level three.
    const l3 = r.payload.root.children[0].children[0].children[0];
    assert.equal(l3.text, 'Level Three');
    assert.equal(l3.children.length, 1);
    assert.equal(l3.children[0].text, 'Level Four');
    assert.deepEqual(l3.children[0].children, []);
    // The dropped level-five heading appears nowhere in the tree.
    const texts = allTexts(r.payload.root);
    assert.ok(texts.includes('Level Four'), 'level four is kept');
    assert.ok(!texts.includes('Level Five'), 'level five is dropped by the #{1,4} cap');
  });

  // ── dedent and level jump ────────────────────────────────────────────────────
  // While stack top level >= current level, pop. Document: # A, ### deep, ## B,
  // ### C. `deep` (level 3) jumps in under A (no level 2 precedes it). B (level 2)
  // pops `deep` and lands as A's second child. C (level 3) nests under B.
  it('dedents on shallower headings and resumes siblings after a level jump', async () => {
    const rel = 'content/dedent-sample.md';
    const body = '# A\n### deep\n## B\n### C\n';
    const r = await invoke(rel, body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      root: {
        text: 'dedent-sample',
        children: [
          {
            text: 'A',
            children: [
              { text: 'deep', children: [] },
              {
                text: 'B',
                children: [
                  { text: 'C', children: [] },
                ],
              },
            ],
          },
        ],
      },
    });
    const a = r.payload.root.children[0];
    assert.equal(a.text, 'A');
    // deep (the level jump) and B are both A's children, in source order.
    assert.deepEqual(a.children.map(c => c.text), ['deep', 'B']);
    // deep is a leaf; the multi-pop on B did not re-parent C under deep.
    assert.deepEqual(a.children[0].children, []);
    // C resumes one level deep under the sibling B.
    assert.deepEqual(a.children[1].children.map(c => c.text), ['C']);
  });

  // ── basename title and empty body ────────────────────────────────────────────
  // title = filePath.replace(/^.*\//, '').replace(/\.(md|mdx)$/, ''): nested
  // directories are stripped and the .md / .mdx extension removed. A frontmatter-only
  // file (and a prose-only file with no headings) yields a childless root.
  it('titles the root from the basename and yields empty children for a headingless body', async () => {
    // Frontmatter-only, nested directories, .md extension.
    const fmRel = 'content/notes/sub/deep-note.md';
    const fmBody = '---\ntitle: Empty\ndate: 2026-01-01\n---\n';
    const fm = await invoke(fmRel, fmBody);
    assert.equal(fm.status, 200);
    assert.deepEqual(fm.payload, { root: { text: 'deep-note', children: [] } });
    assert.equal(fm.payload.root.text, 'deep-note');
    assert.deepEqual(fm.payload.root.children, []);

    // Prose-only (no headings), nested directories, .mdx extension.
    const proseRel = 'content/notes/sub/prose-note.mdx';
    const proseBody = 'Just prose, no headings here.\n\nAnother paragraph.\n';
    const prose = await invoke(proseRel, proseBody);
    assert.equal(prose.status, 200);
    assert.deepEqual(prose.payload, { root: { text: 'prose-note', children: [] } });
    assert.equal(prose.payload.root.text, 'prose-note');
    assert.deepEqual(prose.payload.root.children, []);
  });
});
