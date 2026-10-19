import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {appFor} from '../../../../src/components/Workbench/apps.js';

describe('which app opens a file', () => {
  const plugins = [{title: 'Bibliography', opens: [{path: 'papers/', page: 'bibliography'}, {extension: '.bib', page: 'bibliography'}]}];

  it('follows what a plugin declares, by folder or extension', () => {
    assert.deepEqual(appFor('papers/knuth.json', plugins), {title: 'Bibliography', page: 'bibliography'});
    assert.deepEqual(appFor('drafts/Refs.BIB', plugins), {title: 'Bibliography', page: 'bibliography'});
  });

  it('leaves ordinary files to the editor', () => {
    assert.equal(appFor('books/intro.md', plugins), null);
  });
});
