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

  it('does not expose the internal builder collection from saved settings', () => {
    const site = resolveWorkspaceSite({
      navigation: [
        {label: 'Builder', path: 'books/builder/0-intro.md'},
        {label: 'Math', path: 'books/math/0-intro.md'},
      ],
      collections: [
        {key: 'builder', type: 'docs', pathPrefix: 'books/builder', title: 'Builder'},
        {key: 'math', type: 'docs', pathPrefix: 'books/math', title: 'Math'},
      ],
    }, documents);
    assert.deepEqual(site.collections.map(collection => collection.key), ['math']);
    assert.deepEqual(site.navigation, [{label: 'Math', path: 'books/math/0-intro.md'}]);
  });

  it('rejects executable or unbounded configuration shapes', () => {
    assert.throws(() => validateWorkspaceSite({navigation: 'bad'}), /array/);
    assert.throws(() => validateWorkspaceSite({navigation: [{label: 'Bad', path: '../outside'}]}), /workspace-relative/);
    assert.throws(() => validateWorkspaceSite({collections: [{key: 'x', type: 'plugin', pathPrefix: 'x', title: 'X'}]}), /docs or blog/);
    assert.throws(() => validateWorkspaceSite({authors: {ada: {name: 'Ada', url: 'javascript:alert(1)'}}}), /HTTP URL/);
  });

  it('keeps inert per-workspace blog author presentation data', () => {
    const site = validateWorkspaceSite({authors: {
      ada: {
        name: 'Ada Lovelace',
        title: 'Mathematician',
        url: 'https://example.com',
        image_url: 'https://example.com/ada.png',
        socials: {github: 'https://github.com/ada'},
      },
    }});
    assert.deepEqual(site.authors.ada, {
      name: 'Ada Lovelace', title: 'Mathematician', url: 'https://example.com', imageUrl: 'https://example.com/ada.png',
      socials: {github: 'https://github.com/ada'},
    });
    assert.throws(() => validateWorkspaceSite({authors: {
      ada: {name: 'Ada', socials: {github: 'javascript:alert(1)'}},
    }}), /HTTP URL/);
  });

  it('keeps the native blog sidebar title and reading-time setting', () => {
    const site = validateWorkspaceSite({collections: [{
      key: 'research',
      type: 'blog',
      pathPrefix: 'posts/research',
      title: 'Research Papers',
      sidebarTitle: 'Recent Papers',
      showReadingTime: true,
    }]});
    assert.equal(site.collections[0].sidebarTitle, 'Recent Papers');
    assert.equal(site.collections[0].showReadingTime, true);
  });
});
