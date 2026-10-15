import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {applyMigration, migratedDatabase} from '../fs/_pglite.mjs';

const MIGRATION = '0037_user_plugin.sql';

describe('plugins installed by each member', () => {
  it('installs each workspace\'s plugins for whoever added them, and drops the workspaces\' list', async () => {
    const {db} = await migratedDatabase({until: MIGRATION});
    try {
      await db.exec(`
        insert into market_plugin(id, owner_id, version, entry, package, sha256, size)
          values ('notes', 'alice', '1.0.0', '{}', 'x', '${'c'.repeat(64)}', 1);
        insert into workspace_plugin(workspace_id, plugin_id, source, added_by, added_at, tags) values
          ('lab', 'notes', 'upload', 'alice', '2026-01-01', '{Writing}'),
          ('other', 'notes', 'upload', 'alice', '2026-02-01', '{Later}'),
          ('lab', 'bibtex-check', 'nanoagent', 'bob', '2026-01-02', '{}'),
          ('other', 'bibtex-check', 'nanoagent', null, '2026-01-03', '{}');
      `);
      await applyMigration(db, MIGRATION);
      const installs = (await db.query('select user_id, plugin_id, source, tags from user_plugin order by user_id, plugin_id')).rows;
      assert.deepEqual(installs, [
        {user_id: 'alice', plugin_id: 'notes', source: 'upload', tags: ['Writing']},
        {user_id: 'bob', plugin_id: 'bibtex-check', source: 'nanoagent', tags: []},
      ]);
      assert.equal((await db.query("select to_regclass('workspace_plugin') as t")).rows[0].t, null);
      const {relforcerowsecurity} = (await db.query("select relforcerowsecurity from pg_class where relname = 'user_plugin'")).rows[0];
      assert.equal(relforcerowsecurity, true);
      // An upload's installs leave with it.
      await db.exec("alter table market_plugin no force row level security; delete from market_plugin where id = 'notes';");
      assert.deepEqual((await db.query('select user_id from user_plugin')).rows, [{user_id: 'bob'}]);
    } finally {
      await db.close();
    }
  });
});
