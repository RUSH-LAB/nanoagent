/** Browser authentication through Better Auth's HttpOnly session cookie. */
import {createAuthClient} from 'better-auth/react';
import API_BASE from './api';
import {clientPlatform} from '../platform/client.js';
import {documentCache} from './documentCache.js';

const AUTH_BASE_URL = API_BASE
  ? `${API_BASE}/api/auth`
  : `${clientPlatform.location.origin() || 'http://localhost:3000'}/api/auth`;

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
    // Agent transcripts are isolated per workspace. Signing out must clear
    // every scoped copy so another account on the same client cannot see the
    // previous reader's conversations.
    clientPlatform.storage.removeMatching(
      key => key === CLI_SESSIONS_KEY || key.startsWith(`${CLI_SESSIONS_KEY}:`),
    );
    // This browser's copy of the account's documents, and any unsent edits.
    await documentCache().clear();
  }
}
