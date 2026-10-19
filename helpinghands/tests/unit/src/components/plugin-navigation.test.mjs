import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {pluginNavigation} from '../../../../src/components/PluginSidebar/navigation.js';

const apps = [
  {id: 'bibtex-check', name: 'Bibtex Check', tags: ['Research', 'Writing'], status: 'in-development'},
  {id: 'arxiv-source', name: 'arXiv', tags: ['Research'], status: 'ready'},
  {id: 'meal-suggestion', name: 'Meal Suggestion', tags: ['Life'], status: 'ready'},
  {id: 'nasdaq-drawdown', name: 'Nasdaq Drawdown', tags: [], status: 'ready'},
];
const base = '/w/lab/apps';

describe('plugin navigation', () => {
  it('shows every plugin by default, tagged or not', () => {
    const nav = pluginNavigation(apps, '', base);
    assert.equal(nav.allTags, true);
    assert.deepEqual(nav.tags.map(tag => [tag.title, tag.permalink]), [
      ['All', base], ['Life', `${base}?tag=Life`], ['Research', `${base}?tag=Research`], ['Writing', `${base}?tag=Writing`],
    ]);
    assert.deepEqual(nav.links.map(link => link.id), ['arxiv-source', 'bibtex-check', 'meal-suggestion', 'nasdaq-drawdown']);
    assert.equal(nav.links[0].permalink, `${base}?app=arxiv-source`);
  });

  it('opens a tag on its first ready plugin, like a book on its landing page', () => {
    assert.equal(pluginNavigation(apps, '', base).app.id, 'arxiv-source');
    assert.equal(pluginNavigation(apps, '?tag=Life', base).app.id, 'meal-suggestion');
    assert.equal(pluginNavigation(apps, '?tag=Writing', base).app.id, 'bibtex-check');
  });

  it('lists an outdated plugin as one that runs, its page saying it is outdated', () => {
    const outdated = apps.map(item => (item.id === 'arxiv-source' ? {...item, status: 'refused'} : item));
    assert.equal(pluginNavigation(outdated, '', base).links[0].badge, null);
  });

  it('lists every plugin with the chosen tag, and keeps the tag when one opens', () => {
    const nav = pluginNavigation(apps, '?tag=Research&app=arxiv-source', base);
    assert.deepEqual(nav.links.map(link => [link.id, link.badge]), [['arxiv-source', null], ['bibtex-check', 'maintenance']]);
    assert.equal(nav.app.id, 'arxiv-source');
    assert.equal(nav.links[1].permalink, `${base}?tag=Research&app=bibtex-check`);
  });

  it('reports a tag that does not exist, and an app without the chosen tag', () => {
    assert.equal(pluginNavigation(apps, '?tag=Nope', base).unknownTag, 'Nope');
    const nav = pluginNavigation(apps, '?tag=Life&app=arxiv-source', base);
    assert.equal(nav.app, null);
    assert.equal(nav.requestedApp, 'arxiv-source');
  });

  it('offers nothing before any plugin arrives', () => {
    const nav = pluginNavigation([], '', base);
    assert.deepEqual(nav.links, []);
    assert.equal(nav.app, null);
    assert.deepEqual(nav.tags.map(tag => tag.title), ['All']);
  });
});
