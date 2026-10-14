import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import {parseEnv, prepareNeonEnvironment, serializeEnv} from '../../../scripts/db/postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

describe('Neon PostgreSQL tooling', () => {
  it('exposes setup, verification, server, and acceptance commands', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const script of [
      'db:postgres:bootstrap', 'db:postgres:prepare', 'db:postgres:setup', 'db:postgres:migrate',
      'db:postgres:verify', 'start:postgres:api', 'test:postgres',
    ]) assert.ok(pkg.scripts[script], `${script} is present`);

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

  it('derives direct owner and pooled restricted Neon URLs from one connection string', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-neon-'));
    const envFile = path.join(directory, '.env');
    fs.writeFileSync(envFile, [
      'DATABASE_MIGRATION_URL=postgresql://owner:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
      'DATABASE_URL=',
      '',
    ].join('\n'));
    try {
      const prepared = prepareNeonEnvironment({
        envFile,
        pulledEnvFile: path.join(directory, '.env'),
        randomBytes: size => Buffer.alloc(size, 7),
      });
      const owner = new URL(prepared.DATABASE_MIGRATION_URL);
      const runtime = new URL(prepared.DATABASE_URL);
      assert.equal(owner.hostname, 'ep-demo.us-east-2.aws.neon.tech');
      assert.equal(owner.username, 'owner');
      assert.equal(runtime.hostname, 'ep-demo-pooler.us-east-2.aws.neon.tech');
      assert.equal(runtime.username, 'mochi_runtime');
      assert.notEqual(runtime.password, owner.password);
      assert.equal(prepared.PG_DRIVER, undefined);
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('can bootstrap its private environment from Neon env pull output', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-neon-pull-'));
    const envFile = path.join(directory, '.env');
    const pulledEnvFile = path.join(directory, '.env');
    fs.writeFileSync(pulledEnvFile, [
      'NEON_BRANCH=br-example',
      'DATABASE_URL=postgresql://owner:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
      'DATABASE_URL_UNPOOLED=postgresql://owner:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require',
      '',
    ].join('\n'));
    try {
      const prepared = prepareNeonEnvironment({
        envFile,
        pulledEnvFile,
        randomBytes: size => Buffer.alloc(size, 9),
      });
      assert.equal(new URL(prepared.DATABASE_MIGRATION_URL).hostname,
        'ep-demo.us-east-2.aws.neon.tech');
      assert.equal(new URL(prepared.DATABASE_URL).hostname,
        'ep-demo-pooler.us-east-2.aws.neon.tech');
      assert.equal(new URL(prepared.DATABASE_URL).username, 'mochi_runtime');
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('follows a newly checked-out Neon branch without reusing the old host', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-neon-switch-'));
    const envFile = path.join(directory, '.env');
    fs.writeFileSync(envFile, [
      'DATABASE_URL=postgresql://owner:new-secret@ep-new-pooler.us-east-2.aws.neon.tech/neondb',
      'DATABASE_URL_UNPOOLED=postgresql://owner:new-secret@ep-new.us-east-2.aws.neon.tech/neondb',
      '',
    ].join('\n'));
    try {
      const prepared = prepareNeonEnvironment({
        envFile,
        pulledEnvFile: envFile,
        randomBytes: size => Buffer.alloc(size, 11),
      });
      const owner = new URL(prepared.DATABASE_MIGRATION_URL);
      const runtime = new URL(prepared.DATABASE_URL);
      assert.equal(owner.hostname, 'ep-new.us-east-2.aws.neon.tech');
      assert.equal(runtime.hostname, 'ep-new-pooler.us-east-2.aws.neon.tech');
      assert.equal(runtime.username, 'mochi_runtime');
      assert.notEqual(runtime.password, owner.password);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('runs the acceptance command against an official PostgreSQL CI service', () => {
    // CI lives at the repository root, one level above this package.
    const workflow = yaml.load(read('../.github/workflows/helpinghands-postgres.yml'));
    assert.equal(workflow.jobs.postgres.services.postgres.image, 'postgres:17-alpine');
    assert.equal(workflow.jobs.postgres.env.PG_SSL, 'disable');
    assert.ok(workflow.jobs.postgres.steps.some(step => step.run === 'npm run test:postgres'));
  });
});
