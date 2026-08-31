import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const bibliographyPlugin = require('../../../../plugins/bibliography');

describe('bibliography build plugin', () => {
  it('does not load workspace bibliography data or copy PDFs at build time', async () => {
    const plugin = bibliographyPlugin();
    assert.equal(plugin.name, 'bibliography');
    assert.equal(plugin.getPathsToWatch, undefined);
    assert.equal(plugin.postBuild, undefined);
    assert.equal(await plugin.loadContent(), null);
  });

  it('registers only runtime routes and command metadata', async () => {
    const plugin = bibliographyPlugin();
    const routes = [];
    let globalData;
    await plugin.contentLoaded({
      content: null,
      actions: {
        setGlobalData(value) { globalData = value; },
        addRoute(route) { routes.push(route); },
      },
    });
    assert.deepEqual(routes.map(route => route.path), [
      '/bibliography',
      '/bibliography/:key',
      '/w/:workspaceSlug/bibliography',
      '/w/:workspaceSlug/bibliography/:key',
    ]);
    assert.equal(globalData.command.href, '/bibliography');
    assert.equal(globalData.references, undefined);
  });
});
