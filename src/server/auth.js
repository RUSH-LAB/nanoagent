/**
 * Server-side identity for the API.
 *
 * Every per-user endpoint used to take its caller's identity from the request
 * itself: `?userId=` on a GET, `body.userId` on a POST, `body.requesterId` on
 * the role change. That is not authentication. This module is the single place
 * that answers "who is calling?", and it answers from a session the server
 * issued and stores, which the client cannot forge.
 *
 * Accounts live in the local SQL database (see db.js). Better Auth owns the
 * user, session, account, and verification tables, plus the organization,
 * member, and invitation tables its organization plugin adds. Sign-up and
 * sign-in are its own routes, mounted at /api/auth/* by server/index.js.
 *
 * Sessions travel as bearer tokens rather than cookies. In development the site
 * is served from :3000 and this API from :3001, and a browser will not send a
 * cookie across origins without HTTPS and SameSite=None. A token in an
 * Authorization header has no such problem, and it is what src/utils/api.js
 * already sends.
 *
 * Two modes, selected by ENABLE_AUTH:
 *
 *   ENABLE_AUTH=true   Real sessions. Every non-public request must carry a
 *                      valid one; anything else is a 401 before any handler
 *                      runs. This is what `npm start` uses.
 *   anything else      Every request resolves to DEV_IDENTITY. This is what the
 *                      test suites use, so they need no login step.
 *
 * The trust boundary is identical either way: handlers read identity only from
 * `req.auth`. ENABLE_AUTH changes who the server believes you are, never
 * whether the client gets to decide.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {betterAuth} = require('better-auth');
const {fromNodeHeaders} = require('better-auth/node');
const {bearer} = require('better-auth/plugins/bearer');
const {username} = require('better-auth/plugins/username');
const {organization} = require('better-auth/plugins/organization');
const {db} = require('./db');
const {DATA_DIR} = require('./paths');

const AUTH_ENABLED = process.env.ENABLE_AUTH === 'true';
const PORT = process.env.EDITOR_PORT || 3001;

/**
 * The key that signs sessions. Set BETTER_AUTH_SECRET in any real deployment.
 * Locally it is generated once and kept in var/, which git ignores: a secret
 * that changed per restart would invalidate every session on every code reload,
 * and a secret committed to the repo would be no secret at all.
 */
function resolveSecret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  const file = path.join(DATA_DIR, '.auth-secret');
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DATA_DIR, {recursive: true});
    fs.writeFileSync(file, generated, {mode: 0o600});
    return generated;
  }
}

/**
 * The Better Auth instance. server/index.js mounts `auth.handler` so the
 * sign-up, sign-in, sign-out, and organization routes exist; this module calls
 * `auth.api.getSession` to identify everyone else.
 */
const auth = betterAuth({
  database: db,
  secret: resolveSecret(),
  baseURL: process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`,
  basePath: '/api/auth',
  // The Docusaurus dev server and the production site are separate origins from
  // this API, so both have to be named or Better Auth rejects their requests.
  trustedOrigins: [
    'http://localhost:3000',
    'http://localhost:3001',
    ...(process.env.SITE_URL ? [process.env.SITE_URL] : []),
  ],
  emailAndPassword: {
    enabled: true,
    // No mail server is configured, so requiring verification would lock every
    // new local account out of the app it just signed up for.
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  plugins: [
    // Lets people sign in with a username as well as an email address.
    username(),
    // Organizations, memberships, roles, and invitations.
    organization(),
    // Issues the session as a token in a `set-auth-token` response header and
    // accepts it back as `Authorization: Bearer`, so no cross-origin cookie is
    // needed between :3000 and :3001.
    bearer(),
  ],
});

/**
 * The identity every request carries when ENABLE_AUTH is off. A stable id keeps
 * the JSON stores keyed consistently across restarts.
 */
const DEV_IDENTITY = Object.freeze({
  userId: 'dev-user',
  orgId: null,
  orgRole: null,
  sessionId: null,
});

/**
 * Endpoints reachable without a session. Health and the feeds because their
 * callers cannot hold one; /api/auth/* because that is where a caller goes to
 * get one, and gating sign-in behind sign-in would lock everybody out.
 */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/feed/rss',
  '/api/feed/atom',
]);

/** Whether `pathname` may be served without a session. */
function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/api/auth/');
}

/**
 * Identities key the JSON stores, so an id naming a prototype slot would write
 * through to Object.prototype. Better Auth ids are generated, so this can only
 * fire on a tampered database, but the check lives here to hold for every store
 * at once rather than at each of the twenty-odd handlers that key on one.
 */
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !UNSAFE_IDS.has(id);
}

/**
 * The caller's role in their active organization, or null when they have not
 * selected one. Better Auth keeps the active organization on the session and
 * the role on the membership, so the role needs this one indexed lookup.
 */
function orgRoleFor(userId, orgId) {
  if (!orgId) return null;
  try {
    const row = db
      .prepare('SELECT role FROM member WHERE userId = ? AND organizationId = ? LIMIT 1')
      .get(userId, orgId);
    return row?.role ?? null;
  } catch {
    // The organization tables may not exist yet on a database created before
    // the plugin was added. A missing role is not a reason to reject the
    // request; it just means no organization permissions.
    return null;
  }
}

/**
 * Resolve the caller. Never throws and never returns a partial identity:
 * either `{ok: true, identity}` with a verified user, or `{ok: false, status,
 * error}` describing the rejection to send back verbatim.
 */
async function resolveIdentity(req) {
  if (!AUTH_ENABLED) return {ok: true, identity: DEV_IDENTITY};

  let session;
  try {
    session = await auth.api.getSession({headers: fromNodeHeaders(req.headers)});
  } catch {
    return {ok: false, status: 401, error: 'Invalid or expired session'};
  }
  if (!session?.user?.id) {
    return {ok: false, status: 401, error: 'Not signed in'};
  }

  const userId = session.user.id;
  if (!isSafeId(userId)) {
    return {ok: false, status: 401, error: 'Invalid session subject'};
  }

  const orgId = session.session?.activeOrganizationId ?? null;
  return {
    ok: true,
    identity: Object.freeze({
      userId,
      orgId,
      orgRole: orgRoleFor(userId, orgId),
      sessionId: session.session?.id ?? null,
    }),
  };
}

module.exports = {
  auth,
  resolveIdentity,
  isPublicPath,
  isSafeId,
  orgRoleFor,
  AUTH_ENABLED,
  DEV_IDENTITY,
  PUBLIC_PATHS,
};
