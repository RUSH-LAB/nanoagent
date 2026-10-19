import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {closeIn, dropPaths, moveAll, moveTab, newGroup, showIn} from '../../../../src/components/Workbench/groups.js';

const shape = groups => groups.map(group => [group.paths, group.active]);

describe('workbench editor groups', () => {
  it('shows a file after the active tab, keeps one it has, and replaces a preview in place', () => {
    let groups = [newGroup()];
    groups = showIn(groups, 0, 'a');
    groups = showIn(groups, 0, 'b');
    groups = showIn(showIn(groups, 0, 'a'), 0, 'c');
    assert.deepEqual(shape(groups), [[['a', 'c', 'b'], 'c']]);
    assert.deepEqual(shape(showIn(groups, 0, 'd', {replacing: 'c'})), [[['a', 'd', 'b'], 'd']]);
  });

  it('opens a group to the side one past the last', () => {
    const groups = showIn(showIn([newGroup()], 0, 'a'), 1, 'a');
    assert.deepEqual(shape(groups), [[['a'], 'a'], [['a'], 'a']]);
  });

  it('closes a tab in one group, showing its neighbour, and closes a group left empty', () => {
    const groups = showIn(showIn(showIn([newGroup()], 0, 'a'), 0, 'b'), 1, 'b');
    assert.deepEqual(shape(closeIn(groups, 0, 'b')), [[['a'], 'a'], [['b'], 'b']]);
    assert.deepEqual(shape(closeIn(groups, 1, 'b')), [[['a', 'b'], 'b']]);
  });

  it('keeps one empty group when every tab closes', () => {
    const groups = dropPaths(showIn([newGroup()], 0, 'a'), () => true);
    assert.deepEqual(shape(groups), [[[], null]]);
  });

  it('follows renames', () => {
    const groups = moveAll(showIn([newGroup()], 0, 'x/a'), path => path.replace(/^x\//, 'y/'));
    assert.deepEqual(shape(groups), [[['y/a'], 'y/a']]);
  });

  it('drags a tab before another, within a group or into the next', () => {
    const groups = ['a', 'b', 'c'].reduce((current, path) => showIn(current, 0, path), [newGroup()]);
    assert.deepEqual(shape(moveTab(groups, 0, 'c', 0, 'a')), [[['c', 'a', 'b'], 'c']]);
    const split = showIn(groups, 1, 'z');
    assert.deepEqual(shape(moveTab(split, 0, 'b', 1, 'z')), [[['a', 'c'], 'c'], [['b', 'z'], 'b']]);
  });
});
