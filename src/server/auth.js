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
 * Why a production server may not start, or null when it may.
 *
 * The two modes below are a development convenience that becomes a hole the
 * moment the process is reachable by anyone else. With ENABLE_AUTH off,
 * resolveIdentity hands every caller DEV_IDENTITY without looking at the
 * request: not a weak session, no session, and the same one for everybody. The
 * failure is silent, because a server in that state serves every page
 * correctly to whoever asks.
 *
 * So it is refused rather than warned about. The check is deliberately narrow:
 * it fires only when NODE_ENV says production, which is the one context where
 * the answer is never "the author is running the tests". Everything else about
 * how the server is deployed is somebody else's judgement.
 *
 * Pure, and takes the environment as an argument, so the refusal is testable
 * without spawning a process and setting real variables.
 */
function productionAuthError(env = process.env) {
  if (env.NODE_ENV !== 'production') return null;
  if (env.ENABLE_AUTH === 'true') return null;
  return 'Refusing to start: NODE_ENV is production but ENABLE_AUTH is not "true", '
    + 'so every request would resolve to the shared development identity and no '
    + 'sign-in would be required. Set ENABLE_AUTH=true, or unset NODE_ENV to run '
    + 'this as a development server.';
}

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
 * The organization a new session starts in: the caller's oldest membership, or
 * null when they belong to none.
 *
 * Better Auth leaves `activeOrganizationId` unset until something calls
 * set-active, and everything under /api/chat needs one, so a fresh sign-in
 * would otherwise land in a workspace of nothing until the client thought to
 * choose. Nobody signing in has expressed a preference yet; their first
 * organization is the least surprising stand-in, and switching is one call.
 *
 * The tie is broken by rowid, which is the order the rows were written, and not
 * by the member id, which is a random string. Two memberships created in the
 * same millisecond compare equal on `createdAt`, and joining two workspaces in
 * one operation does exactly that: provisioning a machine made root's own
 * workspace and a second one within the same tick, and which of the two a fresh
 * session opened in came down to which random id sorted lower. Same tie, and
 * the same fix, as the audit log in ./audit.
 */
function firstOrganizationOf(userId) {
  try {
    const row = db
      .prepare('SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt, rowid LIMIT 1')
      .get(userId);
    return row?.organizationId ?? null;
  } catch {
    // Same reason as orgRoleFor: on a database predating the plugin the tables
    // are missing, which means no organization, not a failed sign-in.
    return null;
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
  // Every session opens in an organization when the account has one. Written
  // as the session row is created rather than patched afterwards, so there is
  // no window in which a signed-in caller has no active organization.
  databaseHooks: {
    session: {
      create: {
        before(session) {
          const orgId = firstOrganizationOf(session.userId);
          return orgId ? {data: {...session, activeOrganizationId: orgId}} : undefined;
        },
      },
    },
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

/**
 * Endpoints whose path carries an unguessable id, reachable without a session
 * for the same reason as the ones above: their caller cannot hold one yet.
 *
 * Reading an invitation is the only member. Someone following an invitation
 * link has no account, and cannot make one with the right address until they
 * are told which address was invited. The pattern is deliberately exact rather
 * than a prefix, so that accepting the invitation, at
 * /api/invite/:id/accept, still requires the session whose address that is.
 */
const PUBLIC_PATTERNS = [/^\/api\/invite\/[^/]+$/];

/** Whether `pathname` may be served without a session. */
function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname)
    || pathname.startsWith('/api/auth/')
    || PUBLIC_PATTERNS.some(pattern => pattern.test(pathname));
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

  // The session's choice if it has made one, and otherwise the account's first
  // organization. The create hook writes that choice for every new session, but
  // sessions issued before an account had an organization are still out there
  // holding a null, and they would each be one silent 409 from every chat
  // endpoint until their owner happened to sign out and back in.
  const orgId = session.session?.activeOrganizationId ?? firstOrganizationOf(userId);
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
  productionAuthError,
  isPublicPath,
  isSafeId,
  orgRoleFor,
  AUTH_ENABLED,
  DEV_IDENTITY,
  PUBLIC_PATHS,
  PUBLIC_PATTERNS,
};
