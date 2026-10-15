import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  environmentFor,
  nanoagentPluginsFrom,
  nanoagentProjectFrom,
  nanoagentWebArgs,
  npmInstallProblems,
  portIsAvailable,
  usesLocalNanoAgent,
  waitForNanoAgent,
} from '../../../scripts/dev/start-local.mjs';

describe('local process supervisor configuration', () => {
  it('loads the runtime database URL while keeping explicit shell overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-start-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgres://runtime\nEDITOR_PORT=9999\n');
    const env = environmentFor({base: {EDITOR_PORT: '4101'}, envFile});
    assert.equal(env.DATABASE_URL, 'postgres://runtime');
    assert.equal(env.EDITOR_PORT, '4101');
  });

  it('refuses a schema owner URL, as only Railway migrates the database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-start-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgres://runtime\nDATABASE_MIGRATION_URL=postgres://owner\n');
    assert.throws(() => environmentFor({base: {}, envFile}), /only Railway migrates the database/);
  });

  it('reports how to prepare a missing PostgreSQL environment file', () => {
    assert.throws(
      () => environmentFor({base: {}, envFile: '/path/that/does/not/exist'}),
      /db:setup/,
    );
  });

  it('detects an occupied port before either application process starts', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, 'localhost', error => error ? reject(error) : resolve()));
    try {
      assert.equal(await portIsAvailable(server.address().port), false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('starts the local NanoAgent checkout unless an endpoint is explicitly configured', () => {
    assert.equal(usesLocalNanoAgent({}), true);
    assert.equal(usesLocalNanoAgent({NANOAGENT_URL: ''}), true);
    assert.equal(usesLocalNanoAgent({NANOAGENT_URL: 'off'}), false);
    assert.equal(usesLocalNanoAgent({NANOAGENT_URL: 'https://agent.internal'}), false);
    assert.equal(nanoagentProjectFrom({NANOAGENT_PROJECT_DIR: '/tmp/nanoagent'}), '/tmp/nanoagent');
  });

  it('accepts startup only when NanoAgent has an available default profile', async () => {
    const responses = new Map([
      ['http://127.0.0.1:8787/health', {service: 'nanoagent'}],
      ['http://127.0.0.1:8787/v1/profiles', {
        defaultProfile: 'pi-test',
        profiles: [{id: 'pi-test', model: 'test/model', available: true}],
      }],
    ]);
    const fetchImpl = async url => ({
      ok: true,
      json: async () => responses.get(url),
    });

    const ready = await waitForNanoAgent({}, null, {fetchImpl, timeoutMs: 100, intervalMs: 1});
    assert.equal(ready.profile.id, 'pi-test');
  });

  it('offers each plugin package to the local NanoAgent, which runs what it installs unsandboxed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-plugins-'));
    for (const name of ['b-app', 'a-app', 'not-a-plugin']) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'a-app', 'nanoagent.yaml'), '');
    fs.writeFileSync(path.join(dir, 'b-app', 'nanoagent.yaml'), '');
    const env = {NANOAGENT_PLUGINS_DIR: dir};
    assert.deepEqual(nanoagentPluginsFrom(env), [path.join(dir, 'a-app'), path.join(dir, 'b-app')]);
    const args = nanoagentWebArgs(env);
    assert.ok(args.includes(`packages=${JSON.stringify(nanoagentPluginsFrom(env))}`));
    assert.ok(args.includes('sandbox=none') && args.some(arg => arg.startsWith('installs=')));
  });

  it('rejects a plugins directory that does not exist or holds no plugin', () => {
    assert.throws(() => nanoagentPluginsFrom({NANOAGENT_PLUGINS_DIR: '/path/that/does/not/exist'}), /not found/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-plugins-'));
    fs.mkdirSync(path.join(empty, 'not-a-plugin'));
    assert.throws(() => nanoagentPluginsFrom({NANOAGENT_PLUGINS_DIR: empty}), /holds no plugin/);
  });

  it('publishes no package unless NANOAGENT_PLUGINS_DIR names a folder of plugins', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-nanoagent-'));
    fs.mkdirSync(path.join(project, 'plugins', 'arxiv-source'), {recursive: true});
    fs.writeFileSync(path.join(project, 'plugins', 'arxiv-source', 'nanoagent.yaml'), '');
    assert.deepEqual(nanoagentPluginsFrom({NANOAGENT_PROJECT_DIR: project}), []);
    assert.ok(nanoagentWebArgs({NANOAGENT_PROJECT_DIR: project}).includes('packages=[]'));
  });

  it('names every way node_modules differs from the lockfile', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-npm-'));
    const write = (file, value) => {
      fs.mkdirSync(path.dirname(path.join(project, file)), {recursive: true});
      fs.writeFileSync(path.join(project, file), JSON.stringify(value));
    };
    assert.deepEqual(npmInstallProblems(project), ['node_modules is not installed']);

    write('package.json', {dependencies: {a: '^1.0.0', b: '^2.0.0'}});
    write('package-lock.json', {packages: {
      '': {dependencies: {a: '^1.0.0'}},
      'node_modules/a': {version: '1.1.0'},
      'node_modules/c': {version: '3.0.0'},
      'node_modules/skipped': {version: '1.0.0', optional: true},
    }});
    write('node_modules/.package-lock.json', {packages: {
      'node_modules/a': {version: '1.0.0'},
      'node_modules/d': {version: '4.0.0'},
    }});
    assert.deepEqual(npmInstallProblems(project), [
      'package-lock.json is out of date for b',
      'node_modules/a is 1.0.0, the lockfile has 1.1.0',
      'node_modules/c is not installed',
      'node_modules/d is installed but not in the lockfile',
    ]);
  });
});
