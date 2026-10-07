import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {appFor} from '../../../../src/components/Workbench/apps.js';

describe('which app opens a file', () => {
  const plugins = [{title: 'Bibliography', opens: [{path: 'apps/bibliography/', page: 'bibliography'}, {extension: '.bib', page: 'bibliography'}]}];

  it('follows what a plugin declares, by folder or extension', () => {
    assert.deepEqual(appFor('apps/bibliography/papers/knuth.json', plugins), {title: 'Bibliography', page: 'bibliography'});
    assert.deepEqual(appFor('papers/Refs.BIB', plugins), {title: 'Bibliography', page: 'bibliography'});
  });

  it('knows the built-in apps by the folders their records live in', () => {
    assert.equal(appFor('home/ada/tasks/t1.json').page, 'tasks');
    assert.equal(appFor('apps/glossary/CRDT.json').page, 'glossary');
  });

  it('leaves ordinary files to the editor', () => {
    assert.equal(appFor('books/intro.md', plugins), null);
  });
});
