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
import API_BASE, { apiFetch, apiJson, invalidateApiJson } from './api.js';
import {clientPlatform} from '../platform/client.js';
import {documentCache, isOffline} from './documentCache.js';

// Workspace ids/slugs are immutable routing data, not authorization. Keeping
// this mapping warm prevents every content click after 30 seconds from waiting
// on Neon; the scoped API still revalidates membership and RLS on every read.
const WORKSPACE_CACHE_MS = 10 * 60_000;
let workspaceRequest = null;
let workspaceRequestTime = 0;
let workspaceValue = null;

export const WORKSPACE_PAGE_ROOTS = new Set([
  'analytics', 'bibliography', 'channels', 'compare', 'content-search', 'documents', 'files', 'flashcards',
  'glossary', 'graph', 'marketplace', 'mindmap', 'people', 'reading-lists',
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
 * While the API cannot be reached, answers with the list this browser kept
 * from the last signed-in load, marked `offline: true`, so the documents kept
 * on this computer stay reachable. Throws when there is no such list. Callers
 * decide what a failure means for them, because it is not the same everywhere:
 * the gate treats it as "probably has one" so a network blip cannot strand
 * somebody on the onboarding screen, while the settings page simply says it
 * could not load.
 */
export function loadWorkspaces({fresh = false} = {}) {
  const now = Date.now();
  if (!fresh && workspaceRequest && now - workspaceRequestTime < WORKSPACE_CACHE_MS) {
    return workspaceRequest;
  }
  workspaceRequestTime = now;
  workspaceRequest = apiJson(`${API_BASE}/api/workspaces`, {
    cacheMs: WORKSPACE_CACHE_MS,
    fresh,
  })
    .then(result => {
      if (!result.ok) {
        const error = new Error(result.data.error || `Request failed (${result.status})`);
        error.status = result.status;
        error.code = result.data.code ?? null;
        throw error;
      }
      const data = result.data;
      workspaceValue = {
        ...data,
        // Compatibility names while the remaining callers move to `workspaces`
        // and `defaultWorkspaceId`.
        memberships: data.workspaces ?? [],
        activeId: data.defaultWorkspaceId ?? null,
      };
      documentCache().rememberAccount(data)
        .catch(error => console.error('[documents] Could not keep the workspace list:', error));
      return workspaceValue;
    })
    .catch(async error => {
      workspaceRequest = null;
      workspaceRequestTime = 0;
      // A server that answers "signed out" ends offline use of this account too.
      if (error.status === 401) await documentCache().forgetAccount()
        .catch(cacheError => console.error('[documents] Could not forget the workspace list:', cacheError));
      const kept = isOffline(error) ? await documentCache().account() : null;
      if (!kept) throw error;
      return {...kept, memberships: kept.workspaces ?? [], activeId: kept.defaultWorkspaceId ?? null, offline: true};
    });
  return workspaceRequest;
}

export function getCachedWorkspaces() {
  return workspaceValue;
}

export function invalidateWorkspaceCache() {
  workspaceRequest = null;
  workspaceRequestTime = 0;
  workspaceValue = null;
  invalidateApiJson(`${API_BASE}/api/workspaces`);
}

/** Update the SPA router without downloading and booting the whole site again. */
export function navigateClient(pathname, {replace = false} = {}) {
  if (typeof window === 'undefined') return;
  const target = String(pathname || '/');
  const current = `${clientPlatform.location.pathname()}${clientPlatform.location.search()}${clientPlatform.location.hash()}`;
  if (target === current) return;
  const state = window.history.state;
  window.history[replace ? 'replaceState' : 'pushState'](state, '', target);
  const event = typeof PopStateEvent === 'function'
    ? new PopStateEvent('popstate', {state})
    : new Event('popstate');
  window.dispatchEvent(event);
}

/** Navigate to a workspace, preserving tools but opening content at its home. */
export async function switchWorkspace(workspace) {
  let target = workspace;
  if (typeof workspace === 'string') {
    const {workspaces} = await loadWorkspaces();
    target = workspaces.find(item => item.id === workspace || item.slug === workspace);
  }
  if (!target?.slug) throw new Error('Workspace not found');

  const current = clientPlatform.location.pathname();
  const inWorkspace = /^\/w\/[^/]+(\/.*)?$/.exec(current);
  const suffix = inWorkspace?.[1] || '/documents';
  const destination = suffix.startsWith('/documents/') ? '/documents' : suffix;
  navigateClient(`/w/${encodeURIComponent(target.slug)}${destination}`);
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
  clientPlatform.location.assign(`/w/${encodeURIComponent(workspace.slug)}/documents`);
}
