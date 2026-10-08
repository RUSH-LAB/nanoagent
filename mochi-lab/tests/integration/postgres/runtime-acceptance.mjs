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
let server;
let userId;
let memberUserId;
let workspaceId;
let logs = '';

function request(path, {method = 'GET', cookie, body} = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
      ...(cookie ? {cookie} : {}),
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

function sessionCookie(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const pair = values.map(value => value.split(';', 1)[0]).find(value => value.startsWith('better-auth.session_token='));
  assert.ok(pair, 'sign-up response set a Better Auth session cookie');
  return pair;
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

try {
  await migrate(migrationPool);
  await grantRuntimeAccess(migrationPool, runtimePool);
  await assertRuntimeRoleIsNotOwner(runtimePool);

  server = spawn(process.execPath, ['src/server/index.js'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ENABLE_AUTH: 'true',
      DEV_AUTOLOGIN: 'false',
      EDITOR_PORT: String(port),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: `postgres-smoke-${token}`.padEnd(48, 'x'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { logs += chunk; process.stdout.write(chunk); });
  server.stderr.on('data', chunk => { logs += chunk; process.stderr.write(chunk); });
  await waitForServer();

  const signUpResponse = await request('/api/auth/sign-up/email', {
    method: 'POST',
    body: {name: 'PostgreSQL Smoke', email, password: `Smoke-${token}!`},
  });
  const signedUp = await json(signUpResponse, 200);
  const cookie = sessionCookie(signUpResponse);
  userId = signedUp.user.id;

  const memberSignUpResponse = await request('/api/auth/sign-up/email', {
    method: 'POST',
    body: {name: 'PostgreSQL Member', email: memberEmail, password: `Member-${token}!`},
  });
  const memberSignedUp = await json(memberSignUpResponse, 200);
  const memberCookie = sessionCookie(memberSignUpResponse);
  memberUserId = memberSignedUp.user.id;

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

  const physical = await migrationPool.query(
    `select w.slug,
            (select count(*)::int from workspace_member m where m.workspace_id = w.id) as members,
            (select count(*)::int from document d where d.workspace_id = w.id) as documents,
            (select count(*)::int from workspace_settings s where s.workspace_id = w.id) as settings,
            (select count(*)::int from channel c where c.workspace_id = w.id and c.name = 'general') as channels
       from workspace w where w.id = $1`,
    [workspaceId],
  );
  assert.deepEqual(physical.rows[0], {slug, members: 1, documents: 2, settings: 1, channels: 1});

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'pg.Pool runtime role is not the schema owner',
      'Better Auth sign-up persists through PostgreSQL',
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
  if (workspaceId) await migrationPool.query('delete from workspace where id = $1', [workspaceId]).catch(() => {});
  if (workspaceId) await migrationPool.query('delete from object_deletion where workspace_id = $1', [workspaceId]).catch(() => {});
  const users = [userId, memberUserId].filter(Boolean);
  if (users.length) await migrationPool.query('delete from app_user where id = any($1::text[])', [users]).catch(() => {});
  await runtimePool.end();
  await migrationPool.end();
}
