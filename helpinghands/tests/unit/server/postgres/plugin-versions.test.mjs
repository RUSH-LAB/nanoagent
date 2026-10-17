import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {applyMigration, migratedDatabase} from '../fs/_pglite.mjs';

const MIGRATION = '0041_plugin_versions.sql';

describe('plugin versions', () => {
  it('keeps each upload\'s package as its first version, which its installs follow, and removes them with it', async () => {
    const {db} = await migratedDatabase({until: MIGRATION});
    try {
      await db.exec(`
        alter table market_plugin no force row level security;
        alter table user_plugin no force row level security;
        insert into market_plugin(id, owner_id, version, entry, repository, package, sha256, size, updated_at)
          values ('notes', 'alice', '1.0.0', '{"name": "Notes"}', '{"commit": "${'d'.repeat(40)}"}', 'x', '${'c'.repeat(64)}', 1, '2026-01-01T00:00:00Z');
        insert into user_plugin(user_id, plugin_id, source) values ('bob', 'notes', 'upload'), ('bob', 'bibtex-check', 'nanoagent');
      `);
      await applyMigration(db, MIGRATION);
      await db.exec('alter table market_plugin_version no force row level security');
      const versions = (await db.query('select plugin_id, version, entry, repository, sha256, size, published_at from market_plugin_version')).rows;
      assert.deepEqual(versions, [{
        plugin_id: 'notes', version: '1.0.0', entry: {name: 'Notes'}, repository: {commit: 'd'.repeat(40)},
        sha256: 'c'.repeat(64), size: 1, published_at: new Date('2026-01-01'),
      }]);
      assert.deepEqual((await db.query('select plugin_id, version from user_plugin order by plugin_id')).rows, [
        {plugin_id: 'bibtex-check', version: null}, {plugin_id: 'notes', version: null},
      ]);
      // Only a published version of an upload may be stayed on.
      await db.exec("update user_plugin set version = '1.0.0' where plugin_id = 'notes'");
      await assert.rejects(db.exec("update user_plugin set version = '2.0.0' where plugin_id = 'notes'"), /user_plugin_version_fkey/);
      await assert.rejects(db.exec("update user_plugin set version = '1.0.0' where plugin_id = 'bibtex-check'"), /user_plugin_version_check/);
      // The latest is a published version.
      await assert.rejects(db.exec("update market_plugin set version = '2.0.0'"), /market_plugin_latest_fkey/);
      await db.exec("delete from market_plugin where id = 'notes'");
      assert.deepEqual((await db.query('select plugin_id from market_plugin_version')).rows, []);
      assert.deepEqual((await db.query('select plugin_id from user_plugin')).rows, [{plugin_id: 'bibtex-check'}]);
    } finally {
      await db.close();
    }
  });
});
