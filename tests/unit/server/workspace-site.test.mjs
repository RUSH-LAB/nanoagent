import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {resolveWorkspaceSite, validateWorkspaceSite} = require('../../../src/server/workspace-site.js');

describe('workspace site configuration', () => {
  it('does not invent organization navigation or collections from document paths', () => {
    const site = resolveWorkspaceSite({}, [
      {path: 'private-convention/papers/intro.md'},
      {path: 'books/math/0-intro.md'},
    ]);
    assert.deepEqual(site.navigation, []);
    assert.deepEqual(site.collections, []);
    assert.equal(site.site.homeDocument, null);
  });

  it('uses explicit navigation and derives a home document', () => {
    const site = resolveWorkspaceSite({
      site: {title: 'Lab'},
      navigation: [{label: 'Start', path: 'books/math/0-intro.md'}],
    });
    assert.equal(site.site.title, 'Lab');
    assert.equal(site.site.homeDocument, 'books/math/0-intro.md');
    assert.deepEqual(site.navigation, [{label: 'Start', path: 'books/math/0-intro.md'}]);
  });

  it('does not infer collections omitted from explicit configuration', () => {
    const site = resolveWorkspaceSite({
      navigation: [{label: 'Programming', path: 'books/programming/0-intro.md'}],
    });
    assert.deepEqual(site.collections, []);
    assert.equal(site.site.homeDocument, 'books/programming/0-intro.md');
  });

  it('rejects executable or unbounded configuration shapes', () => {
    assert.throws(() => validateWorkspaceSite({navigation: 'bad'}), /array/);
    assert.throws(() => validateWorkspaceSite({navigation: [{label: 'Bad', path: '../outside'}]}), /workspace-relative/);
    assert.throws(() => validateWorkspaceSite({collections: [{key: 'x', type: 'plugin', pathPrefix: 'x', title: 'X'}]}), /docs or blog/);
    assert.throws(() => validateWorkspaceSite({authors: {ada: {name: 'Ada', url: 'javascript:alert(1)'}}}), /HTTP URL/);
    assert.throws(() => validateWorkspaceSite({plugins: []}), /object/);
    assert.throws(() => validateWorkspaceSite({plugins: {'../bad': {enabled: true}}}), /Invalid plugin name/);
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

  it('defaults reading time by collection type rather than an organization-specific key', () => {
    const site = validateWorkspaceSite({collections: [
      {key: 'updates', type: 'blog', pathPrefix: 'news', title: 'Updates'},
      {key: 'research', type: 'docs', pathPrefix: 'manual', title: 'Manual'},
    ]});
    assert.equal(site.collections[0].showReadingTime, true);
    assert.equal(site.collections[1].showReadingTime, false);
  });

  it('keeps only bounded workspace plugin enablement data', () => {
    const site = validateWorkspaceSite({plugins: {
      bibliography: {enabled: false, executable: 'never'},
      'wiki-links': {enabled: true},
    }});
    assert.deepEqual(site.plugins, {
      bibliography: {enabled: false},
      'wiki-links': {enabled: true},
    });
  });

  it('upgrades legacy rendering switches into workspace plugin settings', () => {
    const site = validateWorkspaceSite({rendering: {
      math: false,
      citations: false,
      wikiLinks: true,
      leanProofs: false,
      interactiveMath: true,
    }});
    assert.equal(site.schemaVersion, 2);
    assert.deepEqual(site.rendering, {math: false});
    assert.deepEqual(site.plugins, {
      bibliography: {enabled: false},
      'wiki-links': {enabled: true},
      'lean-proofs': {enabled: false},
      'math-registry': {enabled: true},
    });
  });
});
