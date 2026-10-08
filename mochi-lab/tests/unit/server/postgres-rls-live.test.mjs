import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let db;

async function asRuntime(userId, workspaceId, operation) {
  await db.exec('set role mochi_runtime');
  try {
    await db.query("select set_config('app.user_id', $1, false)", [userId]);
    await db.query("select set_config('app.workspace_id', $1, false)", [workspaceId]);
    return await operation();
  } finally {
    await db.exec('reset role');
  }
}

describe('live PostgreSQL row-level isolation', () => {
  before(async () => {
    db = new PGlite();
    const migrationsDir = path.join(root, 'src/server/postgres/migrations');
    const migrations = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
    for (const name of migrations) await db.exec(await readFile(path.join(migrationsDir, name), 'utf8'));
    await db.exec(`
      create role mochi_runtime;
      grant usage on schema public to mochi_runtime;
      grant select, insert, update, delete on all tables in schema public to mochi_runtime;
      grant usage, select on all sequences in schema public to mochi_runtime;
      grant execute on all functions in schema public to mochi_runtime;

      insert into app_user(id, email, display_name, email_verified, created_at, updated_at) values
        ('rls-alice', 'alice@rls.invalid', 'Alice', true, now(), now()),
        ('rls-bob', 'bob@rls.invalid', 'Bob', true, now(), now()),
        ('rls-viewer', 'viewer@rls.invalid', 'Viewer', true, now(), now());
      insert into workspace(id, name, slug, status, created_by) values
        ('rls-a', 'A', 'rls-a', 'active', 'rls-alice'),
        ('rls-b', 'B', 'rls-b', 'active', 'rls-bob');
      insert into workspace_member(id, workspace_id, user_id, role) values
        ('rls-ma', 'rls-a', 'rls-alice', 'owner'),
        ('rls-mb', 'rls-b', 'rls-bob', 'owner'),
        ('rls-mv', 'rls-a', 'rls-viewer', 'viewer');
      insert into document(id, workspace_id, path, title, markdown, created_by) values
        ('rls-da', 'rls-a', 'same.md', 'A', '# A', 'rls-alice'),
        ('rls-db', 'rls-b', 'same.md', 'B', '# B', 'rls-bob');
      insert into asset(id, workspace_id, object_key, content_type, byte_size, sha256, created_by) values
        ('rls-asset', 'rls-a', 'rls-a/assets/object', 'application/octet-stream', 1,
         'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'rls-alice');
      insert into object_blob(object_key, workspace_id, body, content_type, byte_size, sha256) values
        ('rls-a/assets/object', 'rls-a', decode('78', 'hex'), 'application/octet-stream', 1,
         'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    `);
  });

  after(async () => db?.close());

  it('lets a member read only the workspace selected by RequestContext', async () => {
    const own = await asRuntime('rls-alice', 'rls-a', () => db.query('select markdown from document'));
    assert.deepEqual(own.rows, [{markdown: '# A'}]);

    const forged = await asRuntime('rls-alice', 'rls-b', () => db.query('select markdown from document'));
    assert.deepEqual(forged.rows, []);

    const explicitCrossRead = await asRuntime('rls-alice', 'rls-a', () =>
      db.query('select markdown from document where workspace_id = $1', ['rls-b']));
    assert.deepEqual(explicitCrossRead.rows, []);

    const ownBlob = await asRuntime('rls-alice', 'rls-a', () => db.query('select object_key from object_blob'));
    assert.deepEqual(ownBlob.rows, [{object_key: 'rls-a/assets/object'}]);
    const crossWorkspaceBlob = await asRuntime('rls-bob', 'rls-b', () => db.query('select object_key from object_blob'));
    assert.deepEqual(crossWorkspaceBlob.rows, []);
  });

  it('rejects forged writes and viewer content writes at the database layer', async () => {
    await assert.rejects(
      () => asRuntime('rls-alice', 'rls-b', () => db.query(
        `insert into document(id, workspace_id, path, title, markdown, created_by)
         values ('rls-forged', 'rls-b', 'forged.md', 'forged', '# forged', 'rls-alice')`,
      )),
      error => error?.code === '42501',
    );
    await assert.rejects(
      () => asRuntime('rls-viewer', 'rls-a', () => db.query(
        `insert into document(id, workspace_id, path, title, markdown, created_by)
         values ('rls-viewer-doc', 'rls-a', 'viewer.md', 'viewer', '# viewer', 'rls-viewer')`,
      )),
      error => error?.code === '42501',
    );
  });

  it('preserves content when a member is removed', async () => {
    await asRuntime('rls-alice', 'rls-a', () =>
      db.query("delete from workspace_member where user_id = 'rls-viewer'"));
    const remaining = await asRuntime('rls-alice', 'rls-a', () =>
      db.query("select count(*)::int as n from document where workspace_id = 'rls-a'"));
    assert.equal(remaining.rows[0].n, 1);
  });

  it('queues object deletion and cascades all workspace rows', async () => {
    const result = await asRuntime('rls-alice', 'rls-a', () =>
      db.query("select delete_workspace_and_queue_assets('rls-a')::int as queued"));
    assert.equal(result.rows[0].queued, 1);

    await db.exec('reset role');
    const residual = await db.query(`
      select (select count(*) from workspace where id = 'rls-a')
           + (select count(*) from workspace_member where workspace_id = 'rls-a')
           + (select count(*) from workspace_settings where workspace_id = 'rls-a')
           + (select count(*) from document where workspace_id = 'rls-a')
           + (select count(*) from asset where workspace_id = 'rls-a')
           + (select count(*) from object_blob where workspace_id = 'rls-a') as n
    `);
    assert.equal(Number(residual.rows[0].n), 0);
    assert.deepEqual((await db.query(
      "select workspace_id, object_key from object_deletion where workspace_id = 'rls-a'",
    )).rows, [{workspace_id: 'rls-a', object_key: 'rls-a/assets/object'}]);
  });

  it('does not expose security-definer entry points to PUBLIC', async () => {
    const result = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = any($1::text[])
         and has_function_privilege('public', p.oid, 'execute')
    `, [[
      'is_workspace_member', 'request_workspace_role', 'list_scheduled_workspaces',
      'list_user_workspaces', 'delete_workspace_and_queue_assets',
    ]]);
    assert.deepEqual(result.rows, []);
  });
});
