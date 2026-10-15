import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import {assertDisposableDatabase, parseEnv, serializeEnv, writeLocalEnvironment} from '../../../scripts/db/postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

describe('PostgreSQL tooling', () => {
  it('exposes setup, pull, push and acceptance commands, and none that migrates or resets production', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const script of ['db:setup', 'db:pull', 'db:push', 'test:postgres']) assert.ok(pkg.scripts[script], `${script} is present`);
    for (const script of ['db:sync', 'db:postgres:migrate', 'db:postgres:setup', 'start:postgres:api']) {
      assert.equal(pkg.scripts[script], undefined, `${script} is gone`);
    }

    const acceptance = read('tests/integration/postgres/runtime-acceptance.mjs');
    assert.match(acceptance, /ROOT_GITHUB_LOGIN/);
    assert.match(acceptance, /\/api\/workspaces/);
    assert.match(acceptance, /assertRuntimeRoleIsNotOwner/);
  });

  it('writes .env values a shell can source and parseEnv reads back', () => {
    const values = {DATABASE_URL: 'postgresql://u:p@host/db?sslmode=require&channel_binding=require'};
    const text = serializeEnv(values);
    assert.equal(text, "DATABASE_URL='postgresql://u:p@host/db?sslmode=require&channel_binding=require'\n");
    assert.deepEqual(parseEnv(text), values);
    assert.throws(() => serializeEnv({KEY: "it's"}), /single quote/);
  });

  it('removes every database connection from .env and keeps the rest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-env-'));
    const envFile = path.join(directory, '.env');
    fs.writeFileSync(envFile, [
      'DATABASE_MIGRATION_URL=postgresql://owner:secret@ep-dev.neon.tech/neondb',
      'DATABASE_URL=postgresql://mochi_runtime:old@ep-dev-pooler.neon.tech/neondb',
      'PG_SSL=require',
      'PG_SSL_REJECT_UNAUTHORIZED=true',
      'GITHUB_CLIENT_ID=local-app',
      '',
    ].join('\n'));
    try {
      const written = writeLocalEnvironment({envFile, values: {OPENROUTER_MANAGEMENT_KEY: 'mgmt'}});
      assert.deepEqual(written, {GITHUB_CLIENT_ID: 'local-app', OPENROUTER_MANAGEMENT_KEY: 'mgmt'});
      assert.deepEqual(parseEnv(fs.readFileSync(envFile, 'utf8')), written);
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('runs the acceptance tests only on a loopback database', () => {
    assertDisposableDatabase({
      DATABASE_URL: 'postgres://mochi_runtime:x@127.0.0.1:5432/mochi',
      DATABASE_MIGRATION_URL: 'postgres://mochi_owner:x@localhost:5432/mochi',
    });
    assert.throws(() => assertDisposableDatabase({
      DATABASE_URL: 'postgresql://mochi_runtime:x@ep-prod-pooler.neon.tech/neondb',
    }), /loopback database, and DATABASE_URL is on ep-prod-pooler\.neon\.tech/);
  });

  it('runs the acceptance command against an official PostgreSQL CI service', () => {
    // CI lives at the repository root, one level above this package.
    const workflow = yaml.load(read('../.github/workflows/helpinghands-postgres.yml'));
    assert.equal(workflow.jobs.postgres.services.postgres.image, 'postgres:17-alpine');
    assert.equal(workflow.jobs.postgres.env.PG_SSL, 'disable');
    assert.ok(workflow.jobs.postgres.steps.some(step => step.run === 'npm run test:postgres'));
  });
});
