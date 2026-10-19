import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const runtimeContent = require('../../../src/runtime-content');
const {SECTIONS, sectionAt} = require('../../../src/components/Shell/sectionList');

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
    // The shell's sections are one route, Home at the workspace's own path.
    assert.ok(paths.includes('/w/:workspaceSlug/:section(apps|marketplace|workspace|settings)?'));
    assert.ok(!paths.includes('/w/:workspaceSlug'));
    for (const {path} of SECTIONS.filter(section => section.path)) {
      assert.ok(!paths.includes(`/w/:workspaceSlug/${path}`));
    }
    assert.ok(!paths.includes('/w/:workspaceSlug/settings'));
    assert.deepEqual(data, {routeBasePath: 'w'});
  });
});

describe('the shell\'s sections', () => {
  it('names each by its own id and path', () => {
    assert.equal(new Set(SECTIONS.map(section => section.id)).size, SECTIONS.length);
    assert.equal(new Set(SECTIONS.map(section => section.path)).size, SECTIONS.length);
  });

  it('finds the section open at a workspace path, and none at another page', () => {
    assert.equal(sectionAt('/w/acme')?.id, 'home');
    assert.equal(sectionAt('/w/acme/')?.id, 'home');
    assert.equal(sectionAt('/w/acme/apps')?.id, 'plugins');
    assert.equal(sectionAt('/w/acme/workspace/')?.id, 'workspace');
    assert.equal(sectionAt('/w/acme/tasks'), null);
    assert.equal(sectionAt('/w/acme/documents/intro'), null);
    assert.equal(sectionAt('/w/acme/apps/more'), null);
  });
});
