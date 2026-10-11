#!/usr/bin/env node
/**
 * Destructive-but-self-cleaning PostgreSQL acceptance probe. It creates three
 * temporary users and two temporary workspaces, exercises the runtime role,
 * then removes every fixture through the migration role in a finally block.
 * Run against staging before production cutover.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {
  createPool, migrate, withRequestContext, grantRuntimeAccess, assertRuntimeRoleIsNotOwner,
} = require('../../../src/server/postgres/client.js');
const {createObjectDeletionQueue, drainObjectDeletions} = require('../../../src/server/object-deletions.js');

if (!process.env.DATABASE_URL || !process.env.DATABASE_MIGRATION_URL) {
  throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL are required');
}

const migrationPool = createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 2});
const runtimePool = createPool(process.env, {max: 4});
const token = crypto.randomUUID().replace(/-/g, '');
const users = {
  alice: `rls-alice-${token}`,
  bob: `rls-bob-${token}`,
  viewer: `rls-viewer-${token}`,
};
const workspaceIds = [];
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};

async function createWorkspace(userId, name, slug) {
  const id = crypto.randomUUID();
  await migrationPool.query(
    `insert into workspace(id, name, slug, status, created_by) values ($1, $2, $3, 'active', $4)`,
    [id, name, slug, userId],
  );
  await migrationPool.query(
    `insert into workspace_member(id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [crypto.randomUUID(), id, userId],
  );
  await migrationPool.query('insert into workspace_settings(workspace_id) values ($1)', [id]);
  return {id, name, slug};
}

try {
  await migrate(migrationPool);
  await grantRuntimeAccess(migrationPool, runtimePool);
  const ownership = await assertRuntimeRoleIsNotOwner(runtimePool);
  check('runtime role cannot bypass tenant policies', ownership?.runtime_role !== ownership?.owner_role
    && !ownership?.runtime_superuser && !ownership?.runtime_bypass_rls);

  for (const [name, id] of Object.entries(users)) {
    await migrationPool.query(
      `insert into app_user(id, email, display_name, email_verified, created_at, updated_at)
       values ($1, $2, $3, true, now(), now())`,
      [id, `${id}@example.invalid`, name],
    );
  }

  const workspaceA = await createWorkspace(users.alice, 'RLS Workspace A', `rls-a-${token.slice(0, 20)}`);
  const workspaceB = await createWorkspace(users.bob, 'RLS Workspace B', `rls-b-${token.slice(0, 20)}`);
  workspaceIds.push(workspaceA.id, workspaceB.id);

  await withRequestContext(runtimePool, {userId: users.alice, workspaceId: workspaceA.id}, async client => {
    await client.query(
      `insert into workspace_member(id, workspace_id, user_id, role)
       values ($1, $2, $3, 'viewer')`, [crypto.randomUUID(), workspaceA.id, users.viewer],
    );
    await client.query(
      `insert into document(id, workspace_id, path, title, markdown, created_by)
       values ($1, $2, 'same.md', 'A', '# A', $3)`, [crypto.randomUUID(), workspaceA.id, users.alice],
    );
    await client.query(
      `insert into asset(id, workspace_id, object_key, content_type, byte_size, sha256, created_by)
       values ($1, $2, $3, 'application/octet-stream', 1, $4, $5)`,
      [crypto.randomUUID(), workspaceA.id, `${workspaceA.id}/assets/rls-object`, 'a'.repeat(64), users.alice],
    );
  });
  await withRequestContext(runtimePool, {userId: users.bob, workspaceId: workspaceB.id}, client => client.query(
    `insert into document(id, workspace_id, path, title, markdown, created_by)
     values ($1, $2, 'same.md', 'B', '# B', $3)`, [crypto.randomUUID(), workspaceB.id, users.bob],
  ));

  const ownA = await withRequestContext(runtimePool, {userId: users.alice, workspaceId: workspaceA.id}, client =>
    client.query("select markdown from document where path = 'same.md'"));
  check('member reads its own workspace', ownA.rows.length === 1 && ownA.rows[0].markdown === '# A');

  const forgedB = await withRequestContext(runtimePool, {userId: users.alice, workspaceId: workspaceB.id}, client =>
    client.query("select markdown from document where path = 'same.md'"));
  check('forged workspace context reads no rows', forgedB.rows.length === 0);

  const crossQuery = await withRequestContext(runtimePool, {userId: users.alice, workspaceId: workspaceA.id}, client =>
    client.query('select markdown from document where workspace_id = $1', [workspaceB.id]));
  check('explicit cross-workspace query reads no rows', crossQuery.rows.length === 0);

  await assert.rejects(
    () => withRequestContext(runtimePool, {userId: users.alice, workspaceId: workspaceB.id}, client => client.query(
      `insert into document(id, workspace_id, path, title, markdown, created_by)
       values ($1, $2, 'forged.md', 'forged', '# forged', $3)`,
      [crypto.randomUUID(), workspaceB.id, users.alice],
    )),
    error => error?.code === '42501',
  );
  checks.push('forged workspace write is rejected by RLS');

  await withRequestContext(runtimePool, {userId: users.alice, workspaceId: workspaceA.id}, async client => {
    await client.query('delete from workspace_member where workspace_id = $1 and user_id = $2', [workspaceA.id, users.viewer]);
    const count = Number((await client.query('select count(*)::int as n from document where workspace_id = $1', [workspaceA.id])).rows[0].n);
    check('removing a member preserves workspace content', count === 1);
  });

  const deleted = await withRequestContext(runtimePool, {userId: users.alice, workspaceId: workspaceA.id}, client =>
    client.query('select delete_workspace_and_queue_assets($1)::int as queued', [workspaceA.id]));
  check('workspace deletion queues each object before removing metadata', deleted.rows[0].queued === 1);
  const residual = Number((await migrationPool.query(
    `select (select count(*) from workspace where id = $1)
          + (select count(*) from workspace_member where workspace_id = $1)
          + (select count(*) from workspace_settings where workspace_id = $1)
          + (select count(*) from document where workspace_id = $1)
          + (select count(*) from document_version where workspace_id = $1)
          + (select count(*) from asset where workspace_id = $1)
          + (select count(*) from reference where workspace_id = $1)
          + (select count(*) from store_item where workspace_id = $1)
          + (select count(*) from channel where workspace_id = $1)
          + (select count(*) from channel_member where workspace_id = $1)
          + (select count(*) from message where workspace_id = $1)
          + (select count(*) from workspace_audit where workspace_id = $1) as n`, [workspaceA.id],
  )).rows[0].n);
  check('workspace deletion cascades through every owned table', residual === 0);
  const queuedObjects = Number((await migrationPool.query(
    'select count(*)::int as n from object_deletion where workspace_id = $1', [workspaceA.id],
  )).rows[0].n);
  check('object deletion outbox survives the workspace cascade', queuedObjects === 1);

  const deletionQueue = createObjectDeletionQueue({pool: runtimePool});
  const fixtureQueue = {
    async list() {
      return (await deletionQueue.list(10_000)).filter(item => item.workspaceId === workspaceA.id);
    },
    complete: id => deletionQueue.complete(id),
    fail: (id, error) => deletionQueue.fail(id, error),
  };
  const removedKeys = [];
  const drained = await drainObjectDeletions(fixtureQueue, {
    async remove(objectKey) { removedKeys.push(objectKey); return true; },
    async stat() { return null; },
  });
  check('PostgreSQL object deletion queue drains completed work',
    drained.processed === 1 && drained.removed === 1 && drained.failed === 0);
  check('object deletion queue removes its completed row',
    Number((await migrationPool.query(
      'select count(*)::int as n from object_deletion where workspace_id = $1', [workspaceA.id],
    )).rows[0].n) === 0 && removedKeys.length === 1);

  const publicFunctions = (await migrationPool.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
        and has_function_privilege('public', p.oid, 'execute')`,
    [[
      'is_workspace_member', 'request_workspace_role', 'list_scheduled_workspaces',
      'list_user_workspaces', 'delete_workspace_and_queue_assets',
    ]],
  )).rows;
  check('security-definer functions are not executable by PUBLIC', publicFunctions.length === 0);

  console.log(JSON.stringify({ok: true, runtimeRole: ownership.runtime_role, ownerRole: ownership.owner_role, checks}, null, 2));
} finally {
  if (workspaceIds.length) await migrationPool.query('delete from workspace where id = any($1::text[])', [workspaceIds]).catch(() => {});
  if (workspaceIds.length) await migrationPool.query('delete from object_deletion where workspace_id = any($1::text[])', [workspaceIds]).catch(() => {});
  await migrationPool.query('delete from app_user where id = any($1::text[])', [Object.values(users)]).catch(() => {});
  await runtimePool.end();
  await migrationPool.end();
}
