/** Base URL for API requests. Empty string (same-origin) in production, localhost:3001 in dev. */
const API_BASE = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''  // Same origin on Vercel
  : 'http://localhost:3001';

/** Whether `input` addresses our own API. */
function isOwnApi(input) {
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url !== 'string') return false;
  return API_BASE
    ? url.startsWith(`${API_BASE}/api/`)
    : url.startsWith('/api/');
}

const GLOBAL_API_PATHS = [
  '/api/auth/', '/api/workspaces', '/api/invite/', '/api/health',
  '/api/dev-login', '/api/users', '/api/users/', '/api/logs', '/api/debug/',
  '/api/preferences', '/api/perf',
];

const workspaceIds = new Map();

function currentWorkspaceSlug() {
  if (typeof window === 'undefined') return null;
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(window.location.pathname);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function apiPathOf(input) {
  const value = typeof input === 'string' ? input : input?.url;
  if (typeof value !== 'string') return null;
  const offset = value.indexOf('/api/');
  return offset >= 0 ? value.slice(offset) : null;
}

function isGlobalApi(pathname) {
  return GLOBAL_API_PATHS.some(prefix =>
    prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}?`),
  );
}

async function workspaceIdFor(slug) {
  if (!workspaceIds.has(slug)) {
    const pending = fetch(`${API_BASE}/api/workspaces`, {credentials: 'include'})
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Could not resolve workspace');
        const workspace = (body.workspaces ?? []).find(item => item.slug === slug);
        if (!workspace) {
          const error = new Error('Workspace not found');
          error.status = 404;
          throw error;
        }
        return workspace.id;
      })
      .catch(error => {
        workspaceIds.delete(slug);
        throw error;
      });
    workspaceIds.set(slug, pending);
  }
  return workspaceIds.get(slug);
}

async function workspaceScopedInput(input) {
  const apiPath = apiPathOf(input);
  const slug = currentWorkspaceSlug();
  if (!apiPath || !slug || isGlobalApi(apiPath) || apiPath.startsWith('/api/workspaces/')) return input;
  const workspaceId = await workspaceIdFor(slug);
  const scoped = `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}${apiPath.slice('/api'.length)}`;
  return typeof input === 'string' ? scoped : new Request(scoped, input);
}

/**
 * fetch with the HttpOnly session cookie included for our own API only.
 */
export async function apiFetch(input, init = {}) {
  if (!isOwnApi(input)) return fetch(input, init);
  return fetch(await workspaceScopedInput(input), {...init, credentials: 'include'});
}

export default API_BASE;
