/** Base URL for API requests. Empty string (same-origin) in production, localhost:3001 in dev. */
const API_BASE = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''  // Same origin on Vercel
  : 'http://localhost:3001';

/**
 * Where the session token is kept.
 *
 * Declared here, the dependency-free module, and imported by ./authClient
 * rather than the other way round: authClient already imports API_BASE from
 * here, so the arrow points one way and there is exactly one spelling of the
 * key. apiFetch and the auth client reading different keys would fail as a
 * silent permanent 401, which is a bad thing to leave to a naming convention.
 */
export const TOKEN_KEY = 'mochi.session-token';

/**
 * The current session token, or null when signed out.
 *
 * Read at call time rather than captured, so a sign-in or sign-out during the
 * page's life is picked up by the next request without re-registering anything.
 * localStorage is absent during the static build and can throw when storage is
 * disabled, hence the guards.
 */
function currentToken() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Whether `input` addresses our own API, and may therefore carry the session
 * token. The client also talks to Semantic Scholar and other third parties, and
 * a bearer token attached to one of those requests would hand a stranger a live
 * session.
 */
function isOwnApi(input) {
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url !== 'string') return false;
  return API_BASE
    ? url.startsWith(`${API_BASE}/api/`)
    : url.startsWith('/api/');
}

/**
 * fetch, with the session token attached.
 *
 * Use this for every call to our own API. The server derives the caller from
 * this token: an unauthenticated request is a 401 once ENABLE_AUTH is on, and
 * no `userId` in a query string or body will stand in for it.
 *
 * Requests to /api/auth/* are the exception that proves the rule, and they go
 * through the Better Auth client in ./authClient.js, not through here.
 *
 * The signature matches fetch, so a call site changes only in name. Requests to
 * anywhere other than our API pass through untouched, without the token.
 */
export async function apiFetch(input, init = {}) {
  if (!isOwnApi(input)) return fetch(input, init);

  const token = currentToken();
  if (!token) return fetch(input, init);

  return fetch(input, {
    ...init,
    headers: {...init.headers, Authorization: `Bearer ${token}`},
  });
}

export default API_BASE;
