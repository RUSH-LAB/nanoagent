import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {migratedDatabase, pgQuery} from '../server/fs/_pglite.mjs';
import {fingerprint, workspaceTables} from '../../../scripts/db/sync.mjs';

describe('a workspace, as db:push reads it', () => {
  let db;
  let client;
  before(async () => {
    ({db} = await migratedDatabase());
    client = {query: pgQuery(db)};
  });
  after(() => db?.close());

  it('is the workspace row and every table with a workspace_id, each after the tables it references', async () => {
    const tables = await workspaceTables(client);
    const names = tables.map(table => table.name);
    assert.ok(names.includes('workspace') && names.includes('message') && !names.includes('app_user') && !names.includes('user_plugin'));
    const at = name => names.indexOf(name);
    for (const [parent, child] of [['workspace', 'channel'], ['channel', 'message'], ['document', 'document_version'],
      ['fs_content', 'fs_node'], ['fs_node', 'fs_crdt'], ['plugin_session', 'plugin_run'], ['plugin_session', 'ai_usage']]) {
      assert.ok(at(parent) < at(child), `${parent} before ${child}`);
    }
    const byName = Object.fromEntries(tables.map(table => [table.name, table]));
    assert.equal(byName.workspace.key, 'id');
    assert.equal(byName.message.key, 'workspace_id');
    // A sequence's column is left to the database a copy writes to, and orders the copy.
    assert.equal(byName.ai_usage.serial, 'id');
    assert.ok(!byName.ai_usage.columns.includes('id'));
    assert.equal(byName.fs_change.serial, 'seq');
    assert.ok(byName.message.users.includes('user_id'));
    assert.ok(byName.workspace.users.includes('created_by'));
  });

  it('has a fingerprint that changes with any of its rows, and only its own', async () => {
    const tables = await workspaceTables(client);
    const lab = await fingerprint(client, tables, 'lab');
    const other = await fingerprint(client, tables, 'other');
    assert.notEqual(lab, other);
    assert.equal(await fingerprint(client, tables, 'lab'), lab);
    await db.exec("update workspace_member set role = 'viewer' where id = 'm2'");
    assert.notEqual(await fingerprint(client, tables, 'lab'), lab);
    assert.equal(await fingerprint(client, tables, 'other'), other);
  });
});
