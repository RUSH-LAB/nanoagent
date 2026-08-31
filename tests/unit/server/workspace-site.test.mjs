import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {inferredCollections, resolveWorkspaceSite, validateWorkspaceSite} = require('../../../src/server/workspace-site.js');

describe('workspace site configuration', () => {
  const documents = [
    {path: 'books/math/chapter.md'},
    {path: 'books/math/0-intro.md'},
    {path: 'books/builder/0-intro.md'},
    {path: 'posts/research/paper.md'},
  ];

  it('infers docs and blog collections from virtual document paths', () => {
    assert.deepEqual(inferredCollections(documents), [
      {key: 'research', type: 'blog', pathPrefix: 'posts/research', title: 'Research', landingPath: 'posts/research/paper.md'},
      {key: 'math', type: 'docs', pathPrefix: 'books/math', title: 'Math', landingPath: 'books/math/0-intro.md'},
    ]);
  });

  it('uses explicit navigation and derives a home document', () => {
    const site = resolveWorkspaceSite({
      site: {title: 'Lab'},
      navigation: [{label: 'Start', path: 'books/math/0-intro.md'}],
    }, documents);
    assert.equal(site.site.title, 'Lab');
    assert.equal(site.site.homeDocument, 'books/math/0-intro.md');
    assert.deepEqual(site.navigation, [{label: 'Start', path: 'books/math/0-intro.md'}]);
  });

  it('does not expose an inferred collection omitted from explicit navigation', () => {
    const site = resolveWorkspaceSite({
      navigation: [{label: 'Programming', path: 'books/programming/0-intro.md'}],
    }, [
      {path: 'books/programming/0-intro.md'},
      {path: 'books/builder/intro.md'},
    ]);
    assert.deepEqual(site.collections.map(collection => collection.key), ['programming']);
  });

  it('rejects executable or unbounded configuration shapes', () => {
    assert.throws(() => validateWorkspaceSite({navigation: 'bad'}), /array/);
    assert.throws(() => validateWorkspaceSite({navigation: [{label: 'Bad', path: '../outside'}]}), /workspace-relative/);
    assert.throws(() => validateWorkspaceSite({collections: [{key: 'x', type: 'plugin', pathPrefix: 'x', title: 'X'}]}), /docs or blog/);
  });
});
