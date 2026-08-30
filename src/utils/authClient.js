/**
 * The browser's half of authentication.
 *
 * Sessions are carried as bearer tokens rather than cookies. In development the
 * site is served from :3000 and the API from :3001, and a browser will not send
 * a cookie across origins without HTTPS and SameSite=None. A token in an
 * Authorization header has no such restriction, so the same code path works in
 * dev and in production.
 *
 * The token lives in localStorage under one key, which both this client and
 * apiFetch in ./api.js read. Sign-in and sign-up responses carry a fresh token
 * in a `set-auth-token` header; the onSuccess hook below is what stores it.
 */
import { createAuthClient } from 'better-auth/react';
import { usernameClient, organizationClient } from 'better-auth/client/plugins';
import API_BASE, { TOKEN_KEY } from './api';

export { TOKEN_KEY };

/**
 * localStorage is absent during the static build and can throw in a browser
 * with storage disabled, so every access goes through these two.
 */
export function getStoredToken() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token) {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage disabled: the session lasts until the tab closes, which is a
    // worse experience but not a broken one.
  }
}

export const authClient = createAuthClient({
  baseURL: `${API_BASE}/api/auth`,
  plugins: [usernameClient(), organizationClient()],
  fetchOptions: {
    auth: {
      type: 'Bearer',
      token: () => getStoredToken() || '',
    },
    onSuccess: (ctx) => {
      // Present on sign-in and sign-up, absent on everything else, so this
      // refreshes the stored token without clearing it on ordinary calls.
      const token = ctx.response.headers.get('set-auth-token');
      if (token) setStoredToken(token);
    },
  },
});

export const { useSession, signIn, signUp, signOut } = authClient;

/** Sign out both server-side and locally, then drop the stored token. */
export async function signOutAndForget() {
  try {
    await authClient.signOut();
  } finally {
    // Clear regardless: a failed server round trip should still end the session
    // in this browser rather than leaving a token that looks valid.
    setStoredToken(null);
  }
}
