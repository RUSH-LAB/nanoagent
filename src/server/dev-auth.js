/**
 * The root account, and passwordless sign-in for local development.
 *
 * Typing a password into your own laptop on every restart is friction with no
 * security value, so `npm start` signs you in automatically. The dangerous way
 * to build that is a branch that skips authentication; this is not that. Root
 * is an ordinary account: a real row in the user table, with a real password,
 * signing in through the ordinary endpoint. The only unusual part is that the
 * server knows the password and will perform that sign-in on request.
 *
 * Which makes the guards the important part of this file. Auto-login requires
 * all three:
 *
 *   1. DEV_AUTOLOGIN=true, which only `npm start` sets.
 *   2. NODE_ENV is not 'production', so a production build cannot opt in by
 *      setting one stray variable.
 *   3. The request arrives from the loopback interface. Even with the flag on,
 *      a machine reachable from the network will not hand a session to it.
 *
 * Root is also the first owner, which closes a real gap: with no owner, PUT
 * /api/users/:id/role answers 403 to everyone and the admin page can never
 * grant anyone anything.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {DATA_DIR} = require('./paths');
const {setRole, getRole} = require('./roles');
const {db} = require('./db');
const chat = require('./chat');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Whether the passwordless local sign-in is available at all. */
const DEV_AUTOLOGIN = process.env.DEV_AUTOLOGIN === 'true' && !IS_PRODUCTION;

const ROOT_USERNAME = process.env.ROOT_USERNAME || 'root';
// Captured at load like the rest of the configuration, rather than read on
// every call: a password that could change between provisioning the account
// and signing into it is a password that will eventually not match.
const ROOT_PASSWORD_ENV = process.env.ROOT_PASSWORD || null;
const ROOT_EMAIL = process.env.ROOT_EMAIL || 'root@mochi.local';
const ROOT_NAME = process.env.ROOT_NAME || 'Root';

/** The organization root starts in, and the one channel inside it. */
const ROOT_ORG_NAME = process.env.ROOT_ORG_NAME || 'Mochi';
const ROOT_ORG_SLUG = process.env.ROOT_ORG_SLUG || 'mochi';
const ROOT_CHANNEL = 'general';

/** Where the generated root password is kept, so you can also sign in by hand. */
const ROOT_PASSWORD_FILE = path.join(DATA_DIR, '.root-password');

/**
 * The root password: from the environment in a real deployment, otherwise
 * generated once and kept in var/, which git ignores.
 *
 * Persisted rather than regenerated per boot because the account already
 * exists after the first run: a new password each time would not match the
 * stored hash, and every later auto-login would fail. Memoized so a busy
 * dev-login path does not read the file per request, and so the value cannot
 * change under a single process.
 */
let cachedPassword = null;

function rootPassword() {
  if (cachedPassword) return cachedPassword;
  if (ROOT_PASSWORD_ENV) {
    cachedPassword = ROOT_PASSWORD_ENV;
    return cachedPassword;
  }
  try {
    cachedPassword = fs.readFileSync(ROOT_PASSWORD_FILE, 'utf-8').trim();
  } catch {
    cachedPassword = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(DATA_DIR, {recursive: true});
    fs.writeFileSync(ROOT_PASSWORD_FILE, cachedPassword, {mode: 0o600});
  }
  return cachedPassword;
}

/**
 * Make `userId` an owner, unless they already are. Returns whether anything
 * changed, which the startup banner reports.
 *
 * Writes to the user_role table, whose foreign key ties the role to a real
 * account. The previous JSON store had no such link, so recreating the database
 * left the old entry behind and /admin listed owners that did not exist.
 */
function grantOwner(userId) {
  if (getRole(userId) === 'owner') return false;
  return setRole(userId, 'owner');
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
 *
 * Returns a small report for the startup banner, or null when auto-login is
 * off, in which case nothing is created: a production database should not grow
 * a well-known account just because this module was imported.
 */
async function ensureRootUser(auth) {
  if (!DEV_AUTOLOGIN) return null;

  const password = rootPassword();
  let created = false;
  let userId;

  try {
    const result = await auth.api.signUpEmail({
      body: {email: ROOT_EMAIL, password, name: ROOT_NAME, username: ROOT_USERNAME},
    });
    userId = result.user.id;
    created = true;
  } catch (err) {
    // Already exists, which is the common case on every run after the first.
    // Sign in instead to learn the id; a failure here is a real problem worth
    // surfacing, usually a stale .root-password against an older database.
    try {
      const result = await auth.api.signInEmail({body: {email: ROOT_EMAIL, password}});
      userId = result.user.id;
    } catch {
      throw new Error(
        `Could not provision the root account: ${err.message}. ` +
        `If ${ROOT_PASSWORD_FILE} no longer matches the database, delete both ` +
        `it and var/data/mochi.db, or set ROOT_PASSWORD.`
      );
    }
  }

  const grantedOwner = grantOwner(userId);
  const workspace = await ensureRootWorkspace(auth, userId);
  return {
    userId, username: ROOT_USERNAME, email: ROOT_EMAIL, created, grantedOwner,
    workspace, passwordFile: ROOT_PASSWORD_FILE,
  };
}

/**
 * Whether the request came from this machine.
 *
 * IPv4-mapped IPv6 (::ffff:127.0.0.1) is what a dual-stack listener reports for
 * a v4 loopback connection, so it counts too. A proxied request is not trusted
 * here: x-forwarded-for is client-controlled, and honouring it would let a
 * remote caller claim to be local.
 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Sign in as root without a password, for local development only.
 *
 * Performs an ordinary email-and-password sign-in server-side using the
 * password this process already knows, so the session it returns is
 * indistinguishable from one obtained by typing that password into the form.
 * There is no separate session-minting path to get wrong.
 */
async function handleDevLogin(req, res, auth, json) {
  if (!DEV_AUTOLOGIN) {
    return json(res, 404, {error: 'Not found', path: '/api/dev-login'});
  }
  if (!isLoopback(req)) {
    return json(res, 403, {error: 'Development sign-in is available from localhost only'});
  }
  try {
    const result = await auth.api.signInEmail({
      body: {email: ROOT_EMAIL, password: rootPassword()},
    });
    return json(res, 200, {token: result.token, user: result.user});
  } catch (err) {
    return json(res, 500, {error: `Development sign-in failed: ${err.message}`});
  }
}

module.exports = {
  DEV_AUTOLOGIN,
  ROOT_USERNAME,
  ROOT_EMAIL,
  ROOT_NAME,
  ROOT_PASSWORD_FILE,
  ROOT_ORG_NAME,
  ROOT_ORG_SLUG,
  ROOT_CHANNEL,
  rootPassword,
  grantOwner,
  ensureRootWorkspace,
  ensureRootUser,
  isLoopback,
  handleDevLogin,
};
