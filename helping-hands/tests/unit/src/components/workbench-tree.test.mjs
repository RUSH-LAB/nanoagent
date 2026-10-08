import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  basename, buildTree, dirname, invalidName, join, movedPath, visibleRows, within,
} from '../../../../src/components/Workbench/tree.js';

const files = [
  {path: 'readme.md', size: 5, modified: 1},
  {path: 'papers/attention/ms.tex', size: 9, modified: 2},
  {path: 'papers/attention/figures/a.png', size: 3, modified: 3},
  {path: 'notes.txt', size: 1, modified: 4},
];

describe('workbench tree', () => {
  it('puts folders before files, each sorted, and shows empty folders', () => {
    const tree = buildTree(files, ['papers', 'papers/attention', 'papers/attention/figures', 'empty']);
    assert.deepEqual(tree.children.map(node => [node.type, node.name]), [
      ['folder', 'empty'], ['folder', 'papers'], ['file', 'notes.txt'], ['file', 'readme.md'],
    ]);
    assert.equal(tree.children[1].children[0].path, 'papers/attention');
  });

  it('shows a folder a file implies even when the listing omits it', () => {
    const tree = buildTree([{path: 'a/b/c.txt', size: 1, modified: 1}], []);
    assert.equal(tree.children[0].children[0].children[0].path, 'a/b/c.txt');
  });

  it('lists only the rows of open folders, with their depth', () => {
    const tree = buildTree(files, ['papers', 'papers/attention']);
    const rows = visibleRows(tree, new Set(['papers']));
    assert.deepEqual(rows.map(row => [row.node.path, row.depth]), [
      ['papers', 0], ['papers/attention', 1], ['notes.txt', 0], ['readme.md', 0],
    ]);
  });

  it('does path arithmetic', () => {
    assert.equal(basename('a/b/c.txt'), 'c.txt');
    assert.equal(dirname('a/b/c.txt'), 'a/b');
    assert.equal(dirname('c.txt'), '');
    assert.equal(join('', 'c.txt'), 'c.txt');
    assert.equal(join('a', 'c.txt'), 'a/c.txt');
    assert.equal(within('a/b', 'a'), true);
    assert.equal(within('ab', 'a'), false);
  });

  it('follows a rename or move into what was inside a folder', () => {
    assert.equal(movedPath('papers/a/ms.tex', 'papers/a', 'archive/a'), 'archive/a/ms.tex');
    assert.equal(movedPath('papers/ab/ms.tex', 'papers/a', 'archive/a'), 'papers/ab/ms.tex');
    assert.equal(movedPath('x.md', 'x.md', 'y.md'), 'y.md');
  });

  it('refuses names that are not one path segment', () => {
    assert.equal(invalidName('ok.md'), null);
    assert.ok(invalidName(' '));
    assert.ok(invalidName('a/b'));
    assert.ok(invalidName('..'));
  });
});
