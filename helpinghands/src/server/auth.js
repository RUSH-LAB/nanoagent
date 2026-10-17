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
 * GitHub is the only way in. A browser signs in through GitHub's OAuth flow;
 * the command-line client gets its session through the device-authorization
 * grant, which a browser already signed in with GitHub approves.
 *
 * Browser sessions travel in Better Auth's HttpOnly cookie. The development
 * site and API use different localhost ports but are the same site; credentialed
 * fetches and the explicit CORS policy carry the cookie without exposing it to
 * JavaScript.
 *
 * Every non-public request must carry a valid session; anything else is a 401
 * before any handler runs. Handlers read identity only from `req.auth`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {betterAuth} = require('better-auth');
const {fromNodeHeaders} = require('better-auth/node');
const {APIError} = require('better-auth/api');
const {organization} = require('better-auth/plugins/organization');
const {bearer} = require('better-auth/plugins/bearer');
const {deviceAuthorization} = require('better-auth/plugins/device-authorization');
const postgres = require('./postgres/database');
const {createPostgresTenancy} = require('./postgres/tenancy');
const db = postgres.enabled ? null : require('./db').db;
const {DATA_DIR} = require('./paths');
const {sendMail} = require('./mail');
const {
  organizationOptions, workspaceAccessControl, workspaceRoles, githubUserFields, githubProfileFields,
  postgresCoreSchema, postgresDeviceCodeSchema, authSessionOptions,
} = require('./workspace-auth');
const {createGithubUsers} = require('./github-users');
const {createPostgresGithubUsers} = require('./postgres/github-users');
const {createWorkspaceProvisioning} = require('./workspace-provisioning');

const PORT = process.env.EDITOR_PORT || process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID?.trim();
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET?.trim();
if (!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET)) {
  throw new Error('Mochi requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET: GitHub is the only way to sign in.');
}
const SITE_URL = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
// The clients allowed to ask for a device code: the sync client (cli/rush.mjs)
// and Mochi Lab's relay (runner/relay.mjs).
const DEVICE_CLIENT_IDS = new Set(['mochi-cli', 'mochi-desktop']);
// The marketplace plugins every new account starts with installed.
const PREINSTALLED_PLUGINS = require('js-yaml').load(fs.readFileSync(path.join(__dirname, 'preinstalled-plugins.yaml'), 'utf8')).plugins;

// Sign-up policy, workspace limits, suspension, and the rate-limit
// store shared by every server process (postgres/tenancy.js).
const tenancy = postgres.enabled ? createPostgresTenancy({pool: postgres.pool}) : null;

// Accounts by GitHub username, which blog posts name their authors by.
const githubUsers = postgres.enabled ? createPostgresGithubUsers({pool: postgres.pool}) : createGithubUsers({db});

/**
 * Before a user row takes a GitHub username, take it from whichever account
 * held it: GitHub gave a renamed account's old name to whoever signs in with it now.
 */
async function claimGithubLogin(user) {
  if (user.githubLogin) await githubUsers.release(user.githubLogin);
}

// Channels are files when the workspace file system serves content; required
// when first needed, because the services module requires this one.
const workspaceProvisioning = createWorkspaceProvisioning({
  postgres, sqliteDb: db,
  fsChat: () => (postgres.enabled ? require('./postgres/services').fsChat : null),
});

/**
 * Why a production server may not start, or null when it may.
 *
 * A misconfigured production server is refused rather than warned about. The
 * check is deliberately narrow: it fires only when NODE_ENV says production.
 * Everything else about how the server is deployed is somebody else's
 * judgement.
 *
 * Pure, and takes the environment as an argument, so the refusal is testable
 * without spawning a process and setting real variables.
 */
function productionAuthError(env = process.env) {
  if (env.NODE_ENV !== 'production') return null;
  if (!env.GITHUB_CLIENT_ID?.trim() || !env.GITHUB_CLIENT_SECRET?.trim()) {
    return 'Refusing to start: production requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, the only way to sign in.';
  }
  if (!env.ROOT_GITHUB_LOGIN?.trim()) {
    return 'Refusing to start: production requires ROOT_GITHUB_LOGIN, the GitHub account that administers the platform.';
  }
  const resendConfigured = Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
  const webhookConfigured = Boolean(env.MAIL_WEBHOOK_URL);
  if ((env.RESEND_API_KEY || env.MAIL_FROM) && !resendConfigured) {
    return 'Refusing to start: RESEND_API_KEY and MAIL_FROM must be configured together.';
  }
  if (!resendConfigured && !webhookConfigured) {
    return 'Refusing to start: production authentication requires either '
      + 'RESEND_API_KEY with MAIL_FROM, or MAIL_WEBHOOK_URL, for invitation email.';
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
// Also signs RUSH Lab's connect links (lab-tokens.js).
const AUTH_SECRET = resolveSecret();

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
    // On a database predating the organization plugin the tables
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
  ...(postgres.enabled ? postgresCoreSchema : {user: {additionalFields: githubUserFields}}),
  // An account is what GitHub says it is: every sign-in copies the name,
  // picture, username and bio, so nothing may edit them in between.
  disabledPaths: ['/update-user'],
  ...(tenancy ? {
    user: {
      ...postgresCoreSchema.user,
      // Self-service deletion, behind a fresh session. An account that is the only
      // owner of a workspace others use is refused; its solo workspaces go first.
      deleteUser: {
        enabled: true,
        beforeDelete: async user => {
          try {
            await tenancy.prepareAccountDeletion(user.id, user.id);
          } catch (error) {
            if (error.name === 'TenancyError') throw new APIError('CONFLICT', {message: error.message, code: error.code});
            throw error;
          }
        },
      },
    },
    // Shared by every server process and kept across restarts.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: {consume: tenancy.consume},
      customRules: {
        '/sign-in/social': {window: 60, max: 10},
        '/device/code': {window: 3600, max: 10},
        '/delete-user': {window: 3600, max: 5},
      },
    },
  } : {}),
  // Behind Cloudflare and Railway the socket address is the proxy's. Cloudflare
  // sets cf-connecting-ip; Railway sets x-real-ip for its own domain.
  // A session and its user come in one query when the cookie cache misses.
  advanced: {ipAddress: {ipAddressHeaders: ['cf-connecting-ip', 'x-real-ip']}, database: {joins: true}},
  secret: AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || process.env.SITE_URL || `http://localhost:${PORT}`,
  basePath: '/api/auth',
  // Verify the signed, HttpOnly session snapshot locally for ordinary API
  // requests instead of querying Neon just to identify the same browser on
  // every click; resolveIdentity hands back the refreshed snapshot. Workspace membership is deliberately not cached here: the
  // dispatcher still checks it for every scoped request, so removing a member
  // takes effect immediately. The short lifetime bounds session revocation.
  session: authSessionOptions({postgresEnabled: postgres.enabled}),
  // Browsers reach this API through the site's origin: the development site
  // proxies /api here (docusaurus.config.js), so that origin has to be named
  // or Better Auth rejects its requests.
  trustedOrigins: [
    `http://localhost:${process.env.SITE_PORT || 3000}`,
    ...(process.env.SITE_URL ? [process.env.SITE_URL] : []),
  ],
  socialProviders: {
    // Every sign-in copies the GitHub account's name, picture, primary email,
    // username and bio onto the user, so what Mochi shows is what GitHub says now.
    github: {
      clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET, overrideUserInfoOnSignIn: true,
      mapProfileToUser: githubProfileFields,
    },
  },
  // Every session opens in an organization when the account has one. Written
  // as the session row is created rather than patched afterwards, so there is
  // no window in which a signed-in caller has no active organization.
  databaseHooks: {
    // An account's address is the GitHub account's primary email, and
    // invitations and the sign-up policy trust it, so GitHub must have verified
    // it. Then the sign-up policy (open, invitation, or allowlist) decides who
    // may make an account over HTTP. Accounts the server provisions itself,
    // such as the root account, are created without a request and are not
    // subject to it.
    user: {
      create: {
        async before(user, context) {
          if (!user.emailVerified) {
            throw new APIError('FORBIDDEN', {message: 'Verify your primary email address on GitHub, then sign in again.', code: 'email-unverified'});
          }
          if (tenancy && context?.request) {
            const decision = await tenancy.signupDecision(user.email, user.githubLogin);
            if (!decision.allowed) throw new APIError('FORBIDDEN', {message: decision.message, code: 'signup-closed'});
          }
          await claimGithubLogin(user);
        },
        // A new account starts with the plugins preinstalled-plugins.yaml names installed.
        async after(user) {
          if (!postgres.enabled) return;
          const installed = await require('./postgres/services').userPlugins.preinstall(user.id, PREINSTALLED_PLUGINS);
          const missing = PREINSTALLED_PLUGINS.filter(id => !installed.includes(id));
          if (missing.length) console.error(`[plugins] Not in the marketplace, so not installed for ${user.id}: ${missing.join(', ')}`);
        },
      },
      update: {
        before: claimGithubLogin,
      },
    },
    session: {
      create: {
        async before(session) {
          // A suspended account gets no new session; suspending it deleted the old ones.
          if (tenancy && await tenancy.suspension(session.userId)) {
            throw new APIError('FORBIDDEN', {message: 'This account is suspended. Contact the site administrator.', code: 'account-suspended'});
          }
          const orgId = await firstOrganizationOf(session.userId);
          return orgId ? {data: {...session, activeOrganizationId: orgId}} : undefined;
        },
      },
    },
  },
  plugins: [
    // The command-line sync client has no cookie jar. It asks for a device
    // code, its user approves the code on SITE_URL/device in a browser signed
    // in with GitHub, and the client receives a session token that it sends as
    // `Authorization: Bearer`.
    bearer(),
    deviceAuthorization({
      verificationUri: `${SITE_URL}/device`,
      validateClient: clientId => DEVICE_CLIENT_IDS.has(clientId),
      ...(postgres.enabled ? {schema: postgresDeviceCodeSchema} : {}),
    }),
    // Better Auth is the organization and member lifecycle engine, and the
    // email invitation one, in both SQLite and PostgreSQL; invitations to a
    // GitHub account are org.js's own, accepted through Better Auth's
    // addMember. The PostgreSQL option aliases its logical models onto Mochi's
    // workspace-named control-plane tables.
    organization(organizationOptions({
      postgresEnabled: postgres.enabled,
      isProduction: IS_PRODUCTION,
      tenancy,
      hooks: workspaceProvisioning.hooks,
      sendInvitationEmail: ({id, email, role, organization: invitedWorkspace}) => {
        return sendMail({
          to: email,
          template: 'workspace-invitation',
          subject: `Invitation to join ${invitedWorkspace.name}`,
          url: `${SITE_URL}/join?i=${encodeURIComponent(id)}`,
          data: {workspace: invitedWorkspace.name, role},
        });
      },
    })),
  ],
});

/**
 * Endpoints reachable without a session. Health is public, and /api/auth/* is
 * where a caller goes to get a session. Workspace feeds live below an explicit
 * workspace URL and use the same membership boundary as other workspace data.
 */
const PUBLIC_PATHS = new Set([
  '/api/health',
  // Whether the sign-in screen offers sign-up.
  '/api/signup-policy',
]);

/**
 * Endpoints matched by shape, reachable without a session because their caller
 * cannot hold one.
 *
 * Reading an invitation: someone following an invitation link has no account,
 * and cannot make one with the right address until they are told which address
 * was invited. The pattern is deliberately exact rather than a prefix, so that
 * accepting the invitation, at /api/invite/:id/accept, still requires the
 * session whose address that is.
 *
 * A plugin's page files: the page runs in a sandboxed frame with an opaque
 * origin, whose requests carry no cookies, and the files are the plugin's
 * published assets (routes/apps.js).
 *
 * RUSH Lab's session and uploads: the app asks for a session with its connect
 * link's token, and the release job uploads with the upload token, in place of
 * a session (routes/lab.js).
 */
const PUBLIC_PATTERNS = [/^\/api\/invite\/[^/]+$/, /^\/api\/apps\/[^/]+\/ui\/.+$/, /^\/api\/lab\/(?:session|bundles\/[^/]+)$/];

/** Whether `pathname` may be served without a session. */
function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname)
    || pathname.startsWith('/api/auth/')
    // What a workspace publishes (routes/public.js).
    || pathname.startsWith('/api/public/')
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
 * Resolve the caller. Never throws and never returns a partial identity:
 * either `{ok: true, identity}` with a verified user, or `{ok: false, status,
 * error}` describing the rejection to send back verbatim. Either way `cookies`
 * are the Set-Cookie values Better Auth wrote for the response: the session's
 * refreshed snapshot, so the next request needs no query, or its removal.
 */
async function resolveIdentity(req) {
  let session;
  let cookies;
  try {
    const result = await auth.api.getSession({headers: fromNodeHeaders(req.headers), returnHeaders: true});
    session = result.response;
    cookies = result.headers.getSetCookie();
  } catch {
    return {ok: false, status: 401, error: 'Invalid or expired session', cookies: []};
  }
  if (!session?.user?.id) {
    return {ok: false, status: 401, error: 'Not signed in', cookies};
  }

  const userId = session.user.id;
  if (!isSafeId(userId)) {
    return {ok: false, status: 401, error: 'Invalid session subject', cookies};
  }

  // The session's choice if it has made one, and otherwise the account's first
  // organization. The create hook writes that choice for every new session, but
  // sessions issued before an account had an organization are still out there
  // holding a null, and they would each be one silent 409 from every chat
  // endpoint until their owner happened to sign out and back in.
  const orgId = session.session?.activeOrganizationId ?? await firstOrganizationOf(userId);
  return {
    ok: true,
    cookies,
    identity: Object.freeze({
      userId,
      orgId,
      sessionId: session.session?.id ?? null,
      // Who the session is, as the browser's gate shows it (GET /api/workspaces).
      account: Object.freeze({
        id: userId,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
        githubLogin: session.user.githubLogin ?? null,
      }),
    }),
  };
}

module.exports = {
  auth,
  AUTH_SECRET,
  SITE_URL,
  tenancy,
  githubUsers,
  workspaceProvisioning,
  resolveIdentity,
  productionAuthError,
  isPublicPath,
  isSafeId,
  PUBLIC_PATHS,
  PUBLIC_PATTERNS,
  workspaceAccessControl,
  workspaceRoles,
};
