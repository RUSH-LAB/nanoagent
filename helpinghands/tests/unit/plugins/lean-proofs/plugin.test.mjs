import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const leanProofs = require('../../../../plugins/lean-proofs');

describe('lean-proofs build plugin', () => {
  it('discovers declarations recursively and publishes its workbench command', async () => {
    const plugin = leanProofs({}, {dir: 'proofs'});
    const content = await plugin.loadContent();
    assert.ok(content.proofs.add_comm_demo);
    assert.ok(content.proofs.one_plus_one_demo);
    assert.match(content.proofs.one_plus_one_demo.source, /^import Mathlib/);
    assert.ok(content.files.some(file => file === path.join('Proofs', 'AddComm.lean')));

    const routes = [];
    let globalData;
    await plugin.contentLoaded({content, actions: {
      addRoute: route => routes.push(route),
      setGlobalData: data => { globalData = data; },
    }});
    assert.equal(routes[0].path, '/lean-proofs');
    assert.equal(globalData.command.href, '/lean-proofs');
  });

  it('registers syntax highlighting from inside the plugin', () => {
    const plugin = leanProofs({}, {dir: 'proofs'});
    assert.match(plugin.getClientModules()[0], /plugins\/lean-proofs\/client\/prism-lean4\.js$/);
  });
});
