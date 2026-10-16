import {clientPlatform} from '../platform/client.js';

/**
 * Base URL for API requests: the page's own origin, which serves the API in
 * production and proxies it in development (docusaurus.config.js). A desktop
 * shell can point the shared frontend at the hosted API without teaching
 * feature code about its packaging.
 */
export function resolveApiBase({configured} = {}) {
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim().replace(/\/$/, '');
  }
  return '';
}

const API_BASE = resolveApiBase({configured: clientPlatform.runtimeConfig().apiBaseUrl});

/** Whether `input` addresses our own API. */
function isOwnApi(input) {
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url !== 'string') return false;
  return API_BASE
    ? url.startsWith(`${API_BASE}/api/`)
    : url.startsWith('/api/');
}

const GLOBAL_API_PATHS = [
  '/api/auth/', '/api/workspaces', '/api/workspace-site', '/api/invite/', '/api/health',
  '/api/users', '/api/users/', '/api/logs', '/api/debug/',
  '/api/preferences', '/api/perf', '/api/public/', '/api/market', '/api/market/',
  '/api/signup-policy',
  // The member's computer and AI settings, a new workspace, and RUSH Lab's install
  // (server/workspace-context.js): asked on any page, a workspace one they are not in too.
  '/api/runner/status', '/api/runner/keys', '/api/ai/settings', '/api/ai/models', '/api/org', '/api/lab/',
];

const workspaceIds = new Map();
const jsonResponses = new Map();

function currentWorkspaceSlug() {
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(clientPlatform.location.pathname());
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
    // Share the same in-flight workspace discovery request as the navbar,
    // auth gate, and runtime content loader. Starting a tool page and its
    // workspace shell together must not produce two identical Neon reads.
    const pending = apiJson(`${API_BASE}/api/workspaces`, {cacheMs: 10 * 60_000})
      .then(result => {
        if (!result.ok) throw new Error(result.data.error || 'Could not resolve workspace');
        const workspace = (result.data.workspaces ?? []).find(item => item.slug === slug);
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
 * Call one of Mochi's JSON endpoints and turn its error response into the
 * consistent Error shape expected throughout the client.
 */
export async function apiRequest(path, init, {failureLabel = 'Request failed'} = {}) {
  const response = await apiFetch(`${API_BASE}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `${failureLabel} (${response.status})`);
    error.status = response.status;
    error.code = data.code ?? null;
    throw error;
  }
  return data;
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
  if (!prefix || prefix === `${API_BASE}/api/workspaces`) {
    workspaceIds.clear();
  }
}

export default API_BASE;
