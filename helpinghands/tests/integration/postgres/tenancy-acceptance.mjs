#!/usr/bin/env node
/**
 * Real PostgreSQL acceptance test for tenancy: the sign-up policy, workspace,
 * member, storage, and assistant limits, suspension, leaving a workspace,
 * account deletion, platform administration, and the shared rate limits.
 *
 * It drives the running Node server over HTTP, signing in with GitHub through
 * a fake of GitHub's side (_fake-github.mjs). The platform policy is saved
 * first and restored last, and every fixture is removed through the owner
 * connection, so it can run against staging.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {fakeGithubEnv, signInWithGithub} from './_github.mjs';

const require = createRequire(import.meta.url);
const {createPool, migrate, grantRuntimeAccess} = require('../../../src/server/postgres/client.js');

if (!process.env.DATABASE_URL || !process.env.DATABASE_MIGRATION_URL) {
  throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL are required');
}

const migrationPool = createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 2});
const runtimePool = createPool(process.env, {max: 2});
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const domain = `tenancy-${token}.invalid`;
const address = name => `${name.toLowerCase()}@${domain}`;
const invitedAddress = `dave@invited-${token}.invalid`;
// GitHub's accounts for this run, with ids no other run uses.
const githubId = offset => 2_100_000_000 + parseInt(token.slice(0, 5), 16) * 8 + offset;
const github = Object.fromEntries([
  ['root', null], ['alice', address('alice')], ['bob', address('bob')], ['carol', address('carol')],
  ['dave', invitedAddress], ['erin', address('erin')], ['gus', `gus@elsewhere-${token}.invalid`],
].map(([name, email], offset) => [name, {
  id: githubId(offset), login: `${name}-${token}`, name, email, verified: name !== 'erin',
}]));
// Better Auth keys its sign-in limits by client address; this run uses its own.
const clientIp = `203.0.113.${1 + (parseInt(token.slice(0, 2), 16) % 250)}`;
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};

const availablePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const {port: selected} = probe.address();
    probe.close(error => error ? reject(error) : resolve(selected));
  });
});
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
let server;
let logs = '';
let savedPolicy = null;
// Every account this run creates, for cleanup: some are deleted along the way.
const createdUsers = [];

function request(path, {method = 'GET', cookie, body, ip = clientIp} = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
      ...(cookie ? {cookie} : {}),
      'x-real-ip': ip,
      origin,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

async function json(response, expectedStatus) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  assert.equal(response.status, expectedStatus, `${response.url}: ${JSON.stringify(body)}`);
  return body;
}

/** The id of the user whose GitHub account is `user`. */
async function userIdOf(user) {
  return (await migrationPool.query(
    "select user_id from auth_account where provider_id = 'github' and account_id = $1", [String(user.id)],
  )).rows[0]?.user_id;
}

/** Sign in as GitHub user `name`, which makes the account the first time. */
async function signIn(name) {
  const {cookie, error} = await signInWithGithub(request, github[name].login);
  assert.ok(cookie, `${name} signs in with GitHub (${error})`);
  const id = await userIdOf(github[name]);
  if (!createdUsers.includes(id)) createdUsers.push(id);
  return {id, email: github[name].email, cookie};
}

/** A query under forced row-level security, run as a member of the workspace. */
async function asMember(userId, workspaceId, sql, values) {
  const client = await migrationPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [userId, workspaceId]);
    const result = await client.query(sql, values);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited before it became ready\n${logs}`);
    try {
      if ((await fetch(`${origin}/api/health`)).status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready within 30 seconds\n${logs}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

try {
  await migrate(migrationPool);
  await grantRuntimeAccess(migrationPool, runtimePool);
  savedPolicy = (await migrationPool.query('select * from platform_policy')).rows[0];
  await migrationPool.query(
    `update platform_policy set signup_mode = 'invite', signup_allowlist = '{}', max_workspaces_per_user = 2,
       workspace_storage_bytes = 524288000,
       workspace_ai_daily_usd = 1, workspace_ai_monthly_usd = 10, member_ai_daily_usd = 0.5`,
  );

  server = spawn(process.execPath, ['src/server/index.js'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...fakeGithubEnv(Object.values(github)),
      ROOT_GITHUB_LOGIN: github.root.login,
      NANOAGENT_URL: 'off',
      EDITOR_PORT: String(port),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: `tenancy-${token}`.padEnd(48, 'x'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  await waitForServer();
  createdUsers.push(await userIdOf(github.root));

  // ── Sign-up policy ──
  check('the sign-in screen learns sign-up is by invitation',
    (await json(await request('/api/signup-policy'), 200)).signupMode === 'invite');
  const refused = await signInWithGithub(request, github.carol.login);
  check('an uninvited address cannot sign up', refused.error === 'signup-closed' && !await userIdOf(github.carol));

  await migrationPool.query('update platform_policy set signup_allowlist = $1', [[`@${domain}`]]);
  const unverified = await signInWithGithub(request, github.erin.login);
  check('a GitHub account whose email GitHub has not verified cannot sign up',
    unverified.error === 'email-unverified' && !await userIdOf(github.erin));
  const alice = await signIn('alice');
  const bob = await signIn('bob');
  check('an allowlisted domain can sign up', Boolean(alice.id && bob.id));
  await migrationPool.query('insert into platform_admin(user_id) values ($1)', [alice.id]);

  // ── Workspaces per account ──
  const w1 = (await json(await request('/api/workspaces', {method: 'POST', cookie: alice.cookie, body: {name: 'Tenancy One', slug: `t1-${token}`}}), 201)).workspace;
  const w2 = (await json(await request('/api/workspaces', {method: 'POST', cookie: alice.cookie, body: {name: 'Tenancy Two', slug: `t2-${token}`}}), 201)).workspace;
  const third = await json(await request('/api/workspaces', {method: 'POST', cookie: alice.cookie, body: {name: 'Tenancy Three', slug: `t3-${token}`}}), 409);
  check('an account cannot own more workspaces than the policy allows', third.code === 'workspace-limit-reached');
  const direct = await request('/api/auth/organization/create', {method: 'POST', cookie: bob.cookie, body: {name: 'Bypass', slug: `bypass-${token}`}});
  check('Better Auth\'s own workspace endpoint is closed to browsers', direct.status === 403);

  // ── Invitations, members, and the member limit ──
  await json(await request(`/api/workspaces/${w1.id}/invitations`, {method: 'POST', cookie: alice.cookie, body: {email: invitedAddress, role: 'editor'}}), 200);
  const dave = await signIn('dave');
  check('an invited address can sign up while sign-up is by invitation', Boolean(dave.id));
  const invitation = (await migrationPool.query(
    "select id from workspace_invitation where workspace_id = $1 and lower(email) = $2 and status = 'pending'", [w1.id, invitedAddress],
  )).rows[0];
  await json(await request(`/api/invite/${invitation.id}/accept`, {method: 'POST', cookie: dave.cookie}), 200);

  const githubInvite = (await json(await request(`/api/workspaces/${w2.id}/invitations`, {
    method: 'POST', cookie: alice.cookie, body: {githubLogin: `@${github.gus.login}`, role: 'viewer'},
  }), 200)).invitation;
  check('a GitHub account is invited by its username', githubInvite.githubLogin === github.gus.login && githubInvite.email === null);
  const notTheirs = await json(await request(`/api/invite/${githubInvite.id}/accept`, {method: 'POST', cookie: bob.cookie}), 403);
  check('only the invited GitHub account accepts its invitation', notTheirs.code === 'not-recipient');
  const gus = await signIn('gus');
  check('an invited GitHub account can sign up while sign-up is by invitation', Boolean(gus.id));
  const offered = (await json(await request('/api/users/me/invitations', {cookie: gus.cookie}), 200)).invitations;
  check('the invited GitHub account is offered its invitation', offered.some(offer => offer.id === githubInvite.id));
  await json(await request(`/api/invite/${githubInvite.id}/accept`, {method: 'POST', cookie: gus.cookie}), 200);
  check('the invited GitHub account joins', (await request(`/api/workspaces/${w2.id}`, {cookie: gus.cookie})).status === 200);
  await json(await request(`/api/workspaces/${w2.id}/leave`, {method: 'POST', cookie: gus.cookie}), 200);

  await migrationPool.query('insert into workspace_limits(workspace_id, ai_monthly_usd) values ($1, 20)', [w1.id]);

  // ── Assistant budget ──
  await asMember(alice.id, w1.id,
    "insert into ai_usage(workspace_id, user_id, kind, cost_usd) values ($1, $2, 'chat', 1.25)", [w1.id, alice.id]);
  // Every run is on the member's own computer, never on the workspace's budget.
  const offline = await json(await request(`/api/workspaces/${w1.id}/ai/complete`, {method: 'POST', cookie: alice.cookie, body: {prompt: 'hello'}}), 503);
  check('a member without Mochi Lab connected is told to open it', /Mochi Lab on your computer is not connected/.test(offline.error));
  const usage = (await json(await request(`/api/workspaces/${w1.id}/usage`, {cookie: dave.cookie}), 200)).usage;
  check('members see what their workspace has used against its limits',
    usage.ai.today === 1.25 && usage.limits.aiMonthlyUsd === 20 && usage.members === 2);

  // ── Storage ──
  await migrationPool.query('insert into workspace_limits(workspace_id, storage_bytes) values ($1, 16)', [w2.id]);
  const blob = Buffer.alloc(32, 1);
  await assert.rejects(
    asMember(alice.id, w2.id,
      `insert into object_blob(object_key, workspace_id, body, byte_size, sha256) values ($1, $2, $3, $4, $5)`,
      [`${w2.id}/too-big`, w2.id, blob, blob.length, crypto.createHash('sha256').update(blob).digest('hex')]),
    /storage-limit-reached/,
  );
  const notes = Buffer.from('More than sixteen bytes of notes.');
  const notesHash = crypto.createHash('sha256').update(notes).digest('hex');
  await asMember(alice.id, w2.id,
    'insert into fs_content(workspace_id, hash, body, size) values ($1, $2, $3, $4)',
    [w2.id, notesHash, notes, notes.length]);
  await assert.rejects(
    asMember(alice.id, w2.id,
      `insert into fs_node(id, workspace_id, path, kind, content_hash, size, rev)
       values ($1, $2, 'notes/too-big.md', 'file', $3, $4, 1)`,
      [crypto.randomUUID(), w2.id, notesHash, notes.length]),
    /storage-limit-reached/,
  );
  check('the database refuses bytes past the storage limit', true);

  // ── Suspension ──
  await migrationPool.query("update app_user set banned_at = now(), ban_reason = 'acceptance test' where id = $1", [bob.id]);
  const banned = await signInWithGithub(request, github.bob.login);
  check('a suspended account cannot sign in', banned.error === 'account-suspended');
  await migrationPool.query('update app_user set banned_at = null, ban_reason = null where id = $1', [bob.id]);
  bob.cookie = (await signIn('bob')).cookie;
  check('lifting a suspension restores sign-in', true);

  // ── Leaving ──
  await json(await request(`/api/workspaces/${w1.id}/leave`, {method: 'POST', cookie: dave.cookie}), 200);
  check('a member leaves a workspace', (await request(`/api/workspaces/${w1.id}`, {cookie: dave.cookie})).status === 404);
  const lastOwner = await request(`/api/workspaces/${w2.id}/leave`, {method: 'POST', cookie: alice.cookie});
  check('the only owner cannot leave', lastOwner.status === 400);

  // ── Deleting accounts ──
  await json(await request(`/api/workspaces/${w2.id}/invitations`, {method: 'POST', cookie: alice.cookie, body: {email: bob.email, role: 'viewer'}}), 200);
  const bobInvite = (await migrationPool.query(
    "select id from workspace_invitation where workspace_id = $1 and lower(email) = $2 and status = 'pending'", [w2.id, bob.email],
  )).rows[0];
  await json(await request(`/api/invite/${bobInvite.id}/accept`, {method: 'POST', cookie: bob.cookie}), 200);
  check('a member joins a workspace that is out of storage', true);
  await migrationPool.query('delete from platform_admin where user_id = $1', [alice.id]);
  const shared = await json(await request('/api/auth/delete-user', {method: 'POST', cookie: alice.cookie, body: {}}), 409);
  check('an account cannot be deleted while it is the only owner of a workspace others use', /Tenancy Two/.test(shared.message));
  await json(await request(`/api/workspaces/${w2.id}/leave`, {method: 'POST', cookie: bob.cookie}), 200);
  await json(await request('/api/auth/delete-user', {method: 'POST', cookie: alice.cookie, body: {}}), 200);
  const left = (await migrationPool.query('select id from workspace where id = any($1::text[])', [[w1.id, w2.id]])).rows;
  check('deleting an account deletes the workspaces it used alone',
    left.length === 0 && !(await migrationPool.query('select 1 from app_user where id = $1', [alice.id])).rowCount);

  // ── Shared rate limits ──
  const limitIp = `198.51.100.${1 + (parseInt(token.slice(2, 4), 16) % 250)}`;
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    statuses.push((await request('/api/auth/sign-in/social', {method: 'POST', body: {provider: 'github'}, ip: limitIp})).status);
  }
  check('sign-in attempts are limited per client address', statuses.at(-1) === 429 && statuses.slice(0, 10).every(status => status !== 429));
  check('rate-limit counters are kept in PostgreSQL',
    (await migrationPool.query('select 1 from rate_limit_bucket where key like $1', [`%${limitIp}%`])).rowCount > 0);

  console.log(JSON.stringify({ok: true, checks}, null, 2));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await stopServer();
  const users = createdUsers;
  await migrationPool.query("delete from workspace where slug like $1", [`%-${token}`]).catch(() => {});
  await migrationPool.query('delete from platform_audit where actor_id = any($1::text[])', [users]).catch(() => {});
  await migrationPool.query('delete from app_user where id = any($1::text[])', [users]).catch(() => {});
  await migrationPool.query('delete from rate_limit_bucket where key like $1 or key like $2', [`%${clientIp}%`, '%198.51.100.%']).catch(() => {});
  if (savedPolicy) {
    await migrationPool.query(
      `update platform_policy set signup_mode = $1, signup_allowlist = $2, max_workspaces_per_user = $3,
         workspace_storage_bytes = $4, workspace_ai_daily_usd = $5,
         workspace_ai_monthly_usd = $6, member_ai_daily_usd = $7, updated_by = $8, updated_at = $9`,
      [savedPolicy.signup_mode, savedPolicy.signup_allowlist, savedPolicy.max_workspaces_per_user,
        savedPolicy.workspace_storage_bytes, savedPolicy.workspace_ai_daily_usd,
        savedPolicy.workspace_ai_monthly_usd, savedPolicy.member_ai_daily_usd, savedPolicy.updated_by, savedPolicy.updated_at],
    ).catch(() => {});
  }
  await runtimePool.end();
  await migrationPool.end();
}
