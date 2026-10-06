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
  portIsAvailable,
  usesLocalNanoAgent,
  waitForNanoAgent,
} from '../../../scripts/dev/start-local.mjs';

describe('local process supervisor configuration', () => {
  it('loads PostgreSQL credentials while keeping explicit shell overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-start-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgres://runtime\nDATABASE_MIGRATION_URL=postgres://owner\nEDITOR_PORT=9999\n');
    const env = environmentFor({base: {EDITOR_PORT: '4101'}, envFile});
    assert.equal(env.DATABASE_URL, 'postgres://runtime');
    assert.equal(env.DATABASE_MIGRATION_URL, 'postgres://owner');
    assert.equal(env.EDITOR_PORT, '4101');
    assert.equal(env.ENABLE_AUTH, 'true');
    assert.equal(env.DEV_AUTOLOGIN, 'false');
    assert.equal(env.POSTGRES_ROOT_LOGIN, 'true');
  });

  it('reports how to prepare a missing PostgreSQL environment file', () => {
    assert.throws(
      () => environmentFor({base: {}, envFile: '/path/that/does/not/exist'}),
      /db:postgres:setup/,
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

  it('publishes each plugin package to the local NanoAgent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-plugins-'));
    for (const name of ['b-app', 'a-app', 'not-a-plugin']) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'a-app', 'nanoagent.yaml'), '');
    fs.writeFileSync(path.join(dir, 'b-app', 'nanoagent.yaml'), '');
    const env = {NANOAGENT_PLUGINS_DIR: dir};
    assert.deepEqual(nanoagentPluginsFrom(env), [path.join(dir, 'a-app'), path.join(dir, 'b-app')]);
    assert.ok(nanoagentWebArgs(env).includes(`plugins=${JSON.stringify(nanoagentPluginsFrom(env))}`));
  });

  it('rejects a plugins directory that does not exist', () => {
    assert.throws(() => nanoagentPluginsFrom({NANOAGENT_PLUGINS_DIR: '/path/that/does/not/exist'}), /not found/);
    assert.throws(() => nanoagentPluginsFrom({NANOAGENT_PROJECT_DIR: '/path/that/does/not/exist'}), /not found/);
  });

  it('defaults to the NanoAgent checkout\'s built-in plugins', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-nanoagent-'));
    fs.mkdirSync(path.join(project, 'plugins', 'arxiv-source'), {recursive: true});
    fs.writeFileSync(path.join(project, 'plugins', 'arxiv-source', 'nanoagent.yaml'), '');
    assert.deepEqual(nanoagentPluginsFrom({NANOAGENT_PROJECT_DIR: project}), [path.join(project, 'plugins', 'arxiv-source')]);
  });
});
