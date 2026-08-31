/**
 * The workspaces you belong to, and moving between them.
 *
 * Three places ask the same two questions: the auth gate, which shows the
 * create-or-join screen to an account in none; the switcher in the navbar; and
 * the settings page. Spelling the endpoints once here means a change to either
 * reaches all three, and that they agree about what a failure means.
 *
 * Switching and creating both end in a full page reload rather than in returned
 * state. The active workspace is a property of the session, and every page on
 * the site reads from it, so updating the caller alone would leave the rest of
 * the app showing the workspace you just left.
 */
import API_BASE, { apiFetch } from './api';

async function call(path, init) {
  const res = await apiFetch(`${API_BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.code ?? null;
    throw error;
  }
  return data;
}

/**
 * `{memberships, activeId}`: every workspace this account is in, oldest first,
 * with the role held in each, and which one the session is currently in.
 *
 * Throws when the API cannot be reached. Callers decide what that means for
 * them, because it is not the same everywhere: the gate treats it as "probably
 * has one" so a network blip cannot strand somebody on the onboarding screen,
 * while the settings page simply says it could not load.
 */
export function loadWorkspaces() {
  return call('/api/org/memberships');
}

/** Make `organizationId` the session's active workspace, then reload. */
export async function switchWorkspace(organizationId) {
  await call('/api/org/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  });
  window.location.reload();
}

/**
 * Create a workspace, which also makes it the active one, then reload.
 *
 * An omitted `slug` is the ordinary case: the server derives one from the name
 * and numbers it if that is taken. Sending one makes it a choice, and a choice
 * that is taken is refused rather than altered.
 */
export async function createWorkspace({ name, slug }) {
  await call('/api/org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slug ? { name, slug } : { name }),
  });
  window.location.reload();
}
