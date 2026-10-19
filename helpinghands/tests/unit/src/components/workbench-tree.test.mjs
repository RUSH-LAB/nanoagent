import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT, basename, buildTree, comparePath, copyName, dirname, entryProblem, invalidName, join, movedPath, quickOpenRows, tabChanges,
  topmost, treeIndex, within,
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

  it('sorts numbers in names by value and ignores case', () => {
    const names = ['step10.py', 'Step2.py', 'step1.py'];
    const tree = buildTree(names.map(path => ({path, size: 1, modified: 1})), []);
    assert.deepEqual(tree.children.map(node => node.name), ['step1.py', 'Step2.py', 'step10.py']);
  });

  it('shows a folder a file implies even when the listing omits it', () => {
    const tree = buildTree([{path: 'a/b/c.txt', size: 1, modified: 1}], []);
    assert.equal(tree.children[0].children[0].children[0].path, 'a/b/c.txt');
  });

  it('indexes the tree by path, the root as ROOT, folding single-folder chains into one row', () => {
    const tree = buildTree(files, ['papers', 'papers/attention', 'papers/attention/figures']);
    const items = treeIndex(tree);
    assert.deepEqual(items.get(ROOT).children, ['papers/attention', 'notes.txt', 'readme.md']);
    assert.equal(items.get('papers/attention').label, 'papers/attention');
    assert.deepEqual(items.get('papers/attention').children, ['papers/attention/figures', 'papers/attention/ms.tex']);
    assert.equal(items.has('papers'), false);
    assert.equal(treeIndex(tree, {compact: false}).get('papers').label, 'papers');
  });

  it('shows the member\'s home first, as home, and other members\' shared files under their names', () => {
    const tree = buildTree([
      ...files,
      {path: 'home/ada/plugins/echo/out.md', size: 1, modified: 1},
      {path: 'home/bob/shared.md', size: 1, modified: 1},
      {path: 'home/gone/old.md', size: 1, modified: 1},
    ], ['home', 'home/ada']);
    const home = {userId: 'ada', names: new Map([['ada', 'Ada'], ['bob', 'Bob']])};
    const items = treeIndex(tree, {home});
    assert.deepEqual(items.get(ROOT).children, ['home/ada', 'papers/attention', 'notes.txt', 'readme.md', 'home']);
    assert.equal(items.get('home/ada').label, 'home');
    assert.deepEqual(items.get('home/ada').children, ['home/ada/plugins/echo']);
    assert.equal(items.get('home').label, 'Shared with me');
    assert.deepEqual(items.get('home').children.map(id => items.get(id).label), ['Bob', 'A former member']);

    const fresh = treeIndex(buildTree(files, []), {home});
    assert.deepEqual(fresh.get(ROOT).children, ['home/ada', 'papers/attention', 'notes.txt', 'readme.md']);
    assert.deepEqual([fresh.get('home/ada').label, fresh.get('home/ada').children], ['home', []]);
  });

  it('names copies as VS Code does', () => {
    assert.equal(copyName('notes.txt', new Set(['notes.txt'])), 'notes copy.txt');
    assert.equal(copyName('notes.txt', new Set(['notes.txt', 'notes copy.txt'])), 'notes copy 2.txt');
    assert.equal(copyName('Makefile', new Set()), 'Makefile copy');
    assert.equal(copyName('v1.2', new Set(), {folder: true}), 'v1.2 copy');
    assert.equal(copyName('.env', new Set()), '.env copy');
  });

  it('keeps only the topmost of nested paths', () => {
    assert.deepEqual(topmost(['a', 'a/b.txt', 'ab', 'c/d']), ['a', 'ab', 'c/d']);
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

  it('refuses names that are not workspace paths, and allows / for nested folders', () => {
    assert.equal(invalidName('ok.md'), null);
    assert.equal(invalidName('a/b/ok.md'), null);
    assert.ok(invalidName(' '));
    assert.ok(invalidName('a\\b'));
    assert.ok(invalidName('/a'));
    assert.ok(invalidName('a/'));
    assert.ok(invalidName('a//b'));
    assert.ok(invalidName('..'));
    assert.ok(invalidName('a/./b'));
  });

  it('finds the problem with a new or renamed entry in the local tree', () => {
    const tree = buildTree(files, ['papers', 'papers/attention']);
    assert.equal(entryProblem(tree, '', 'new.md'), null);
    assert.equal(entryProblem(tree, 'papers', 'attention/new/ms.tex'), null);
    assert.equal(entryProblem(tree, '', 'readme.md'), 'readme.md already exists');
    assert.equal(entryProblem(tree, 'papers', 'attention'), 'papers/attention already exists');
    assert.equal(entryProblem(tree, '', 'readme.md/x.md'), 'readme.md is a file');
    assert.equal(entryProblem(tree, '', 'a//b'), invalidName('a//b'));
    assert.equal(entryProblem(tree, '', 'readme.md', 'readme.md'), null);
    assert.equal(entryProblem(tree, '', 'papers/inner', 'papers'), 'A folder cannot move inside itself');
  });
});

describe('quick open', () => {
  const paths = rows => rows.map(row => row.file.path);
  const many = [
    {path: 'step10.md'}, {path: 'step2.md'}, {path: 'src/tree.js'}, {path: 'src/test/tree.test.js'}, {path: 'notes.txt'},
  ];

  it('lists recent files first for an empty query, then the rest in path order', () => {
    assert.deepEqual(paths(quickOpenRows(many, ['notes.txt', 'gone.md', 'src/tree.js'], '')), [
      'notes.txt', 'src/tree.js', 'src/test/tree.test.js', 'step2.md', 'step10.md',
    ]);
  });

  it('ranks matches by score, then recent, then the shorter path', () => {
    assert.deepEqual(paths(quickOpenRows(many, [], 'tree')), ['src/tree.js', 'src/test/tree.test.js']);
    assert.deepEqual(paths(quickOpenRows(many, [], 'step')), ['step2.md', 'step10.md']);
    assert.deepEqual(paths(quickOpenRows(many, ['step10.md'], 'step')), ['step10.md', 'step2.md']);
  });

  it('drops what does not match and carries the matched indices', () => {
    assert.deepEqual(quickOpenRows(many, [], 'ntx'), [{file: {path: 'notes.txt'}, indices: [0, 6, 7]}]);
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
