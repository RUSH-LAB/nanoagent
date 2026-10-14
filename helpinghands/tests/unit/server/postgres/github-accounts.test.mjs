import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {applyMigration, migratedDatabase} from '../fs/_pglite.mjs';

const MIGRATION = '0033_github_accounts_no_member_limit.sql';

/** The database before MIGRATION, its own test users given GitHub sign-ins, and `sql` run as its owner. */
async function before(sql) {
  const {db} = await migratedDatabase({until: MIGRATION});
  await db.exec(`
    insert into auth_account(id, issuer, account_id, provider_id, user_id, created_at, updated_at)
      select 'gh-' || id, 'github', id, 'github', id, now(), now() from app_user;
    insert into app_user(id, email, display_name, email_verified, created_at, updated_at)
      values ('ada', 'ada@test.invalid', 'ada', true, now(), now());
    ${sql}
  `);
  return db;
}

describe('accounts without GitHub, and no member limit', () => {
  it('deletes the accounts no one can sign in to, and drops the member limit', async () => {
    const db = await before(`insert into workspace_member(id, workspace_id, user_id, role) values ('m-ada', 'lab', 'ada', 'viewer');`);
    try {
      await applyMigration(db, MIGRATION);
      const users = (await db.query('select id from app_user order by id')).rows.map(row => row.id);
      assert.deepEqual(users, ['alice', 'bob', 'carol', 'vic']);
      assert.equal((await db.query("select count(*)::int as n from workspace_member where user_id = 'ada'")).rows[0].n, 0);
      const columns = (await db.query(
        "select column_name from information_schema.columns where column_name in ('workspace_max_members', 'max_members')")).rows;
      assert.deepEqual(columns, []);
      // 23 members, past the old default of 20: the trigger that held it is gone.
      await db.exec(`
        insert into app_user(id, email, display_name, email_verified, created_at, updated_at)
          select 'u' || n, 'u' || n || '@example.invalid', 'u' || n, true, now(), now() from generate_series(1, 20) n;
        insert into workspace_member(id, workspace_id, user_id, role) select 'mu' || n, 'lab', 'u' || n, 'viewer' from generate_series(1, 20) n;
      `);
      assert.equal((await db.query("select count(*)::int as n from workspace_member where workspace_id = 'lab'")).rows[0].n, 23);
    } finally {
      await db.close();
    }
  });

  it('stops, deleting nothing, at an account without GitHub that owns a workspace', async () => {
    const db = await before(`insert into workspace_member(id, workspace_id, user_id, role) values ('m-ada', 'other', 'ada', 'owner');`);
    try {
      // One query of several statements is one transaction: the member limit stays too.
      await assert.rejects(applyMigration(db, MIGRATION), /ada@test\.invalid/);
      assert.equal((await db.query('select workspace_max_members as n from platform_policy')).rows[0].n, 20);
      assert.equal((await db.query("select count(*)::int as n from app_user where id = 'ada'")).rows[0].n, 1);
    } finally {
      await db.close();
    }
  });
});
