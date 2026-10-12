import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  basename, buildTree, comparePath, dirname, invalidName, join, movedPath, tabChanges, visibleRows, within,
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

  it('keeps a compare tab below its file, so it follows the file\'s renames and deletion', () => {
    const tab = comparePath('papers/a/ms.tex', 12);
    assert.equal(dirname(tab), 'papers/a/ms.tex');
    assert.equal(movedPath(tab, 'papers/a/ms.tex', 'papers/a/main.tex'), comparePath('papers/a/main.tex', 12));
    assert.equal(movedPath(tab, 'papers', 'archive'), comparePath('archive/a/ms.tex', 12));
    assert.equal(within(tab, 'papers/a/ms.tex'), true);
    assert.equal(within(tab, 'papers/a/ms'), false);
  });

  it('refuses names that are not one path segment', () => {
    assert.equal(invalidName('ok.md'), null);
    assert.ok(invalidName(' '));
    assert.ok(invalidName('a/b'));
    assert.ok(invalidName('..'));
  });

  it('reads a batch of changes made elsewhere as moves to follow, then deletes and writes at the paths they lead to', () => {
    const {moves, deleted, written} = tabChanges([
      {seq: 1, op: 'write', path: 'papers/a/ms.tex'},
      {seq: 2, op: 'move', fromPath: 'papers/a', path: 'archive/a'},
      {seq: 3, op: 'move', fromPath: 'papers/a/ms.tex', path: 'archive/a/ms.tex'},
      {seq: 4, op: 'delete', path: 'old'},
      {seq: 5, op: 'write', path: 'old/notes.md'},
      {seq: 6, op: 'delete', path: 'old/notes.md'},
      {seq: 7, op: 'delete', path: 'gone.md'},
      {seq: 8, op: 'create', path: 'gone.md'},
      {seq: 9, op: 'write', path: 'readme.md'},
      {seq: 10, op: 'write', path: 'readme.md'},
      {seq: 11, op: 'access', path: 'readme.md'},
    ]);
    assert.deepEqual(moves, [['papers/a', 'archive/a'], ['papers/a/ms.tex', 'archive/a/ms.tex']]);
    assert.deepEqual([...deleted].sort(), ['old', 'old/notes.md']);
    assert.deepEqual([...written], [['archive/a/ms.tex', 1], ['gone.md', 8], ['readme.md', 10]]);
  });

  it('forgets a delete at a path something then moved to', () => {
    const {deleted} = tabChanges([
      {seq: 1, op: 'delete', path: 'a.md'},
      {seq: 2, op: 'move', fromPath: 'b.md', path: 'a.md'},
    ]);
    assert.deepEqual([...deleted], []);
  });
});
