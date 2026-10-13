import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {
  createPool, migrate, withRequestContext, queryInContext, checksum, quoteIdentifier,
  grantRuntimeAccess, assertRuntimeRoleIsNotOwner,
} = require('../../../src/server/postgres/client.js');

function fakePool(handler = async () => ({rows: []})) {
  const calls = [];
  let released = 0;
  const client = {
    async query(sql, params) {
      calls.push({sql, params});
      return handler(sql, params, calls);
    },
    release() { released++; },
  };
  return {pool: {connect: async () => client}, calls, get released() { return released; }};
}

describe('PostgreSQL runtime boundary', () => {
  it('requires a connection URL', () => {
    assert.throws(() => createPool({}), /DATABASE_URL/);
  });

  it('enables verified TLS explicitly for hosted development databases', async () => {
    const pool = createPool({
      DATABASE_URL: 'postgresql://runtime:secret@example.invalid/mochi',
      PG_SSL: 'require',
    });
    assert.deepEqual(pool.options.ssl, {rejectUnauthorized: true});
    await pool.end();

    const compatibility = createPool({
      DATABASE_URL: 'postgresql://runtime:secret@example.invalid/mochi',
      PG_SSL: 'require',
      PG_SSL_REJECT_UNAUTHORIZED: 'false',
    });
    assert.deepEqual(compatibility.options.ssl, {rejectUnauthorized: false});
    await compatibility.end();
  });

  it('handles idle connection failures without crashing the process', async () => {
    const pool = createPool({
      DATABASE_URL: 'postgresql://runtime:secret@example.invalid/mochi',
    });
    assert.equal(pool.constructor.name, 'BoundPool');
    assert.equal(pool.listenerCount('error'), 1);
    await pool.end();
  });

  it('sets request-local identity and workspace inside one transaction', async () => {
    const fake = fakePool();
    const value = await withRequestContext(fake.pool, {userId: 'u1', workspaceId: 'w1'}, async client => {
      await client.query('select 1');
      return 42;
    });
    assert.equal(value, 42);
    // The transaction and the identity go in one round trip, as quoted literals.
    assert.deepEqual(fake.calls.map(call => call.sql.replace(/\s+/g, ' ')), [
      "begin; select set_config('app.user_id', 'u1', true), set_config('app.workspace_id', 'w1', true)",
      'select 1',
      'commit',
    ]);
    assert.equal(fake.calls[0].params, undefined);
    assert.equal(fake.released, 1);
  });

  it('rolls back and releases a failed request transaction', async () => {
    const fake = fakePool();
    await assert.rejects(
      () => withRequestContext(fake.pool, {userId: 'u1', workspaceId: 'w1'}, async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(fake.calls.at(-1).sql, 'rollback');
    assert.equal(fake.released, 1);
  });

  it('reads as a user in one round trip, with no transaction to commit', async () => {
    const fake = fakePool(async () => [{rows: []}, {rows: [{id: 1}]}]);
    assert.deepEqual(await queryInContext(fake.pool, {userId: 'u1', workspaceId: 'w1'}, 'select 1 as id'), [{id: 1}]);
    assert.deepEqual(fake.calls.map(call => call.sql.replace(/\s+/g, ' ')), [
      "select set_config('app.user_id', 'u1', true), set_config('app.workspace_id', 'w1', true); select 1 as id",
    ]);
    assert.equal(fake.calls[0].params, undefined);
    assert.equal(fake.released, 1);
    await assert.rejects(() => queryInContext(fake.pool, {workspaceId: 'w1'}, 'select 1'), /verified user context/);
  });

  it('applies pending migrations once and records their checksum', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-pg-migrations-'));
    try {
      const sql = 'create table example(id bigint primary key);';
      fs.writeFileSync(path.join(directory, '0001.sql'), sql);
      const fake = fakePool(async statement => statement.startsWith('select name, checksum')
        ? {rows: []}
        : {rows: []});
      assert.deepEqual(await migrate(fake.pool, {directory}), ['0001.sql']);
      const record = fake.calls.find(call => call.sql.startsWith('insert into schema_migration'));
      assert.deepEqual(record.params, ['0001.sql', checksum(sql)]);
      assert.equal(fake.calls.some(call => call.sql === sql), true);
      assert.equal(fake.released, 1);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('rejects an edited migration that was already recorded', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-pg-migrations-'));
    try {
      fs.writeFileSync(path.join(directory, '0001.sql'), 'select 1;');
      const fake = fakePool(async statement => statement.startsWith('select name, checksum')
        ? {rows: [{name: '0001.sql', checksum: 'wrong'}]}
        : {rows: []});
      await assert.rejects(() => migrate(fake.pool, {directory}), /Applied migration changed/);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('quotes only safe PostgreSQL role identifiers', () => {
    assert.equal(quoteIdentifier('mochi_runtime'), '"mochi_runtime"');
    assert.throws(() => quoteIdentifier('runtime; drop table workspace'), /Invalid PostgreSQL role/);
  });

  it('grants the runtime role data access without schema ownership', async () => {
    const statements = [];
    const migrationPool = {query: async sql => { statements.push(sql); return {rows: []}; }};
    const runtimePool = {query: async () => ({rows: [{role: 'mochi_runtime'}]})};
    assert.equal(await grantRuntimeAccess(migrationPool, runtimePool), 'mochi_runtime');
    assert.deepEqual(statements, [
      'grant usage on schema public to "mochi_runtime"',
      'grant select, insert, update, delete on all tables in schema public to "mochi_runtime"',
      'grant usage, select on all sequences in schema public to "mochi_runtime"',
      'grant execute on all functions in schema public to "mochi_runtime"',
    ]);
  });

  it('rejects a runtime connection that owns tenant tables', async () => {
    const sameRole = {query: async () => ({rows: [{runtime_role: 'owner', owner_role: 'owner', runtime_superuser: false, runtime_bypass_rls: false}]})};
    await assert.rejects(() => assertRuntimeRoleIsNotOwner(sameRole), /non-owner/);
    const separate = {query: async () => ({rows: [{runtime_role: 'runtime', owner_role: 'owner', runtime_superuser: false, runtime_bypass_rls: false}]})};
    assert.deepEqual(await assertRuntimeRoleIsNotOwner(separate), {
      runtime_role: 'runtime', owner_role: 'owner', runtime_superuser: false, runtime_bypass_rls: false,
    });
  });

  it('rejects superuser and BYPASSRLS runtime roles', async () => {
    const superuser = {query: async () => ({rows: [{
      runtime_role: 'runtime', owner_role: 'owner', runtime_superuser: true, runtime_bypass_rls: false,
    }]})};
    const bypass = {query: async () => ({rows: [{
      runtime_role: 'runtime', owner_role: 'owner', runtime_superuser: false, runtime_bypass_rls: true,
    }]})};
    await assert.rejects(() => assertRuntimeRoleIsNotOwner(superuser), /without BYPASSRLS/);
    await assert.rejects(() => assertRuntimeRoleIsNotOwner(bypass), /without BYPASSRLS/);
  });
});
