/** Browser authentication through Better Auth's HttpOnly session cookie. */
import {createAuthClient} from 'better-auth/react';
import API_BASE from './api';

export const authClient = createAuthClient({
  baseURL: `${API_BASE}/api/auth`,
  fetchOptions: {credentials: 'include'},
});

export const {useSession, signIn, signUp, signOut} = authClient;

const CLI_SESSIONS_KEY = 'mochi-cli-sessions';

export async function signOutAndForget() {
  try {
    await authClient.signOut();
  } finally {
    if (typeof window !== 'undefined') {
      try { window.localStorage.removeItem(CLI_SESSIONS_KEY); } catch { /* unavailable */ }
    }
  }
}
