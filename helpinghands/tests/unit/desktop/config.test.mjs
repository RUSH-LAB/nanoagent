import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {readConfig} from '../../../desktop/scripts/config.mjs';
import {devOverlay} from '../../../scripts/dev/desktop-dev.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../desktop');
const yaml = YAML.parse(fs.readFileSync(path.join(desktop, 'config.yaml'), 'utf8'));
const tauri = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const IDENTITY = ['product_name', 'label', 'scheme', 'site_url', 'files_folder', 'projects_folder'];

describe("the desktop app's config.yaml builds", () => {
  it('builds RUSH Lab from tauri.conf.json, which says who config.yaml says it is', () => {
    assert.equal(tauri.productName, yaml.product_name);
    assert.equal(tauri.identifier, yaml.label);
    assert.deepEqual(tauri.plugins['deep-link'].desktop.schemes, [yaml.scheme]);
  });

  it("overrides exactly the app's identity for RUSH Lab Dev", () => {
    assert.deepEqual(Object.keys(yaml.dev).sort(), [...IDENTITY].sort());
    for (const key of IDENTITY) assert.notEqual(yaml.dev[key], yaml[key], key);
  });

  it('bundles a flat config: the release values, or with dev its dev block over them', () => {
    const release = readConfig();
    const dev = readConfig({dev: true});
    assert.equal('dev' in release, false);
    assert.equal('dev' in dev, false);
    const {dev: overrides, ...top} = yaml;
    assert.deepEqual(release, top);
    assert.deepEqual(dev, {...top, ...overrides});
  });

  it('refuses a config.yaml with no dev block, or one overriding what RUSH Lab has not', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-config-'));
    const file = path.join(folder, 'config.yaml');
    try {
      fs.writeFileSync(file, 'product_name: RUSH Lab\n');
      assert.throws(() => readConfig({}, file), new RegExp(`^Error: ${file} has no dev block for RUSH Lab Dev$`));
      fs.writeFileSync(file, 'product_name: RUSH Lab\ndev:\n  other: x\n');
      assert.throws(() => readConfig({}, file), /dev\.other overrides nothing RUSH Lab has$/);
    } finally {
      fs.rmSync(folder, {recursive: true});
    }
  });

  it("builds RUSH Lab Dev with its own name, identifier, scheme and staging", () => {
    assert.deepEqual(devOverlay(readConfig({dev: true})), {
      productName: 'RUSH Lab Dev',
      identifier: 'lab.mochi.lab.dev',
      build: {beforeBuildCommand: 'node scripts/stage.mjs --dev'},
      plugins: {'deep-link': {desktop: {schemes: ['rushlab-dev']}}},
    });
  });

  it('refuses to stage a release of RUSH Lab Dev', () => {
    const staged = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'stage.mjs'), '--dev', '--release'], {encoding: 'utf8'});
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /--release and --dev cannot be given together/);
  });
});
