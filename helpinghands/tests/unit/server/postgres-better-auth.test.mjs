import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {Kysely, PGliteDialect} from 'kysely';
import {githubAccount} from './_github-account.mjs';
import {pgQuery} from './fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {betterAuth} = require('better-auth');
const {organization} = require('better-auth/plugins/organization');
const {deviceAuthorization} = require('better-auth/plugins/device-authorization');
const {
  organizationOptions, postgresCoreSchema, postgresDeviceCodeSchema, authSessionOptions,
} = require('../../../src/server/workspace-auth.js');
const {createWorkspaceProvisioning} = require('../../../src/server/workspace-provisioning.js');
const {createPostgresGithubUsers} = require('../../../src/server/postgres/github-users.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Better Auth on the PostgreSQL workspace schema', () => {
  let pg;
  let kysely;
  let auth;
  let owner;
  let workspace;

  before(async () => {
    pg = new PGlite();
    const migrationsDir = path.join(root, 'src/server/postgres/migrations');
    const migrations = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
    for (const name of migrations) await pg.exec(await readFile(path.join(migrationsDir, name), 'utf8'));
    kysely = new Kysely({dialect: new PGliteDialect({pglite: pg})});
    const pool = {
      async connect() {
        return {query: pgQuery(pg), release() {}};
      },
    };
    const provisioning = createWorkspaceProvisioning({postgres: {enabled: true, pool}});
    auth = betterAuth({
      database: {db: kysely, type: 'postgres'},
      ...postgresCoreSchema,
      session: authSessionOptions({postgresEnabled: true}),
      secret: 'postgres-better-auth-test-secret'.padEnd(48, 'x'),
      baseURL: 'http://localhost:3001',
      advanced: {database: {joins: true}},
      socialProviders: {github: {clientId: 'test-client', clientSecret: 'test-secret'}},
      plugins: [
        organization(organizationOptions({
          postgresEnabled: true,
          hooks: provisioning.hooks,
        })),
        deviceAuthorization({schema: postgresDeviceCodeSchema}),
      ],
    });
  });

  it('keeps the auth_session mapping when cookie caching is enabled', () => {
    const session = authSessionOptions({postgresEnabled: true});
    assert.equal(session.modelName, 'auth_session');
    assert.equal(session.fields.userId, 'user_id');
    assert.deepEqual(session.cookieCache, {enabled: true, maxAge: 60});
  });

  after(async () => {
    await kysely?.destroy();
  });

  it('finds a session and its user in the aliased tables with joins on', async () => {
    const eve = await githubAccount(auth, 'Eve', 'eve@postgres.invalid');
    const session = await auth.api.getSession({headers: {cookie: eve.cookie}, query: {disableCookieCache: true}});
    assert.equal(session.user.id, eve.id);
    assert.equal(session.session.userId, eve.id);
  });

  it('keeps GitHub accounts and device codes in the aliased tables', async () => {
    const dev = await githubAccount(auth, 'Dev', 'dev@postgres.invalid');
    assert.equal((await pg.query(
      "select count(*)::int as n from auth_account where user_id = $1 and provider_id = 'github'", [dev.id],
    )).rows[0].n, 1);
    const code = await auth.api.deviceCode({body: {client_id: 'mochi-cli'}});
    await auth.api.deviceVerify({query: {user_code: code.user_code}, headers: {cookie: dev.cookie}});
    await auth.api.deviceApprove({body: {userCode: code.user_code}, headers: {cookie: dev.cookie}});
    assert.deepEqual((await pg.query(
      'select user_id, status, client_id from auth_device_code where device_code = $1', [code.device_code],
    )).rows, [{user_id: dev.id, status: 'approved', client_id: 'mochi-cli'}]);
  });

  it('keeps GitHub usernames in app_user and finds accounts by them', async () => {
    const {internalAdapter} = await auth.$context;
    const user = await internalAdapter.createUser({
      name: 'Octo', email: 'octo@postgres.invalid', emailVerified: true, githubLogin: 'Octocat', githubBio: 'Cat',
    });
    const githubUsers = createPostgresGithubUsers({pool: {query: pgQuery(pg)}});
    assert.equal(await githubUsers.loginOf(user.id), 'Octocat');
    assert.deepEqual([...(await githubUsers.byLogins(['octocat', 'nobody'])).entries()], [
      ['octocat', {login: 'Octocat', name: 'Octo', image: null, bio: 'Cat'}],
    ]);
    await assert.rejects(internalAdapter.createUser({
      name: 'Other', email: 'other@postgres.invalid', emailVerified: true, githubLogin: 'OCTOCAT',
    }), 'one account per GitHub username');
    await githubUsers.release('octocat');
    assert.equal(await githubUsers.loginOf(user.id), null);
  });

  it('creates organizations and owner memberships in the aliased tables', async () => {
    owner = await githubAccount(auth, 'Ada', 'ada@postgres.invalid');
    workspace = await auth.api.createOrganization({
      body: {name: 'Research Lab', slug: 'research-lab', userId: owner.id},
    });

    assert.equal(workspace.slug, 'research-lab');
    assert.deepEqual((await pg.query(
      'select workspace_id, user_id, role from workspace_member where workspace_id = $1',
      [workspace.id],
    )).rows, [{workspace_id: workspace.id, user_id: owner.id, role: 'owner'}]);
    assert.equal((await pg.query(
      'select count(*)::int as n from workspace_settings where workspace_id = $1', [workspace.id],
    )).rows[0].n, 1);
    assert.equal((await pg.query(
      "select count(*)::int as n from channel where workspace_id = $1 and name = 'general'", [workspace.id],
    )).rows[0].n, 1);
  });

  it('uses Better Auth for invitation, role, and membership transitions', async () => {
    const invited = await githubAccount(auth, 'Grace', 'grace@postgres.invalid');
    const invitation = await auth.api.createInvitation({
      body: {email: 'grace@postgres.invalid', role: 'viewer', organizationId: workspace.id},
      headers: {cookie: owner.cookie},
    });
    const accepted = await auth.api.acceptInvitation({
      body: {invitationId: invitation.id},
      headers: {cookie: invited.cookie},
    });
    const general = (await pg.query(
      "select id from channel where workspace_id = $1 and name = 'general'", [workspace.id],
    )).rows[0];
    assert.equal((await pg.query(
      'select count(*)::int as n from channel_member where channel_id = $1 and user_id = $2',
      [general.id, invited.id],
    )).rows[0].n, 1);
    await auth.api.updateMemberRole({
      body: {memberId: accepted.member.id, role: 'editor', organizationId: workspace.id},
      headers: {cookie: owner.cookie},
    });
    assert.equal((await pg.query(
      'select role from workspace_member where id = $1', [accepted.member.id],
    )).rows[0].role, 'editor');

    await auth.api.removeMember({
      body: {memberIdOrEmail: accepted.member.id, organizationId: workspace.id},
      headers: {cookie: owner.cookie},
    });
    assert.equal((await pg.query(
      'select count(*)::int as n from workspace_member where id = $1', [accepted.member.id],
    )).rows[0].n, 0);
    assert.equal((await pg.query(
      'select count(*)::int as n from channel_member where channel_id = $1 and user_id = $2',
      [general.id, invited.id],
    )).rows[0].n, 0);
  });

  it('stores Better Auth\'s canceled invitation status', async () => {
    const invitation = await auth.api.createInvitation({
      body: {email: 'later@postgres.invalid', role: 'viewer', organizationId: workspace.id},
      headers: {cookie: owner.cookie},
    });
    await auth.api.cancelInvitation({
      body: {invitationId: invitation.id},
      headers: {cookie: owner.cookie},
    });
    assert.equal((await pg.query(
      'select status from workspace_invitation where id = $1', [invitation.id],
    )).rows[0].status, 'canceled');
  });
});
