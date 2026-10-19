#!/usr/bin/env node
/**
 * Real PostgreSQL acceptance test for the running Node server.
 *
 * Unlike the PGlite unit tests, this exercises pg.Pool, Better Auth's HTTP
 * handler, the workspace lifecycle hooks, RequestContext, repositories, and
 * PostgreSQL RLS together. Fixtures are removed through the owner connection.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {fakeGithubEnv, signInWithGithub} from './_github.mjs';

const require = createRequire(import.meta.url);
const {createPool, migrate, grantRuntimeAccess, assertRuntimeRoleIsNotOwner} = require('../../../src/server/postgres/client.js');
const {createPostgresAssets} = require('../../../src/server/postgres/settings.js');

if (!process.env.DATABASE_URL || !process.env.DATABASE_MIGRATION_URL) {
  throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL are required');
}

const migrationPool = createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 2});
const runtimePool = createPool(process.env, {max: 2});
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const token = crypto.randomUUID().replace(/-/g, '');
const availablePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const {port: selected} = probe.address();
    probe.close(error => error ? reject(error) : resolve(selected));
  });
});
const port = process.env.POSTGRES_SMOKE_PORT
  ? Number(process.env.POSTGRES_SMOKE_PORT)
  : await availablePort();
const origin = `http://127.0.0.1:${port}`;
const email = `postgres-smoke-${token}@example.invalid`;
const memberEmail = `postgres-member-${token}@example.invalid`;
const slug = `postgres-smoke-${token.slice(0, 20)}`;
// GitHub's accounts for this run, with ids no other run uses.
const githubId = offset => 2_000_000_000 + parseInt(token.slice(0, 6), 16) * 4 + offset;
const githubUsers = {
  root: {id: githubId(0), login: `smoke-root-${token.slice(0, 8)}`, name: 'Smoke Root', email: null, verified: true},
  owner: {id: githubId(1), login: `smoke-owner-${token.slice(0, 8)}`, name: 'PostgreSQL Smoke', email, verified: true},
  member: {id: githubId(2), login: `smoke-member-${token.slice(0, 8)}`, name: 'PostgreSQL Member', email: memberEmail, verified: true},
};
let server;
let userId;
let memberUserId;
let rootUserId;
let workspaceId;
let logs = '';

// Rate limits are kept in PostgreSQL per client address, so each run uses its own.
const clientIp = `203.0.113.${1 + (parseInt(token.slice(0, 2), 16) % 250)}`;

function request(path, {method = 'GET', cookie, body} = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
      ...(cookie ? {cookie} : {}),
      'x-real-ip': clientIp,
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

/** The id of the user whose GitHub account is `github`. */
async function userIdOf(github) {
  return (await migrationPool.query(
    "select user_id from auth_account where provider_id = 'github' and account_id = $1", [String(github.id)],
  )).rows[0]?.user_id;
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited before it became ready\n${logs}`);
    try {
      const response = await request('/api/health');
      if (response.status === 200) return;
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

// Sign-up defaults to invitation only; this run's addresses are allowed for its length.
let savedAllowlist = null;

try {
  await migrate(migrationPool);
  await grantRuntimeAccess(migrationPool, runtimePool);
  await assertRuntimeRoleIsNotOwner(runtimePool);
  savedAllowlist = (await migrationPool.query('select signup_allowlist from platform_policy')).rows[0].signup_allowlist;
  await migrationPool.query("update platform_policy set signup_allowlist = array_append(signup_allowlist, '@example.invalid')");

  server = spawn(process.execPath, ['src/server/index.js'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Never used: no computer here connects without a key of its own.
      OPENROUTER_MANAGEMENT_KEY: 'acceptance-unused',
      ...fakeGithubEnv(Object.values(githubUsers)),
      ROOT_GITHUB_LOGIN: githubUsers.root.login,
      EDITOR_PORT: String(port),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: `postgres-smoke-${token}`.padEnd(48, 'x'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { logs += chunk; process.stdout.write(chunk); });
  server.stderr.on('data', chunk => { logs += chunk; process.stderr.write(chunk); });
  await waitForServer();

  // The server provisioned root from ROOT_GITHUB_LOGIN before it listened.
  rootUserId = await userIdOf(githubUsers.root);
  assert.equal((await migrationPool.query('select 1 from platform_admin where user_id = $1', [rootUserId])).rowCount, 1,
    'root is provisioned as a platform administrator');

  const {cookie} = await signInWithGithub(request, githubUsers.owner.login);
  assert.ok(cookie, 'the owner signs up with GitHub');
  userId = await userIdOf(githubUsers.owner);
  const {cookie: memberCookie} = await signInWithGithub(request, githubUsers.member.login);
  assert.ok(memberCookie, 'the member signs up with GitHub');
  memberUserId = await userIdOf(githubUsers.member);

  const created = await json(await request('/api/workspaces', {
    method: 'POST', cookie, body: {name: 'PostgreSQL Smoke', slug},
  }), 201);
  workspaceId = created.workspace.id;
  assert.equal(created.workspace.role, 'owner');

  const listed = await json(await request('/api/workspaces', {cookie}), 200);
  assert.ok(listed.workspaces.some(workspace => workspace.id === workspaceId && workspace.role === 'owner'));

  const me = await json(await request('/api/users/me', {cookie}), 200);
  assert.equal(me.userId, userId);
  assert.equal(me.role, 'user');

  const sharedSettings = await json(await request(`/api/workspaces/${workspaceId}/settings`, {
    method: 'PUT', cookie, body: {settings: {brand: 'PostgreSQL smoke'}},
  }), 200);
  assert.equal(sharedSettings.settings.brand, 'PostgreSQL smoke');
  const memberSettings = await json(await request(`/api/workspaces/${workspaceId}/member-preferences`, {
    method: 'PUT', cookie, body: {settings: {sidebar: 'compact'}},
  }), 200);
  assert.equal(memberSettings.settings.sidebar, 'compact');

  const preferences = await json(await request('/api/preferences', {
    method: 'PUT', cookie, body: {preferences: {colorMode: 'dark'}},
  }), 200);
  assert.equal(preferences.preferences.colorMode, 'dark');

  const bookmarkPath = '/smoke/postgresql';
  await json(await request(`/api/workspaces/${workspaceId}/bookmarks`, {
    method: 'POST', cookie, body: {path: bookmarkPath, title: 'PostgreSQL smoke'},
  }), 200);
  const bookmarks = await json(await request(`/api/workspaces/${workspaceId}/bookmarks`, {cookie}), 200);
  assert.ok(bookmarks.bookmarks.some(bookmark => bookmark.path === bookmarkPath));

  const channelList = await json(await request(`/api/workspaces/${workspaceId}/chat/channels`, {cookie}), 200);
  const general = channelList.channels.find(channel => channel.name === 'general');
  assert.ok(general?.id, 'workspace provisioning created the general channel');
  const posted = await json(await request(`/api/workspaces/${workspaceId}/chat/channels/${general.id}/messages`, {
    method: 'POST', cookie, body: {body: 'PostgreSQL-backed chat'},
  }), 200);
  assert.equal(posted.message.body, 'PostgreSQL-backed chat');

  const ownerMembership = (await migrationPool.query(
    'select id from workspace_member where workspace_id = $1 and user_id = $2', [workspaceId, userId],
  )).rows[0];
  const ownerContext = {userId, workspaceId, membershipId: ownerMembership.id, role: 'owner'};
  const assetRepository = createPostgresAssets({pool: runtimePool});
  const asset = await assetRepository.create(ownerContext, {
    objectKey: `${workspaceId}/assets/smoke-object`,
    contentType: 'application/octet-stream',
    byteSize: 1,
    sha256: 'a'.repeat(64),
  });
  assert.equal((await assetRepository.get(ownerContext, asset.id)).objectKey, asset.objectKey);
  assert.equal(await assetRepository.remove(ownerContext, asset.id), true);

  const invited = await json(await request(`/api/workspaces/${workspaceId}/invitations`, {
    method: 'POST', cookie, body: {email: memberEmail, role: 'viewer'},
  }), 200);
  assert.equal(invited.invitation.email, memberEmail);
  await json(await request(`/api/invite/${invited.invitation.id}`), 200);
  const accepted = await json(await request(`/api/invite/${invited.invitation.id}/accept`, {
    method: 'POST', cookie: memberCookie,
  }), 200);
  assert.equal(accepted.organizationId, workspaceId);

  const roster = await json(await request(`/api/workspaces/${workspaceId}/members`, {cookie}), 200);
  const member = roster.members.find(candidate => candidate.id === memberUserId);
  assert.equal(member.role, 'viewer');
  // A viewer keeps their own plugin files: their home is theirs to write (fs_may_write).
  await json(await request(`/api/workspaces/${workspaceId}/agent-files/content?plugin=echo&path=notes.txt&create=1`, {
    method: 'PUT', cookie: memberCookie, body: 'kept by a viewer',
  }), 200);
  await json(await request(`/api/workspaces/${workspaceId}/documents`, {
    method: 'POST', cookie: memberCookie, body: {path: 'smoke/viewer.mdx', markdown: '# Not a viewer\'s to write'},
  }), 403);
  const promoted = await json(await request(`/api/workspaces/${workspaceId}/members/${member.memberId}/role`, {
    method: 'POST', cookie, body: {role: 'editor'},
  }), 200);
  assert.equal(promoted.member.role, 'editor');

  const documentPath = 'smoke/postgresql.mdx';
  await json(await request(`/api/workspaces/${workspaceId}/documents`, {
    method: 'POST', cookie, body: {path: documentPath, markdown: '# PostgreSQL\n\nRuntime repository smoke test.'},
  }), 201);
  const document = await json(await request(
    `/api/workspaces/${workspaceId}/documents?path=${encodeURIComponent(documentPath)}`,
    {cookie},
  ), 200);
  assert.equal(document.markdown, '# PostgreSQL\n\nRuntime repository smoke test.');

  const memberDocumentPath = 'smoke/member-postgresql.mdx';
  await json(await request(`/api/workspaces/${workspaceId}/documents`, {
    method: 'POST', cookie: memberCookie,
    body: {path: memberDocumentPath, markdown: '# Member write through RLS'},
  }), 201);

  await json(await request(`/api/workspaces/${workspaceId}/members/${member.memberId}`, {
    method: 'DELETE', cookie,
  }), 200);
  await json(await request(`/api/workspaces/${workspaceId}/documents/tree`, {cookie: memberCookie}), 404);

  const forgedWorkspaceId = crypto.randomUUID();
  await json(await request(`/api/workspaces/${forgedWorkspaceId}/documents/tree`, {cookie}), 404);

  // Documents and chat are files in the workspace file system, under forced
  // row-level security, so even the owner role counts them as the workspace's
  // owner: the two Markdown documents, and the general channel's name entry.
  const counter = await migrationPool.connect();
  await counter.query('begin');
  await counter.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [userId, workspaceId]);
  const physical = await counter.query(
    `select w.slug,
            (select count(*)::int from workspace_member m where m.workspace_id = w.id) as members,
            (select count(*)::int from fs_node n where n.workspace_id = w.id and n.kind = 'file' and n.path like 'smoke/%.mdx') as documents,
            (select count(*)::int from workspace_settings s where s.workspace_id = w.id) as settings,
            (select count(*)::int from fs_node n where n.workspace_id = w.id and n.path = '.chat/.names/general.json') as channels
       from workspace w where w.id = $1`,
    [workspaceId],
  );
  await counter.query('commit');
  counter.release();
  assert.deepEqual(physical.rows[0], {slug, members: 1, documents: 2, settings: 1, channels: 1});

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'pg.Pool runtime role is not the schema owner',
      'root is provisioned from ROOT_GITHUB_LOGIN at startup',
      'Better Auth GitHub sign-up persists through PostgreSQL',
      'workspace creation provisions membership, settings, and general channel',
      'invitation acceptance, role change, and member removal use Better Auth',
      'an editor writes through RLS and loses access after membership removal',
      'workspace document repository reads and writes through PostgreSQL',
      'settings, preferences, generic store, chat, roles, and asset repositories use PostgreSQL',
      'a forged workspace id is rejected before repository access',
    ],
  }, null, 2));
} finally {
  await stopServer();
  if (savedAllowlist) await migrationPool.query('update platform_policy set signup_allowlist = $1', [savedAllowlist]).catch(() => {});
  await migrationPool.query('delete from rate_limit_bucket where key like $1', [`%${clientIp}%`]).catch(() => {});
  if (workspaceId) await migrationPool.query('delete from workspace where id = $1', [workspaceId]).catch(() => {});
  if (workspaceId) await migrationPool.query('delete from object_deletion where workspace_id = $1', [workspaceId]).catch(() => {});
  const users = [userId, memberUserId, rootUserId].filter(Boolean);
  if (users.length) await migrationPool.query('delete from app_user where id = any($1::text[])', [users]).catch(() => {});
  await runtimePool.end();
  await migrationPool.end();
}
