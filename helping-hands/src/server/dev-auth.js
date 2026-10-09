/**
 * The root account and the development workspace, on SQLite.
 *
 * Root is the GitHub account named by ROOT_GITHUB_LOGIN (root-account.js),
 * provisioned at every start with authentication on. It is also the first
 * owner, which closes a real gap: with no owner, PUT /api/users/:id/role
 * answers 403 to everyone and the admin page can never grant anyone anything.
 */
const crypto = require('crypto');
const {setRole, getRole} = require('./roles');
const {db} = require('./db');
const chat = require('./chat');
const {ensureRootAccount} = require('./root-account');

/** The organization root starts in, and the one channel inside it. */
const ROOT_ORG_NAME = process.env.ROOT_ORG_NAME || 'Mochi Lab';
const ROOT_ORG_SLUG = process.env.ROOT_ORG_SLUG || 'mochi';
const ROOT_CHANNEL = 'general';

const DEV_USER_ID = 'dev-user';
const DEV_USER_EMAIL = 'dev-user@mochi.local';

/**
 * Make `userId` a platform administrator, unless they already are. Returns whether anything
 * changed, which the startup banner reports.
 *
 * Writes to platform_admin, whose foreign key ties the role to a real
 * account. The previous JSON store had no such link, so recreating the database
 * left the old entry behind and /admin listed owners that did not exist.
 */
function grantPlatformAdmin(userId) {
  if (getRole(userId) === 'admin') return false;
  return setRole(userId, 'admin');
}

/**
 * Give root somewhere to talk: an organization, with a #general inside it.
 *
 * Chat is scoped to an organization and Better Auth creates none, so on a fresh
 * database every /api/chat endpoint answers 409 and the CLI's sidebar has
 * nothing to click. This makes the same two calls the interface would, once, at
 * startup, so the first run opens on a workspace rather than on an explanation
 * of how to create one.
 *
 * It stops the moment root belongs to an organization already. This provisions a
 * starting point; it does not keep reimposing one on a database that has since
 * been arranged some other way.
 *
 * Returns what happened, for the startup banner: nothing to do, a workspace
 * root can now use, or the reason there is none.
 */
async function ensureRootWorkspace(auth, userId) {
  const existing = db
    .prepare('SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt, id LIMIT 1')
    .get(userId);
  if (existing) return {orgId: existing.organizationId, created: false};

  // An organization outlives the account that opened it, so a database whose
  // root was deleted and remade still has one under this slug, holding everyone
  // else's messages. Rejoin that one rather than failing on the unique slug and
  // leaving root locked out of the workspace it started.
  let organization = db.prepare('SELECT id, name FROM organization WHERE slug = ?').get(ROOT_ORG_SLUG);
  try {
    if (organization) {
      await auth.api.addMember({body: {userId, organizationId: organization.id, role: 'owner'}});
    } else {
      // No session and a `userId` in the body is Better Auth's server-side form
      // of this call; it creates the organization and root's owner membership.
      organization = await auth.api.createOrganization({
        body: {name: ROOT_ORG_NAME, slug: ROOT_ORG_SLUG, userId},
      });
    }
  } catch (err) {
    // Root can still sign in and work; it just has no workspace until someone
    // makes one by hand.
    return {error: err.message};
  }
  if (!organization?.id) return {error: 'the organization was not created'};

  const channel = db
    .prepare('SELECT name FROM channel WHERE organizationId = ? AND name = ?')
    .get(organization.id, ROOT_CHANNEL);
  if (!channel) {
    const {error} = chat.createChannel(organization.id, userId, {
      name: ROOT_CHANNEL,
      topic: 'Everything, to start with',
    });
    if (error) return {orgId: organization.id, name: organization.name, created: true, error};
  }
  return {orgId: organization.id, name: organization.name, channel: ROOT_CHANNEL, created: true};
}

/**
 * Create the root account if it does not exist, and make sure it is an owner.
 * Returns a small report for the startup banner.
 */
async function ensureRootUser(auth, options) {
  const {userId, login, created} = await ensureRootAccount(auth, options);
  const grantedPlatformAdmin = grantPlatformAdmin(userId);
  const workspace = await ensureRootWorkspace(auth, userId);
  return {userId, login, created, grantedPlatformAdmin, workspace};
}

/**
 * Provision the fixed identity used when authentication is disabled.
 *
 * The no-auth mode is only for local development and integration tests, but it
 * still goes through the real workspace resolver. Giving that identity an
 * ordinary owner membership keeps the request boundary identical to
 * production instead of adding a membership bypass that could drift into a
 * deployed configuration.
 */
function ensureDevelopmentWorkspace() {
  const at = new Date().toISOString();
  let workspace;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO "user"
         (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(DEV_USER_ID, 'Development User', DEV_USER_EMAIL, at, at);

    workspace = db.prepare(
      `SELECT id, name, slug FROM organization
        WHERE status = 'active'
        ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END, createdAt, rowid
        LIMIT 1`,
    ).get(ROOT_ORG_SLUG);

    if (!workspace) {
      let slug = ROOT_ORG_SLUG;
      if (db.prepare('SELECT 1 FROM organization WHERE slug = ?').get(slug)) slug = `${ROOT_ORG_SLUG}-dev`;
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO organization (id, name, slug, createdAt, status, createdBy)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      ).run(id, ROOT_ORG_NAME, slug, at, DEV_USER_ID);
      workspace = {id, name: ROOT_ORG_NAME, slug};
    }

    const membership = db.prepare(
      'SELECT id FROM member WHERE organizationId = ? AND userId = ?',
    ).get(workspace.id, DEV_USER_ID);
    if (!membership) {
      db.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'owner', ?)`,
      ).run(crypto.randomUUID(), workspace.id, DEV_USER_ID, at);
    }
    db.prepare(
      `INSERT OR IGNORE INTO workspace_settings (organizationId, value, updatedAt)
       VALUES (?, '{}', ?)`,
    ).run(workspace.id, at);
  })();

  const channel = db.prepare(
    'SELECT id FROM channel WHERE organizationId = ? AND name = ?',
  ).get(workspace.id, ROOT_CHANNEL);
  if (!channel) chat.createChannel(workspace.id, DEV_USER_ID, {name: ROOT_CHANNEL});
  return workspace;
}

module.exports = {
  ROOT_ORG_NAME,
  ROOT_ORG_SLUG,
  ROOT_CHANNEL,
  grantPlatformAdmin,
  ensureRootWorkspace,
  ensureRootUser,
  ensureDevelopmentWorkspace,
};
