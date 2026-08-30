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
 * Root is also the owner in the app's role store, which closes a real gap:
 * var/data/users.json starts empty, nobody is an owner, and PUT
 * /api/users/:id/role answers 403 to everyone, so the admin page could never
 * grant anyone anything. Seeding root as owner gives that endpoint a first
 * owner to act.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {DATA_DIR, dataFile} = require('./paths');
const {loadJSON, saveJSON} = require('./data-store');

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
 * Record `userId` as an owner in the app's role store, if not already known.
 * `usersFile` is a parameter so tests can point at a scratch file instead of
 * writing through to the repo's own store.
 */
function grantOwner(userId, email, name, usersFile = dataFile('users')) {
  const users = loadJSON(usersFile);
  if (Object.hasOwn(users, userId) && users[userId].role === 'owner') return false;
  users[userId] = {
    role: 'owner',
    email: users[userId]?.email || email,
    name: users[userId]?.name || name,
    addedAt: users[userId]?.addedAt || new Date().toISOString(),
  };
  saveJSON(usersFile, users);
  return true;
}

/**
 * Create the root account if it does not exist, and make sure it is an owner.
 *
 * `usersFile` names the role store, as a parameter so a test can point at a
 * scratch file rather than granting ownership in the real one.
 *
 * Returns a small report for the startup banner, or null when auto-login is
 * off, in which case nothing is created: a production database should not grow
 * a well-known account just because this module was imported.
 */
async function ensureRootUser(auth, usersFile = dataFile('users')) {
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

  const grantedOwner = grantOwner(userId, ROOT_EMAIL, ROOT_NAME, usersFile);
  return {userId, username: ROOT_USERNAME, email: ROOT_EMAIL, created, grantedOwner, passwordFile: ROOT_PASSWORD_FILE};
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
  rootPassword,
  grantOwner,
  ensureRootUser,
  isLoopback,
  handleDevLogin,
};
