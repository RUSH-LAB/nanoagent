'use strict';

/**
 * The root account on PostgreSQL: the GitHub account named by ROOT_GITHUB_LOGIN
 * (root-account.js), provisioned at every start, made a platform administrator
 * and an owner of the root workspace.
 */
const crypto = require('crypto');
const postgres = require('./postgres/database');
const {ensureRootAccount} = require('./root-account');

const ROOT_WORKSPACE = 'mochi';

async function ensureRootUser(auth, options) {
  const {userId, login, created} = await ensureRootAccount(auth, options);
  const client = await postgres.migrationPool.connect();
  try {
    await client.query('begin');
    const workspaces = (await client.query(
      'select id from workspace where slug = $1', [ROOT_WORKSPACE],
    )).rows;
    for (const workspace of workspaces) {
      await client.query(
        `insert into workspace_member(id, workspace_id, user_id, role, created_at)
         values ($1, $2, $3, 'owner', now())
         on conflict (workspace_id, user_id) do update set role = 'owner'`,
        [crypto.randomUUID(), workspace.id, userId],
      );
    }
    await client.query(
      'insert into platform_admin(user_id) values ($1) on conflict (user_id) do nothing',
      [userId],
    );
    await client.query('commit');
    return {userId, login, created, workspace: null};
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureRootUser,
};
