import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/files.js is a CommonJS module whose default export is the GET /api/files
// handler; buildTree is attached additively as a property for unit testing.
const require = createRequire(import.meta.url);
const filesModule = require('../api/files.js');
const buildTree = filesModule.buildTree;
const { ALLOWED_EXTS } = require('../api/_github.js');

// This suite pins the `const last = segments.length - 1` hoist in buildTree.
// The hoist caches the final segment index once per entry, then reuses it for
// both the inner directory-loop guard (i < last) and the file-node name
// (segments[last]). The two cases that catch any off-by-one are:
//   1. a deeply nested entry, so the inner loop iterates more than once and the
//      file lands at segments[last] several levels down, and
//   2. a top-level file, where segments.length === 1 so last === 0, the inner
//      loop never runs, and the file is named segments[0].
// If `last` were segments.length (over by one) the loop would over-run and the
// file name would read an out-of-range segment, so these assertions fail loudly.

// Insertion order is significant: buildTree is insertion-ordered, creating each
// directory at the position of the first file seen beneath it. The two guide/
// files exercise the depth-3 path (inner loop runs twice and reuses docs+guide),
// api.md exercises a depth-2 path (loop runs once), readme.md is the top-level
// file, and the trailing two entries confirm non-blob and disallowed-extension
// filtering still holds after the hoist.
const FIXTURE = [
  { path: 'content/readme.md', type: 'blob', size: 11 },
  { path: 'content/docs/guide/intro.md', type: 'blob', size: 22 },
  { path: 'content/docs/guide/setup.mdx', type: 'blob', size: 33 },
  { path: 'content/docs/api.md', type: 'blob', size: 44 },
  { path: 'content/notes', type: 'tree', size: 0 },          // non-blob: filtered out
  { path: 'content/image.png', type: 'blob', size: 55 },     // disallowed ext: filtered out
];

const EXPECTED = [
  { name: 'readme.md', path: 'content/readme.md', type: 'file', size: 11 },
  {
    name: 'docs',
    path: 'content/docs',
    type: 'directory',
    children: [
      {
        name: 'guide',
        path: 'content/docs/guide',
        type: 'directory',
        children: [
          { name: 'intro.md', path: 'content/docs/guide/intro.md', type: 'file', size: 22 },
          { name: 'setup.mdx', path: 'content/docs/guide/setup.mdx', type: 'file', size: 33 },
        ],
      },
      { name: 'api.md', path: 'content/docs/api.md', type: 'file', size: 44 },
    ],
  },
];

describe('buildTree const-last hoist: nested tree and last-segment placement', () => {
  it('builds the expected nested tree for content/', () => {
    assert.deepStrictEqual(buildTree(FIXTURE, 'content'), EXPECTED);
  });

  it('is byte-identical including key order (the tree is JSON-serialized on the wire)', () => {
    assert.equal(JSON.stringify(buildTree(FIXTURE, 'content')), JSON.stringify(EXPECTED));
  });

  it('places the top-level file at last === 0 (inner loop never runs)', () => {
    const tree = buildTree(FIXTURE, 'content');
    const top = tree.find(n => n.type === 'file');
    assert.equal(top.name, 'readme.md');
    assert.equal(top.path, 'content/readme.md');
  });

  it('names the deeply nested leaf with its final segment (segments[last] two levels down)', () => {
    const tree = buildTree(FIXTURE, 'content');
    const docs = tree.find(n => n.name === 'docs');
    const guide = docs.children.find(n => n.name === 'guide');
    const leafNames = guide.children.map(n => n.name);
    assert.deepStrictEqual(leafNames, ['intro.md', 'setup.mdx']);
    // Pin the node types too, so this test alone kills an over-by-one `last`
    // (which would over-run the loop and turn these leaves into directories).
    assert.deepStrictEqual(guide.children.map(n => n.type), ['file', 'file']);
    // The directory reuse keeps api.md a sibling of guide, not inside it.
    const docsChildNames = docs.children.map(n => n.name);
    assert.deepStrictEqual(docsChildNames, ['guide', 'api.md']);
    assert.deepStrictEqual(docs.children.map(n => n.type), ['directory', 'file']);
  });

  it('filters out non-blob and disallowed-extension entries', () => {
    const json = JSON.stringify(buildTree(FIXTURE, 'content'));
    assert.ok(!json.includes('notes'), 'non-blob entry must be excluded');
    assert.ok(!json.includes('image.png'), 'disallowed extension must be excluded');
  });
});

// Independent oracle: a from-scratch per-level rescan (the shape buildTree
// produces) confirms the hoisted index math matches a different traversal for
// several inputs, including shuffled and deeper-than-the-fixture paths.
function referenceBuildTree(entries, rootDir) {
  const prefix = rootDir ? rootDir + '/' : '';
  const relevant = entries.filter(e => {
    if (e.type !== 'blob') return false;
    if (!e.path.startsWith(prefix)) return false;
    return ALLOWED_EXTS.some(ext => e.path.endsWith(ext));
  });
  function buildLevel(dirPath) {
    const children = [];
    const seen = new Set();
    const levelPrefix = dirPath + '/';
    for (const e of relevant) {
      if (!e.path.startsWith(levelPrefix)) continue;
      const rest = e.path.slice(levelPrefix.length);
      if (rest.includes('/')) {
        const subDir = rest.split('/')[0];
        const subDirPath = dirPath + '/' + subDir;
        if (!seen.has(subDirPath)) {
          seen.add(subDirPath);
          children.push({
            name: subDir,
            path: subDirPath,
            type: 'directory',
            children: buildLevel(subDirPath),
          });
        }
      } else {
        children.push({ name: rest, path: e.path, type: 'file', size: e.size });
      }
    }
    return children;
  }
  return buildLevel(rootDir || '');
}

describe('buildTree const-last hoist: equivalence to an independent oracle', () => {
  const cases = [
    ['representative fixture', FIXTURE, 'content'],
    ['sub-root content/docs', FIXTURE, 'content/docs'],
    [
      'deeper, shuffled order',
      [
        { path: 'content/w/x/y/z/leaf.md', type: 'blob', size: 1 },
        { path: 'content/top.md', type: 'blob', size: 2 },
        { path: 'content/w/x/mid.mdx', type: 'blob', size: 3 },
        { path: 'content/w/x/y/z/leaf2.md', type: 'blob', size: 4 },
        { path: 'content/w/first.md', type: 'blob', size: 5 },
        { path: 'content/skip.txt', type: 'blob', size: 6 },   // disallowed ext
      ],
      'content',
    ],
    ['empty entries', [], 'content'],
  ];
  for (const [label, entries, rootDir] of cases) {
    it(`equals the oracle for: ${label}`, () => {
      const got = buildTree(entries, rootDir);
      const want = referenceBuildTree(entries, rootDir);
      assert.deepStrictEqual(got, want);
      assert.equal(JSON.stringify(got), JSON.stringify(want));
    });
  }
});
