/**
 * The root account, on SQLite.
 *
 * Root is the GitHub account named by ROOT_GITHUB_LOGIN (root-account.js),
 * provisioned at every start. It is also the first owner, which closes a real
 * gap: with no owner, PUT /api/users/:id/role answers 403 to everyone and the
 * admin page can never grant anyone anything.
 */
const {setRole, getRole} = require('./roles');
const {db} = require('./db');
const chat = require('./chat');
const {ensureRootAccount} = require('./root-account');

/** The organization root starts in, and the one channel inside it. */
const ROOT_ORG_NAME = process.env.ROOT_ORG_NAME || 'Mochi Lab';
const ROOT_ORG_SLUG = process.env.ROOT_ORG_SLUG || 'mochi';
const ROOT_CHANNEL = 'general';

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

module.exports = {
  ROOT_ORG_NAME,
  ROOT_ORG_SLUG,
  ROOT_CHANNEL,
  grantPlatformAdmin,
  ensureRootWorkspace,
  ensureRootUser,
};
