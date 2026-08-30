/**
 * Server-side identity for the API.
 *
 * Until now every handler took the caller's identity from the request itself:
 * `?userId=` on a GET, `body.userId` on a POST, `body.requesterId` on the role
 * change. That is not authentication. Anyone could claim to be anyone, and the
 * owner-only role endpoint was one hand-written JSON field away from being
 * public. This module is the single place that answers "who is calling?", and
 * it answers from a Clerk session token, which the client cannot forge.
 *
 * Two modes, selected by ENABLE_AUTH so the server matches the site's own gate
 * in src/theme/Root.js:
 *
 *   ENABLE_AUTH=true   Every non-public request must carry a valid Clerk
 *                      session token. A missing, expired, malformed, or
 *                      wrongly signed token is a 401 before any handler runs.
 *                      CLERK_SECRET_KEY is required; the server refuses to
 *                      start without it rather than falling open.
 *   anything else      Development. No token is expected and every request
 *                      resolves to DEV_IDENTITY, so `npm start` and the test
 *                      suite run without a Clerk account.
 *
 * The trust boundary is the same in both modes: handlers read identity only
 * from `req.auth`, never from the URL or the body. What ENABLE_AUTH changes is
 * who the server believes you are, never whether the client gets to decide.
 */
const {verifyToken} = require('@clerk/backend');

const AUTH_ENABLED = process.env.ENABLE_AUTH === 'true';
const SECRET_KEY = process.env.CLERK_SECRET_KEY || '';

if (AUTH_ENABLED && !SECRET_KEY) {
  throw new Error(
    'ENABLE_AUTH=true requires CLERK_SECRET_KEY. Refusing to start with ' +
    'authentication enabled but no way to verify session tokens.'
  );
}

/**
 * The identity every request carries in development. A stable id keeps the
 * JSON stores keyed consistently across restarts, which is what the old
 * `|| 'default'` fallbacks were reaching for.
 */
const DEV_IDENTITY = Object.freeze({
  userId: 'dev-user',
  orgId: null,
  orgRole: null,
  sessionId: null,
});

/**
 * Endpoints that stay reachable without a session, because the clients that
 * call them cannot hold one: uptime monitoring, and feed readers.
 */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/feed/rss',
  '/api/feed/atom',
]);

/**
 * Identities are used as object keys in the JSON stores, so an id that names a
 * prototype slot would write through to Object.prototype. Clerk ids are
 * `user_...`, so this can only fire on a forged or malformed token, but the
 * check lives here to hold for every store at once rather than at each of the
 * twenty-odd handlers that key on it.
 */
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !UNSAFE_IDS.has(id);
}

/** The bearer token, from the Authorization header or Clerk's session cookie. */
function readToken(req) {
  const header = req.headers?.authorization || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  // Same-origin deployments get the token as a cookie instead of a header.
  const cookie = req.headers?.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === '__session') {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    }
  }
  return null;
}

/**
 * Flatten Clerk's session claims into the shape handlers consume.
 *
 * Version 2 session tokens nest the active organization under `o` with
 * abbreviated fields (`id`, `rol`, `slg`); version 1 spells them out at the top
 * level as `org_id` / `org_role`. Both are accepted so a Clerk-side token
 * version change cannot silently drop the organization. Roles are normalized to
 * their bare name, since v1 prefixes them with `org:` and v2 does not.
 */
function identityFromClaims(claims) {
  const org = claims.o || null;
  const rawRole = org?.rol ?? claims.org_role ?? null;
  return {
    userId: claims.sub,
    orgId: org?.id ?? claims.org_id ?? null,
    orgRole: typeof rawRole === 'string' ? rawRole.replace(/^org:/, '') : null,
    sessionId: claims.sid ?? null,
  };
}

/**
 * Resolve the caller. Never throws and never returns a partial identity:
 * either `{ok: true, identity}` with a verified user, or `{ok: false, status,
 * error}` describing the rejection to send back verbatim.
 */
async function resolveIdentity(req) {
  if (!AUTH_ENABLED) return {ok: true, identity: DEV_IDENTITY};

  const token = readToken(req);
  if (!token) return {ok: false, status: 401, error: 'Missing session token'};

  let claims;
  try {
    claims = await verifyToken(token, {secretKey: SECRET_KEY});
  } catch {
    // The failure reason (expired, bad signature, wrong issuer) is deliberately
    // not echoed back; it tells an attacker which part of a forgery to fix.
    return {ok: false, status: 401, error: 'Invalid or expired session token'};
  }

  const identity = identityFromClaims(claims);
  if (!isSafeId(identity.userId)) {
    return {ok: false, status: 401, error: 'Invalid session subject'};
  }
  return {ok: true, identity: Object.freeze(identity)};
}

/** Whether `pathname` may be served without a session. */
function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname);
}

module.exports = {
  resolveIdentity,
  isPublicPath,
  isSafeId,
  identityFromClaims,
  readToken,
  AUTH_ENABLED,
  DEV_IDENTITY,
  PUBLIC_PATHS,
};
