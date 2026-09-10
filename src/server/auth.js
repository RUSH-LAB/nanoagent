/**
 * Server-side identity for the API.
 *
 * Every per-user endpoint used to take its caller's identity from the request
 * itself: `?userId=` on a GET, `body.userId` on a POST, `body.requesterId` on
 * the role change. That is not authentication. This module is the single place
 * that answers "who is calling?", and it answers from a session the server
 * issued and stores, which the client cannot forge.
 *
 * Accounts live in the selected database. Better Auth owns user, session,
 * account, verification, organization, membership, and invitation records in
 * both SQLite and PostgreSQL. PostgreSQL schema aliases expose the latter as
 * workspace, workspace_member, and workspace_invitation.
 * Sign-up and sign-in are mounted at /api/auth/* by server/index.js.
 *
 * Browser sessions travel in Better Auth's HttpOnly cookie. The development
 * site and API use different localhost ports but are the same site; credentialed
 * fetches and the explicit CORS policy carry the cookie without exposing it to
 * JavaScript.
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
const {organization} = require('better-auth/plugins/organization');
const postgres = require('./postgres/database');
const db = postgres.enabled ? null : require('./db').db;
const {DATA_DIR} = require('./paths');
const {sendMail} = require('./mail');
const {platformConfig} = require('../platform');
const {
  organizationOptions, workspaceAccessControl, workspaceRoles, postgresCoreSchema, authSessionOptions,
} = require('./workspace-auth');
const {createWorkspaceProvisioning} = require('./workspace-provisioning');

const AUTH_ENABLED = process.env.ENABLE_AUTH === 'true';
const PORT = process.env.EDITOR_PORT || process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim();
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim();
const {name: platformName} = platformConfig();

const workspaceProvisioning = createWorkspaceProvisioning({postgres, sqliteDb: db});

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
  if (env.ENABLE_AUTH !== 'true') {
    return 'Refusing to start: NODE_ENV is production but ENABLE_AUTH is not "true", '
      + 'so every request would resolve to the shared development identity and no '
      + 'sign-in would be required. Set ENABLE_AUTH=true.';
  }
  const resendConfigured = Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
  const webhookConfigured = Boolean(env.MAIL_WEBHOOK_URL);
  if ((env.RESEND_API_KEY || env.MAIL_FROM) && !resendConfigured) {
    return 'Refusing to start: RESEND_API_KEY and MAIL_FROM must be configured together.';
  }
  if (!resendConfigured && !webhookConfigured) {
    return 'Refusing to start: production authentication requires either '
      + 'RESEND_API_KEY with MAIL_FROM, or MAIL_WEBHOOK_URL, for account email.';
  }
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    return 'Refusing to start: production requires BETTER_AUTH_SECRET with at least 32 characters.';
  }
  if (!env.SITE_URL || !/^https:\/\//i.test(env.SITE_URL)) {
    return 'Refusing to start: production requires an HTTPS SITE_URL for same-origin session cookies.';
  }
  if (!env.DATABASE_URL) {
    return 'Refusing to start: production requires DATABASE_URL so authentication and business data use PostgreSQL.';
  }
  if (!env.DATABASE_MIGRATION_URL) {
    return 'Refusing to start: production requires DATABASE_MIGRATION_URL with a separate schema-owner role.';
  }
  return null;
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
async function firstOrganizationOf(userId) {
  if (postgres.enabled) {
    try {
      const {withRequestContext} = require('./postgres/client');
      return await withRequestContext(postgres.pool, {userId, workspaceId: null}, async client => {
        const row = (await client.query(
          'select workspace_id from workspace_member where user_id = $1 order by created_at, id limit 1', [userId],
        )).rows[0];
        return row?.workspace_id ?? null;
      });
    } catch {
      return null;
    }
  }
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
  // Better Auth recognizes pg.Pool directly and builds its own Kysely adapter.
  // Passing an already-created Kysely instance is not a supported input shape.
  database: postgres.enabled ? postgres.pool : db,
  ...(postgres.enabled ? postgresCoreSchema : {}),
  secret: resolveSecret(),
  baseURL: process.env.BETTER_AUTH_URL || process.env.SITE_URL || `http://localhost:${PORT}`,
  basePath: '/api/auth',
  // Verify the signed, HttpOnly session snapshot locally for ordinary API
  // requests instead of querying Neon just to identify the same browser on
  // every click. Workspace membership is deliberately not cached here: the
  // dispatcher still checks it for every scoped request, so removing a member
  // takes effect immediately. The short lifetime bounds session revocation.
  session: authSessionOptions({postgresEnabled: postgres.enabled}),
  // The Docusaurus dev server and the production site are separate origins from
  // this API, so both have to be named or Better Auth rejects their requests.
  trustedOrigins: [
    'http://localhost:3000',
    'http://localhost:3001',
    ...(process.env.SITE_URL ? [process.env.SITE_URL] : []),
  ],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: IS_PRODUCTION,
    minPasswordLength: 8,
    sendResetPassword: ({user, url}) => sendMail({
      to: user.email,
      template: 'password-reset',
      subject: `Reset your ${platformName} password`,
      url,
    }),
  },
  socialProviders: GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET ? {
    google: {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    },
  } : {},
  emailVerification: {
    sendOnSignUp: IS_PRODUCTION,
    autoSignInAfterVerification: true,
    sendVerificationEmail: ({user, url}) => sendMail({
      to: user.email,
      template: 'email-verification',
      subject: `Verify your ${platformName} email`,
      url,
    }),
  },
  // Every session opens in an organization when the account has one. Written
  // as the session row is created rather than patched afterwards, so there is
  // no window in which a signed-in caller has no active organization.
  databaseHooks: {
    session: {
      create: {
        async before(session) {
          const orgId = await firstOrganizationOf(session.userId);
          return orgId ? {data: {...session, activeOrganizationId: orgId}} : undefined;
        },
      },
    },
  },
  plugins: [
    // Better Auth is the sole organization/member/invitation lifecycle engine
    // in both SQLite and PostgreSQL. The PostgreSQL option aliases its logical
    // models onto Mochi's workspace-named control-plane tables.
    organization(organizationOptions({
      postgresEnabled: postgres.enabled,
      isProduction: IS_PRODUCTION,
      hooks: workspaceProvisioning.hooks,
      sendInvitationEmail: ({id, email, role, organization: invitedWorkspace}) => {
        const site = process.env.SITE_URL || `http://localhost:3000`;
        return sendMail({
          to: email,
          template: 'workspace-invitation',
          subject: `Invitation to join ${invitedWorkspace.name}`,
          url: `${site.replace(/\/$/, '')}/join?i=${encodeURIComponent(id)}`,
          data: {workspace: invitedWorkspace.name, role},
        });
      },
    })),
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
 * Endpoints reachable without a session. Health is public, and /api/auth/* is
 * where a caller goes to get a session. Workspace feeds live below an explicit
 * workspace URL and use the same membership boundary as other workspace data.
 */
const PUBLIC_PATHS = new Set([
  '/api/health',
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
  if (postgres.enabled) {
    try {
      const {withRequestContext} = require('./postgres/client');
      return withRequestContext(postgres.pool, {userId, workspaceId: orgId}, async client =>
        (await client.query(
          'select role from workspace_member where user_id = $1 and workspace_id = $2 limit 1', [userId, orgId],
        )).rows[0]?.role ?? null);
    } catch {
      return null;
    }
  }
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
  const orgId = session.session?.activeOrganizationId ?? await firstOrganizationOf(userId);
  return {
    ok: true,
    identity: Object.freeze({
      userId,
      orgId,
      orgRole: await orgRoleFor(userId, orgId),
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
  workspaceAccessControl,
  workspaceRoles,
};
