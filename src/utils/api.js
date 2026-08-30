/** Base URL for API requests. Empty string (same-origin) in production, localhost:3001 in dev. */
const API_BASE = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''  // Same origin on Vercel
  : 'http://localhost:3001';

/**
 * The current session token, or null.
 *
 * Clerk exposes the token through the `useAuth()` hook, which only a component
 * may call, but the fetch helpers below are plain functions called from event
 * handlers and effects all over the tree. TokenBridge in src/theme/Root.js
 * closes that gap: it sits inside ClerkProvider, calls the hook, and parks the
 * getter here for `apiFetch` to await.
 *
 * Null until Clerk resolves, and null for good when the auth gate is off. In
 * both cases requests simply go out unauthenticated, which is what the server
 * expects when ENABLE_AUTH is unset.
 */
let getToken = null;

/** Called once by TokenBridge. Pass null on unmount to clear a stale getter. */
export function registerTokenGetter(fn) {
  getToken = fn;
}

/**
 * Whether `input` addresses our own API, and may therefore carry the session
 * token. The client also talks to Semantic Scholar and other third parties, and
 * a bearer token attached to one of those requests would hand a stranger a live
 * Clerk session.
 */
function isOwnApi(input) {
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url !== 'string') return false;
  return API_BASE
    ? url.startsWith(`${API_BASE}/api/`)
    : url.startsWith('/api/');
}

/**
 * fetch, with the Clerk session token attached.
 *
 * Use this for every call to our own API. The server derives the caller from
 * this token: an unauthenticated request is a 401 once ENABLE_AUTH is on, and
 * no `userId` in a query string or body will stand in for it.
 *
 * The signature matches fetch, so a call site changes only in name. Requests to
 * anywhere other than our API pass through untouched, without the token.
 */
export async function apiFetch(input, init = {}) {
  if (!isOwnApi(input) || !getToken) return fetch(input, init);

  let token = null;
  try {
    token = await getToken();
  } catch {
    // A getToken that throws (signed out mid-flight, Clerk not yet loaded)
    // means no token, not a failed request: let the server decide.
  }
  if (!token) return fetch(input, init);

  return fetch(input, {
    ...init,
    headers: {...init.headers, Authorization: `Bearer ${token}`},
  });
}

export default API_BASE;
