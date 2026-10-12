/** Browser authentication through Better Auth's HttpOnly session cookie. */
import {createAuthClient} from 'better-auth/react';
import {deviceAuthorizationClient} from 'better-auth/client/plugins';
import API_BASE from './api';
import {clientPlatform} from '../platform/client.js';
import {WORKSPACE_SITE_STORAGE_PREFIX} from '../hooks/useWorkspaceSite.js';
import {documentCache} from './documentCache.js';

// Without an API origin Better Auth uses the page's own, at its default /api/auth.
const AUTH_BASE_URL = API_BASE ? `${API_BASE}/api/auth` : undefined;

export const authClient = createAuthClient({
  baseURL: AUTH_BASE_URL,
  fetchOptions: {credentials: 'include'},
  // Approving the command-line client's device code (pages/device.js).
  plugins: [deviceAuthorizationClient()],
});

export const {useSession, signIn, signOut} = authClient;

const CLI_SESSIONS_KEY = 'mochi-cli-sessions';

export async function signOutAndForget() {
  try {
    await authClient.signOut();
  } finally {
    // Agent transcripts are isolated per workspace. Signing out must clear
    // every scoped copy so another account on the same client cannot see the
    // previous reader's conversations.
    clientPlatform.storage.removeMatching(
      key => key === CLI_SESSIONS_KEY || key.startsWith(`${CLI_SESSIONS_KEY}:`)
        // The navbar's memory of each workspace, which the next account must not see.
        || key.startsWith(WORKSPACE_SITE_STORAGE_PREFIX),
    );
    // This browser's copy of the account's documents, and any unsent edits.
    await documentCache().clear();
  }
}
