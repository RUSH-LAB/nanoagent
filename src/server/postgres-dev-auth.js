'use strict';

const crypto = require('crypto');
const {hashPassword} = require('better-auth/crypto');
const postgres = require('./postgres/database');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_AUTOLOGIN = false;
const ROOT_USERNAME = 'root';
const ROOT_EMAIL = (process.env.ROOT_EMAIL || 'root@mochi.local').trim().toLowerCase();
const ROOT_PASSWORD = process.env.ROOT_PASSWORD || 'root@mochi.local';
const ROOT_NAME = process.env.ROOT_NAME || 'Root User';
const ROOT_WORKSPACE = 'mochi';
const ROOT_LOGIN_ENABLED = process.env.POSTGRES_ROOT_LOGIN === 'true' && !IS_PRODUCTION;

function isLoopback(req) {
  const address = req.socket?.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

async function provisionRoot(auth) {
  const pool = postgres.migrationPool;
  let root = (await pool.query(
    'select id from app_user where lower(email) = lower($1)', [ROOT_EMAIL],
  )).rows[0];

  if (!root) {
    await auth.api.signUpEmail({body: {email: ROOT_EMAIL, password: ROOT_PASSWORD, name: ROOT_NAME}});
    root = (await pool.query(
      'select id from app_user where lower(email) = lower($1)', [ROOT_EMAIL],
    )).rows[0];
  }
  if (!root) throw new Error('Root account could not be created');

  const password = await hashPassword(ROOT_PASSWORD);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'update app_user set display_name = $1, email_verified = true, updated_at = now() where id = $2',
      [ROOT_NAME, root.id],
    );
    const credential = await client.query(
      `update auth_account set password = $1, updated_at = now()
       where user_id = $2 and provider_id = 'credential'`,
      [password, root.id],
    );
    if (credential.rowCount !== 1) throw new Error('Root credential account is missing or ambiguous');

    const workspaces = (await client.query(
      'select id from workspace where slug = $1', [ROOT_WORKSPACE],
    )).rows;
    for (const workspace of workspaces) {
      await client.query(
        `insert into workspace_member(id, workspace_id, user_id, role, created_at)
         values ($1, $2, $3, 'owner', now())
         on conflict (workspace_id, user_id) do update set role = 'owner'`,
        [crypto.randomUUID(), workspace.id, root.id],
      );
    }
    await client.query(
      'insert into platform_admin(user_id) values ($1) on conflict (user_id) do nothing',
      [root.id],
    );
    await client.query('commit');
    return root.id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function handleDevLogin(req, res, auth, json, readBody) {
  if (!ROOT_LOGIN_ENABLED) return json(res, 404, {error: 'Not found', path: '/api/dev-login'});
  if (!isLoopback(req)) return json(res, 403, {error: 'Development root sign-in is available from localhost only'});

  try {
    const body = await readBody(req);
    if (String(body?.email ?? '').trim().toLowerCase() !== ROOT_EMAIL || body?.password !== ROOT_PASSWORD) {
      return json(res, 401, {error: 'Invalid email or password'});
    }
    await provisionRoot(auth);
    const result = await auth.api.signInEmail({
      body: {email: ROOT_EMAIL, password: ROOT_PASSWORD},
      returnHeaders: true,
    });
    const cookies = result.headers?.getSetCookie?.() ?? [];
    if (cookies.length && typeof res.setHeader === 'function') res.setHeader('Set-Cookie', cookies);
    return json(res, 200, {user: result.response.user});
  } catch (error) {
    return json(res, 500, {error: `Development root sign-in failed: ${error.message}`});
  }
}

module.exports = {
  DEV_AUTOLOGIN,
  ROOT_USERNAME,
  ensureRootUser: async auth => {
    if (!ROOT_LOGIN_ENABLED) return null;
    const userId = await provisionRoot(auth);
    return {
      username: ROOT_USERNAME,
      userId,
      created: false,
      workspace: null,
      demo: null,
    };
  },
  ensureDevelopmentWorkspace: () => null,
  handleDevLogin,
  provisionRoot,
  isLoopback,
};
