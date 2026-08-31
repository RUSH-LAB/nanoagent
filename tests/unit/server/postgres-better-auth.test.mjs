import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {Kysely, PGliteDialect} from 'kysely';

const require = createRequire(import.meta.url);
const {betterAuth} = require('better-auth');
const {organization} = require('better-auth/plugins/organization');
const {
  organizationOptions, postgresCoreSchema,
} = require('../../../src/server/workspace-auth.js');
const {createWorkspaceProvisioning} = require('../../../src/server/workspace-provisioning.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Better Auth on the PostgreSQL workspace schema', () => {
  let pg;
  let kysely;
  let auth;
  let owner;
  let workspace;

  const cookieFrom = result => result.headers.getSetCookie()[0].split(';')[0];

  before(async () => {
    pg = new PGlite();
    const migrationsDir = path.join(root, 'src/server/postgres/migrations');
    const migrations = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
    for (const name of migrations) await pg.exec(await readFile(path.join(migrationsDir, name), 'utf8'));
    kysely = new Kysely({dialect: new PGliteDialect({pglite: pg})});
    const pool = {
      async connect() {
        return {query: (...args) => pg.query(...args), release() {}};
      },
    };
    const provisioning = createWorkspaceProvisioning({postgres: {enabled: true, pool}});
    auth = betterAuth({
      database: {db: kysely, type: 'postgres'},
      ...postgresCoreSchema,
      secret: 'postgres-better-auth-test-secret'.padEnd(48, 'x'),
      baseURL: 'http://localhost:3001',
      emailAndPassword: {enabled: true},
      plugins: [organization(organizationOptions({
        postgresEnabled: true,
        hooks: provisioning.hooks,
      }))],
    });
  });

  after(async () => {
    await kysely?.destroy();
  });

  it('creates organizations and owner memberships in the aliased tables', async () => {
    const signup = await auth.api.signUpEmail({
      body: {name: 'Ada', email: 'ada@postgres.invalid', password: 'correcthorsebattery'},
      returnHeaders: true,
    });
    owner = {id: signup.response.user.id, cookie: cookieFrom(signup)};
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
    const invited = await auth.api.signUpEmail({
      body: {name: 'Grace', email: 'grace@postgres.invalid', password: 'correcthorsebattery'},
      returnHeaders: true,
    });
    const invitation = await auth.api.createInvitation({
      body: {email: 'grace@postgres.invalid', role: 'viewer', organizationId: workspace.id},
      headers: {cookie: owner.cookie},
    });
    const accepted = await auth.api.acceptInvitation({
      body: {invitationId: invitation.id},
      headers: {cookie: cookieFrom(invited)},
    });
    const general = (await pg.query(
      "select id from channel where workspace_id = $1 and name = 'general'", [workspace.id],
    )).rows[0];
    assert.equal((await pg.query(
      'select count(*)::int as n from channel_member where channel_id = $1 and user_id = $2',
      [general.id, invited.response.user.id],
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
      [general.id, invited.response.user.id],
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
