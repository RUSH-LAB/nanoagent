import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapRuntimeRole, parseRuntimeTarget,
} from '../../../scripts/db/bootstrap-runtime-role.mjs';

function ownerPool({exists = false, owner = 'neondb_owner', database = 'neondb'} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({sql, params});
      if (sql.startsWith('select current_user')) return {rows: [{role: owner, database}], rowCount: 1};
      if (sql.startsWith('select 1 from pg_roles')) return {rows: exists ? [{'?column?': 1}] : [], rowCount: exists ? 1 : 0};
      if (sql.startsWith('select format')) return {rows: [{sql: `DDL:${params.join('|')}`}], rowCount: 1};
      if (sql.startsWith('select rolname')) {
        return {rows: [{
          rolname: 'mochi_runtime', rolcanlogin: true, rolsuper: false,
          rolcreatedb: false, rolcreaterole: false, rolinherit: false,
          rolreplication: false, rolbypassrls: false,
        }], rowCount: 1};
      }
      return {rows: [], rowCount: 0};
    },
  };
}

describe('hosted PostgreSQL runtime-role bootstrap', () => {
  it('reads the intended role without exposing credentials', () => {
    assert.deepEqual(parseRuntimeTarget(
      'postgresql://mochi_runtime:p%40ss@pool.example/neondb?sslmode=require',
    ), {role: 'mochi_runtime', password: 'p@ss', database: 'neondb'});
    assert.throws(() => parseRuntimeTarget('https://example.com/db'), /postgres/);
    assert.throws(() => parseRuntimeTarget('postgresql://owner@example.com/db'), /password/);
  });

  it('creates and restricts a missing runtime role through the owner connection', async () => {
    const pool = ownerPool();
    const result = await bootstrapRuntimeRole(
      pool, 'postgresql://mochi_runtime:secret@pool.example/neondb?sslmode=require',
    );
    assert.deepEqual(result, {
      ownerRole: 'neondb_owner', runtimeRole: 'mochi_runtime', database: 'neondb', created: true,
    });
    const ddl = pool.calls.filter(call => call.sql.startsWith('DDL:'));
    assert.equal(ddl.length, 3, 'create, restrict/password, and database connect are executed');
    assert.ok(pool.calls.some(call => call.params.includes('secret')),
      'the password reaches PostgreSQL only through a query parameter passed to format(%L)');
  });

  it('repairs an existing role and rejects owner/runtime identity reuse', async () => {
    const existing = ownerPool({exists: true});
    const result = await bootstrapRuntimeRole(
      existing, 'postgresql://mochi_runtime:secret@pool.example/neondb',
    );
    assert.equal(result.created, false);
    assert.equal(existing.calls.filter(call => call.sql.startsWith('DDL:')).length, 2);

    await assert.rejects(
      () => bootstrapRuntimeRole(
        ownerPool(), 'postgresql://neondb_owner:secret@pool.example/neondb',
      ),
      /different PostgreSQL roles/,
    );
  });
});
