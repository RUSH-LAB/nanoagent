import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(root, 'src/server/postgres/migrations');
const sql = fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()
  .map(name => fs.readFileSync(path.join(migrationsDir, name), 'utf8')).join('\n');
const servicesSource = fs.readFileSync(path.join(root, 'src/server/postgres/services.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src/server/index.js'), 'utf8');

const authControlTables = ['workspace', 'workspace_member', 'workspace_invitation'];
const tenantTables = [
  'workspace_settings',
  'workspace_member_preferences', 'document', 'document_version', 'asset', 'reference',
  'store_item', 'channel', 'channel_member', 'message', 'workspace_audit',
];

describe('Postgres production schema', () => {
  it('wires every runtime repository to the PostgreSQL service bundle', () => {
    const services = [
      'store', 'documents', 'workspaceSettings', 'preferences', 'assets',
      'workspaceContexts', 'org', 'chat', 'roles', 'objectDeletions',
    ];
    for (const name of services) {
      assert.match(servicesSource, new RegExp(`\\b${name}:`), `${name} is exported by PostgreSQL services`);
      assert.match(serverSource, new RegExp(`postgresServices\\?\\.${name}`), `${name} is selected by server startup`);
    }
  });

  it('defines the required product tables', () => {
    for (const table of ['app_user', ...authControlTables, ...tenantTables, 'user_preferences', 'object_deletion']) {
      assert.match(sql, new RegExp(`create table ${table} \\(`));
    }
  });

  it('puts immutable workspace ids on every tenant-owned table', () => {
    for (const table of tenantTables) {
      const body = sql.match(new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? '';
      assert.match(body, /workspace_id text (?:not null|primary key) references workspace\(id\) on delete cascade/,
        `${table} must cascade from workspace_id`);
    }
  });

  it('gives content assets a workspace-relative logical path', () => {
    assert.match(sql, /alter table asset add column path text/i);
    assert.match(sql, /unique \(workspace_id, path\)/i);
    assert.match(sql, /create policy asset_update on asset/i);
  });

  it('enables RLS for tenant data and forces it for ordinary domain tables', () => {
    for (const table of tenantTables) {
      assert.match(sql, new RegExp(`alter table ${table} enable row level security;`));
    }
    for (const table of [
      'workspace_member_preferences', 'document', 'document_version', 'asset', 'reference',
      'store_item', 'channel', 'channel_member', 'message', 'workspace_audit',
    ]) {
      assert.match(sql, new RegExp(`alter table ${table} force row level security;`));
    }
  });

  it('assigns organization lifecycle to Better Auth while retaining product RLS', () => {
    assert.match(sql, /alter table workspace add column if not exists metadata text;/);
    assert.match(sql, /status in \('pending', 'accepted', 'rejected', 'canceled', 'expired'\)/);
    assert.match(sql, /alter table workspace disable row level security;/);
    assert.match(sql, /alter table workspace_member disable row level security;/);
    assert.match(sql, /alter table workspace_invitation disable row level security;/);
    assert.match(sql, /drop function if exists create_workspace_with_owner\(text, text\);/);
    assert.match(sql, /drop function if exists accept_workspace_invitation\(text\);/);
    assert.match(sql, /alter table document force row level security;/);
  });

  it('enforces the owner/editor/viewer write boundary in RLS', () => {
    assert.match(sql, /create policy document_insert[\s\S]*?in \('owner', 'editor'\)/);
    assert.match(sql, /create policy document_update[\s\S]*?in \('owner', 'editor'\)/);
    assert.match(sql, /create policy document_delete[\s\S]*?= 'owner'/);
    assert.match(sql, /create policy reference_insert[\s\S]*?in \('owner', 'editor'\)/);
    assert.match(sql, /create policy reference_update[\s\S]*?in \('owner', 'editor'\)/);
    assert.match(sql, /create policy reference_delete[\s\S]*?= 'owner'/);
    assert.match(sql, /create policy workspace_settings_write[\s\S]*?= 'owner'/);
    assert.doesNotMatch(sql, /create policy document_scope/,
      'one broad policy would let viewers mutate rows they can read');
  });

  it('does not leave security-definer entry points executable by PUBLIC', () => {
    for (const signature of [
      'is_workspace_member\\(text\\)',
      'request_workspace_role\\(text\\)',
      'list_scheduled_workspaces\\(\\)',
      'list_user_workspaces\\(text\\)',
      'delete_workspace_and_queue_assets\\(text\\)',
    ]) {
      assert.match(sql, new RegExp(`revoke execute on function ${signature} from public;`));
    }
  });

  it('limits message mutation to the authenticated author', () => {
    assert.match(sql, /create policy message_insert[\s\S]*?user_id = request_user_id\(\)/);
    assert.match(sql, /create policy message_update[\s\S]*?user_id = request_user_id\(\)/);
    assert.match(sql, /create policy message_delete[\s\S]*?user_id = request_user_id\(\)/);
    assert.doesNotMatch(sql, /create policy message_scope/);
  });

  it('queues object keys before a workspace hard delete', () => {
    const body = sql.match(/create or replace function delete_workspace_and_queue_assets[\s\S]*?end \$\$;/)?.[0] ?? '';
    assert.match(body, /insert into object_deletion/);
    assert.match(body, /select gen_random_uuid\(\)::text, workspace_id, object_key from asset/);
    assert.match(body, /delete from workspace/);
  });
});
