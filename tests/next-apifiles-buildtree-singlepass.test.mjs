import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/files.js is a CommonJS module whose default export is the GET /api/files
// handler; buildTree is attached additively as a property for unit testing.
const require = createRequire(import.meta.url);
const filesModule = require('../api/files.js');
const buildTree = filesModule.buildTree;
const { ALLOWED_EXTS } = require('../api/_github.js');

// Faithful copy of the ORIGINAL (pre-optimization) buildTree, kept as a golden
// oracle. The optimized single-pass buildTree must stay byte-identical to this
// for every input. This is the per-level rescan implementation it replaced.
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

// Collect every node name in the tree (depth-first) for membership checks.
function collectNames(nodes) {
  const out = [];
  for (const n of nodes) {
    out.push(n.name);
    if (n.children) out.push(...collectNames(n.children));
  }
  return out;
}

// Representative fixture: files at the root, a nested directory, a deeper
// directory, entries interleaved out of tree order, plus a non-blob entry and
// a disallowed-extension entry that must both be filtered out. The deeper file
// (posts/sub/deep.mdx) precedes posts/b.md so the directory ordering is exercised.
const FIXTURE = [
  { path: 'content/intro.md', type: 'blob', size: 10 },
  { path: 'content/posts/a.md', type: 'blob', size: 20 },
  { path: 'content/guide.png', type: 'blob', size: 99 },          // disallowed ext
  { path: 'content/posts/sub/deep.mdx', type: 'blob', size: 30 },
  { path: 'content/notes', type: 'tree', size: 0 },               // non-blob
  { path: 'content/posts/b.md', type: 'blob', size: 40 },
  { path: 'content/changelog.md', type: 'blob', size: 50 },
];

describe('buildTree single-pass: byte-identical output', () => {
  it('matches the hardcoded expected tree for content/', () => {
    const expected = [
      { name: 'intro.md', path: 'content/intro.md', type: 'file', size: 10 },
      {
        name: 'posts',
        path: 'content/posts',
        type: 'directory',
        children: [
          { name: 'a.md', path: 'content/posts/a.md', type: 'file', size: 20 },
          {
            name: 'sub',
            path: 'content/posts/sub',
            type: 'directory',
            children: [
              { name: 'deep.mdx', path: 'content/posts/sub/deep.mdx', type: 'file', size: 30 },
            ],
          },
          { name: 'b.md', path: 'content/posts/b.md', type: 'file', size: 40 },
        ],
      },
      { name: 'changelog.md', path: 'content/changelog.md', type: 'file', size: 50 },
    ];
    assert.deepStrictEqual(buildTree(FIXTURE, 'content'), expected);
  });

  it('returns [] for the rootDir === "" edge case', () => {
    assert.deepStrictEqual(buildTree(FIXTURE, ''), []);
  });

  it('filters out non-blob and disallowed-extension entries', () => {
    const names = collectNames(buildTree(FIXTURE, 'content'));
    assert.ok(!names.includes('guide.png'), 'disallowed extension must be excluded');
    assert.ok(!names.includes('notes'), 'non-blob entry must be excluded');
  });

  it('matches the hardcoded expected tree for a sub-root (content/posts)', () => {
    const expected = [
      { name: 'a.md', path: 'content/posts/a.md', type: 'file', size: 20 },
      {
        name: 'sub',
        path: 'content/posts/sub',
        type: 'directory',
        children: [
          { name: 'deep.mdx', path: 'content/posts/sub/deep.mdx', type: 'file', size: 30 },
        ],
      },
      { name: 'b.md', path: 'content/posts/b.md', type: 'file', size: 40 },
    ];
    assert.deepStrictEqual(buildTree(FIXTURE, 'content/posts'), expected);
  });
});

describe('buildTree single-pass: equivalence to the original algorithm', () => {
  // Several inputs, including orders not hand-traced above, must produce output
  // byte-identical to the reference (original) implementation.
  const cases = [
    ['representative content/', FIXTURE, 'content'],
    ['rootDir === ""', FIXTURE, ''],
    ['sub-root content/posts', FIXTURE, 'content/posts'],
    ['undefined rootDir', FIXTURE, undefined],
    [
      'deeply nested, shuffled order',
      [
        { path: 'content/x/y/z/leaf.md', type: 'blob', size: 1 },
        { path: 'content/top.md', type: 'blob', size: 2 },
        { path: 'content/x/y/mid.md', type: 'blob', size: 3 },
        { path: 'content/x/first.md', type: 'blob', size: 4 },
        { path: 'content/x/y/z/leaf2.mdx', type: 'blob', size: 5 },
        { path: 'content/skip.txt', type: 'blob', size: 6 },     // disallowed
        { path: 'content/x', type: 'tree', size: 0 },            // non-blob
      ],
      'content',
    ],
    ['empty entries', [], 'content'],
  ];
  for (const [label, entries, rootDir] of cases) {
    it(`equals the original for: ${label}`, () => {
      const got = buildTree(entries, rootDir);
      const want = referenceBuildTree(entries, rootDir);
      // Structural equality of the tree shape and values.
      assert.deepStrictEqual(got, want);
      // Byte-level identity including key order, since the handler serializes
      // the tree with JSON.stringify on the wire (api/_github.js jsonResponse).
      assert.equal(JSON.stringify(got), JSON.stringify(want));
    });
  }
});

describe('buildTree single-pass: path-access metric', () => {
  it('reads each entry path at most once (no per-level rescan)', () => {
    const rawPaths = [
      'content/intro.md',
      'content/alpha/a.md',
      'content/beta/b.md',
      'content/gamma/c.md',
      'content/delta/d.md',
      'content/epsilon/e.md',
      'content/zeta/f.md',
      'content/alpha/deep/g.md',
      'content/cover.png',   // disallowed ext (still a blob)
      'content/assets',      // non-blob
    ];
    const nonBlob = new Set(['content/assets']);
    let accesses = 0;
    const entries = rawPaths.map(pth => ({
      type: nonBlob.has(pth) ? 'tree' : 'blob',
      size: 1,
      get path() {
        accesses++;
        return pth;
      },
    }));

    // maxDepth = deepest segment count below rootDir, computed without the getter.
    const maxDepth = Math.max(
      ...rawPaths.map(p => p.slice('content/'.length).split('/').length),
    );

    const tree = buildTree(entries, 'content');

    // The GOAL bound: the old per-level rescan scales with directory count and
    // exceeds entries.length * (maxDepth + 1); a single pass stays under it.
    assert.ok(
      accesses <= entries.length * (maxDepth + 1),
      `expected <= ${entries.length * (maxDepth + 1)} path reads, got ${accesses}`,
    );
    // Stronger single-pass guarantee: each entry's path is read at most once.
    assert.ok(
      accesses <= entries.length,
      `single pass must read each path at most once; got ${accesses} for ${entries.length} entries`,
    );
    // The tree was actually built, not short-circuited to [].
    assert.ok(tree.length > 0, 'expected a non-empty tree');
  });
});
