import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {contractPlugin} from '../../../scripts/maintenance/verify-nanoagent.mjs';

const nanoagent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../nanoagent');

function checkout(packages, plugins = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-contract-'));
  fs.mkdirSync(path.join(project, 'deploy', 'contract'), {recursive: true});
  fs.writeFileSync(path.join(project, 'deploy', 'contract', 'nanoagent.yaml'), `packages: ${JSON.stringify(packages)}\n`);
  for (const [folder, manifest] of Object.entries(plugins)) {
    fs.mkdirSync(path.join(project, folder), {recursive: true});
    fs.writeFileSync(path.join(project, folder, 'nanoagent.yaml'), manifest);
  }
  return project;
}

describe('NanoAgent contract plugin', () => {
  it('is the only package of this checkout\'s contract configuration', () => {
    assert.deepEqual(contractPlugin(nanoagent), {folder: 'test/plugins/word-check', id: 'word-check'});
  });

  it('takes its id from the folder the configuration names', () => {
    const project = checkout(['plugins/x'], {
      'plugins/x': '_ > nanoagent.plugin.manifest.ManifestConfig:\nid: x\n',
    });
    assert.deepEqual(contractPlugin(project), {folder: 'plugins/x', id: 'x'});
  });

  it('refuses a configuration that does not offer exactly one package', () => {
    assert.throws(() => contractPlugin(checkout([])), /exactly one package, not \[\]/);
    assert.throws(() => contractPlugin(checkout(['a', 'b'])), /exactly one package/);
  });

  it('refuses a package folder with no plugin id', () => {
    assert.throws(() => contractPlugin(checkout(['plugins/x'])), /ENOENT/);
    assert.throws(() => contractPlugin(checkout(['plugins/x'], {'plugins/x': 'name: X\n'})), /names no plugin id/);
  });
});
