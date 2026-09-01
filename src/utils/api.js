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
const jsonResponses = new Map();

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

/**
 * Deduplicate and briefly retain read-only API responses. Docusaurus keeps the
 * navbar mounted across ordinary navigation, but runtime content can remount
 * layout subtrees. Sharing this cache prevents those consumers from turning
 * one click into several identical Neon round trips.
 */
export async function apiJson(input, {cacheMs = 0, fresh = false, ...init} = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const key = typeof input === 'string' ? input : input.url;
  const now = Date.now();
  const cached = method === 'GET' && !fresh ? jsonResponses.get(key) : null;
  if (cached && (cached.pending || now - cached.at < cacheMs)) return cached.value;

  const pending = apiFetch(input, init).then(async response => ({
    ok: response.ok,
    status: response.status,
    data: await response.json().catch(() => ({})),
  }));
  if (method === 'GET' && cacheMs > 0) {
    jsonResponses.set(key, {at: now, pending: true, value: pending});
  }
  try {
    const result = await pending;
    if (method === 'GET' && cacheMs > 0 && result.ok) {
      jsonResponses.set(key, {at: Date.now(), pending: false, result, value: Promise.resolve(result)});
    } else if (method === 'GET') {
      jsonResponses.delete(key);
    }
    return result;
  } catch (error) {
    if (method === 'GET') jsonResponses.delete(key);
    throw error;
  }
}

export function getCachedApiJson(input) {
  const key = typeof input === 'string' ? input : input?.url;
  return key ? jsonResponses.get(key)?.result ?? null : null;
}

export function invalidateApiJson(prefix = '') {
  for (const key of jsonResponses.keys()) {
    if (!prefix || key.startsWith(prefix)) jsonResponses.delete(key);
  }
}

export default API_BASE;
