import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {pluginNavigation} from '../../../../src/components/PluginSidebar/navigation.js';

const apps = [
  {id: 'bibtex-check', name: 'Bibtex Check', group: 'Research', status: 'in-development'},
  {id: 'arxiv-source', name: 'arXiv', group: 'Research', status: 'ready'},
  {id: 'meal-suggestion', name: 'Meal Suggestion', group: 'Life', status: 'ready'},
];
const base = '/w/lab/apps';

describe('plugin navigation', () => {
  it('shows every plugin by default, all groups together', () => {
    const nav = pluginNavigation(apps, '', base);
    assert.equal(nav.allGroups, true);
    assert.deepEqual(nav.groups.map(group => [group.title, group.permalink]), [
      ['All groups', base], ['Life', `${base}?group=Life`], ['Research', `${base}?group=Research`],
    ]);
    assert.deepEqual(nav.links.map(link => link.id), ['arxiv-source', 'bibtex-check', 'meal-suggestion']);
    assert.equal(nav.links[0].permalink, `${base}?app=arxiv-source`);
  });

  it('opens a group on its first ready plugin, like a book on its landing page', () => {
    assert.equal(pluginNavigation(apps, '', base).app.id, 'arxiv-source');
    assert.equal(pluginNavigation(apps, '?group=Life', base).app.id, 'meal-suggestion');
    const notReady = [{id: 'chess-move', name: 'Chess Move', group: 'Games', status: 'in-development'}];
    assert.equal(pluginNavigation(notReady, '?group=Games', base).app.id, 'chess-move');
  });

  it('lists only the chosen group\'s plugins, and keeps the group when one opens', () => {
    const nav = pluginNavigation(apps, '?group=Research&app=arxiv-source', base);
    assert.deepEqual(nav.links.map(link => [link.id, link.maintenance]), [['arxiv-source', false], ['bibtex-check', true]]);
    assert.equal(nav.app.id, 'arxiv-source');
    assert.equal(nav.links[1].permalink, `${base}?group=Research&app=bibtex-check`);
  });

  it('reports a group that does not exist, and an app outside the chosen group', () => {
    assert.equal(pluginNavigation(apps, '?group=Nope', base).unknownGroup, 'Nope');
    const nav = pluginNavigation(apps, '?group=Life&app=arxiv-source', base);
    assert.equal(nav.app, null);
    assert.equal(nav.requestedApp, 'arxiv-source');
  });

  it('offers nothing before any plugin arrives', () => {
    const nav = pluginNavigation([], '', base);
    assert.deepEqual(nav.links, []);
    assert.equal(nav.app, null);
    assert.deepEqual(nav.groups.map(group => group.title), ['All groups']);
  });
});
