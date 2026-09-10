/** Browser authentication through Better Auth's HttpOnly session cookie. */
import {createAuthClient} from 'better-auth/react';
import API_BASE from './api';

const AUTH_BASE_URL = API_BASE
  ? `${API_BASE}/api/auth`
  : `${typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin}/api/auth`;

export const authClient = createAuthClient({
  baseURL: AUTH_BASE_URL,
  fetchOptions: {credentials: 'include'},
});

export const {useSession, signIn, signUp, signOut} = authClient;

const CLI_SESSIONS_KEY = 'mochi-cli-sessions';

export async function signOutAndForget() {
  try {
    await authClient.signOut();
  } finally {
    if (typeof window !== 'undefined') {
      try {
        // Agent transcripts are isolated per workspace. Signing out must clear
        // every scoped copy so another account on the same browser cannot see
        // the previous reader's conversations.
        for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
          const key = window.localStorage.key(index);
          if (key === CLI_SESSIONS_KEY || key?.startsWith(`${CLI_SESSIONS_KEY}:`)) {
            window.localStorage.removeItem(key);
          }
        }
      } catch { /* unavailable */ }
    }
  }
}
