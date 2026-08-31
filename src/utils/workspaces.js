/**
 * The workspaces you belong to, and moving between them.
 *
 * Three places ask the same two questions: the auth gate, which shows the
 * create-or-join screen to an account in none; the switcher in the navbar; and
 * the settings page. Spelling the endpoints once here means a change to either
 * reaches all three, and that they agree about what a failure means.
 *
 * Workspace selection is navigation, not session mutation. The URL is the
 * authority, which lets two tabs stay in different workspaces.
 */
import API_BASE, { apiFetch } from './api.js';

const WORKSPACE_CACHE_MS = 30_000;
let workspaceRequest = null;
let workspaceRequestTime = 0;

export const WORKSPACE_PAGE_ROOTS = new Set([
  'analytics', 'bibliography', 'channels', 'compare', 'content-search', 'documents', 'flashcards',
  'glossary', 'graph', 'mindmap', 'people', 'reading-lists',
  'recommendations', 'settings', 'stats', 'tasks', 'timeline', 'whiteboard',
]);

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

export function workspaceSlugFromPath(pathname) {
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(String(pathname ?? ''));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

/** Keep workspace-owned navigation in the workspace named by the current URL. */
export function scopeWorkspacePath(target, currentPath) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('/w/')) return target;
  const slug = workspaceSlugFromPath(currentPath);
  const root = /^\/([^/?#]+)/.exec(target)?.[1];
  if (!slug || !WORKSPACE_PAGE_ROOTS.has(root)) return target;
  return `/w/${encodeURIComponent(slug)}${target}`;
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
export function loadWorkspaces({fresh = false} = {}) {
  const now = Date.now();
  if (!fresh && workspaceRequest && now - workspaceRequestTime < WORKSPACE_CACHE_MS) {
    return workspaceRequest;
  }
  workspaceRequestTime = now;
  workspaceRequest = call('/api/workspaces')
    .then(data => ({
      ...data,
      // Compatibility names while the remaining callers move to `workspaces`
      // and `defaultWorkspaceId`.
      memberships: data.workspaces ?? [],
      activeId: data.defaultWorkspaceId ?? null,
    }))
    .catch(error => {
      workspaceRequest = null;
      workspaceRequestTime = 0;
      throw error;
    });
  return workspaceRequest;
}

export function invalidateWorkspaceCache() {
  workspaceRequest = null;
  workspaceRequestTime = 0;
}

/** Update the SPA router without downloading and booting the whole site again. */
export function navigateClient(pathname, {replace = false} = {}) {
  if (typeof window === 'undefined') return;
  const target = String(pathname || '/');
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target === current) return;
  const state = window.history.state;
  window.history[replace ? 'replaceState' : 'pushState'](state, '', target);
  const event = typeof PopStateEvent === 'function'
    ? new PopStateEvent('popstate', {state})
    : new Event('popstate');
  window.dispatchEvent(event);
}

/** Navigate to a workspace, preserving the workspace-relative page when able. */
export async function switchWorkspace(workspace) {
  let target = workspace;
  if (typeof workspace === 'string') {
    const {workspaces} = await loadWorkspaces();
    target = workspaces.find(item => item.id === workspace || item.slug === workspace);
  }
  if (!target?.slug) throw new Error('Workspace not found');

  const current = typeof window === 'undefined' ? '' : window.location.pathname;
  const inWorkspace = /^\/w\/[^/]+(\/.*)?$/.exec(current);
  const suffix = inWorkspace?.[1] || '/documents';
  navigateClient(`/w/${encodeURIComponent(target.slug)}${suffix}`);
}

/**
 * Create a workspace, which also makes it the active one, then reload.
 *
 * An omitted `slug` is the ordinary case: the server derives one from the name
 * and numbers it if that is taken. Sending one makes it a choice, and a choice
 * that is taken is refused rather than altered.
 */
export async function createWorkspace({ name, slug }) {
  const {workspace} = await call('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slug ? { name, slug } : { name }),
  });
  invalidateWorkspaceCache();
  window.location.assign(`/w/${encodeURIComponent(workspace.slug)}/documents`);
}
