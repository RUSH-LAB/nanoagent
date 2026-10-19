import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {applyMigration, migratedDatabase} from '../fs/_pglite.mjs';

const MIGRATION = '0044_fs_home_owned.sql';

describe('home folders owned by their member', () => {
  it('makes a home someone else opened up private to its member again, keeping what its member shared', async () => {
    const {db} = await migratedDatabase({until: MIGRATION});
    try {
      // Bob, an editor, wrote into Alice's home before she had one.
      await db.exec(`
        alter table fs_node no force row level security;
        alter table fs_change no force row level security;
        insert into fs_content(workspace_id, hash, body, size) values ('lab', '${'a'.repeat(64)}', 'x', 1);
        insert into fs_node(id, workspace_id, path, kind, access, access_explicit, owner_id, rev, created_by) values
          ('h', 'lab', 'home', 'folder', 'workspace', false, 'bob', 1, 'bob'),
          ('ha', 'lab', 'home/alice', 'folder', 'workspace', false, 'bob', 2, 'bob'),
          ('pub', 'lab', 'home/alice/site', 'folder', 'public', true, 'alice', 3, 'alice');
        insert into fs_node(id, workspace_id, path, kind, content_hash, size, access, access_explicit, owner_id, rev, created_by) values
          ('f1', 'lab', 'home/alice/notes.md', 'file', '${'a'.repeat(64)}', 1, 'workspace', false, 'bob', 4, 'bob'),
          ('f2', 'lab', 'home/alice/site/index.md', 'file', '${'a'.repeat(64)}', 1, 'public', false, 'alice', 5, 'alice'),
          ('f3', 'lab', 'homework.md', 'file', '${'a'.repeat(64)}', 1, 'workspace', false, 'bob', 6, 'bob');
      `);
      await applyMigration(db, MIGRATION);
      await db.exec('alter table fs_node no force row level security; alter table fs_change no force row level security');
      const nodes = (await db.query('select id, access, owner_id from fs_node order by id')).rows;
      assert.deepEqual(nodes, [
        {id: 'f1', access: 'private', owner_id: 'alice'},
        {id: 'f2', access: 'public', owner_id: 'alice'},
        {id: 'f3', access: 'workspace', owner_id: 'bob'},
        {id: 'h', access: 'workspace', owner_id: 'bob'},
        {id: 'ha', access: 'private', owner_id: 'alice'},
        {id: 'pub', access: 'public', owner_id: 'alice'},
      ]);
      const logged = (await db.query("select node_id, access from fs_change where op = 'access' order by node_id")).rows;
      assert.deepEqual(logged, [{node_id: 'f1', access: 'private'}, {node_id: 'ha', access: 'private'}]);
      const stale = (await db.query(`select n.id from fs_node n where n.id in ('f1', 'ha')
        and n.rev <> (select max(seq) from fs_change c where c.node_id = n.id)`)).rows;
      assert.deepEqual(stale, []);

      await assert.rejects(db.exec("update fs_node set access = 'workspace' where id = 'ha'"), /a folder private to them/);
      await assert.rejects(db.exec("update fs_node set path = 'alice' where id = 'ha'"), /cannot move/);
      await assert.rejects(db.exec(`insert into fs_node(id, workspace_id, path, kind, access, owner_id, rev)
        values ('hb', 'lab', 'home/bob', 'folder', 'private', 'alice', 7)`), /a folder private to them/);
      // Deleting an account leaves its home without an owner.
      await db.exec("delete from app_user where id = 'alice'");
      assert.equal((await db.query("select owner_id from fs_node where id = 'ha'")).rows[0].owner_id, null);
    } finally {
      await db.close();
    }
  });
});
