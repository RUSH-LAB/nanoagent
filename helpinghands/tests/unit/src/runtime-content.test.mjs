import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const runtimeContent = require('../../../src/runtime-content');

describe('core runtime workspace routes', () => {
  it('registers documents and workspace application pages outside the optional plugin tree', () => {
    const routes = [];
    let data;
    runtimeContent({}, {routeBasePath: 'w'}).contentLoaded({actions: {
      addRoute: route => routes.push(route),
      setGlobalData: value => { data = value; },
    }});
    const paths = routes.map(route => route.path);
    assert.equal(paths[0], '/w/:workspaceSlug/documents');
    for (const page of ['analytics', 'graph', 'tasks']) {
      assert.ok(paths.includes(`/w/:workspaceSlug/${page}`));
    }
    // The shell's sections are one route, so moving between them remounts nothing.
    assert.ok(paths.includes('/w/:workspaceSlug/:section(apps|marketplace|workspace|settings)'));
    assert.ok(!paths.includes('/w/:workspaceSlug/settings'));
    assert.deepEqual(data, {routeBasePath: 'w'});
  });
});
