import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  environmentFor,
  modeFrom,
  nanoagentProjectFrom,
  portIsAvailable,
  usesLocalNanoAgent,
} from '../../../scripts/dev/start-local.mjs';

describe('local process supervisor configuration', () => {
  it('selects exactly one supported mode', () => {
    assert.equal(modeFrom([]), 'sqlite');
    assert.equal(modeFrom(['--postgres']), 'postgres');
    assert.equal(modeFrom(['--no-auth']), 'no-auth');
    assert.throws(() => modeFrom(['--postgres', '--no-auth']), /cannot be combined/);
  });

  it('loads PostgreSQL credentials while keeping explicit shell overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-start-'));
    const envFile = path.join(dir, '.env.postgres.local');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgres://runtime\nDATABASE_MIGRATION_URL=postgres://owner\nEDITOR_PORT=9999\n');
    const env = environmentFor('postgres', {base: {EDITOR_PORT: '4101'}, envFile});
    assert.equal(env.DATABASE_URL, 'postgres://runtime');
    assert.equal(env.DATABASE_MIGRATION_URL, 'postgres://owner');
    assert.equal(env.EDITOR_PORT, '4101');
    assert.equal(env.ENABLE_AUTH, 'true');
    assert.equal(env.DEV_AUTOLOGIN, 'false');
    assert.equal(env.POSTGRES_ROOT_LOGIN, 'true');
  });

  it('reports how to prepare a missing PostgreSQL environment file', () => {
    assert.throws(
      () => environmentFor('postgres', {base: {}, envFile: '/path/that/does/not/exist'}),
      /db:postgres:setup/,
    );
  });

  it('keeps SQLite modes independent from inherited PostgreSQL variables', () => {
    const base = {DATABASE_URL: 'postgres://runtime', DATABASE_MIGRATION_URL: 'postgres://owner'};
    const authenticated = environmentFor('sqlite', {base});
    assert.equal(authenticated.DATABASE_URL, undefined);
    assert.equal(authenticated.ENABLE_AUTH, 'true');
    assert.equal(authenticated.DEV_AUTOLOGIN, 'true');
    const open = environmentFor('no-auth', {base});
    assert.equal(open.DATABASE_MIGRATION_URL, undefined);
    assert.equal(open.ENABLE_AUTH, 'false');
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
});
