/**
 * Resolve the workspace named by a request into the only context domain
 * services are allowed to use.
 *
 * The session proves the user. The URL names the workspace. This module joins
 * those two facts through the membership table and returns nothing when they
 * do not meet. In particular, activeOrganizationId is deliberately absent:
 * changing a preference in one tab must not change what another tab may read.
 */
const {APP_UI_ROUTE, LAB_ROUTE, MARKET_ROUTE} = require('./routes/paths');

const WORKSPACE_ROLES = Object.freeze(['owner', 'editor', 'viewer']);

// Existing Better Auth rows use its default vocabulary. Reads normalize them
// immediately so the rest of the application has one permission language
// while the data migration changes the stored values.
const LEGACY_ROLE_MAP = Object.freeze({owner: 'owner', admin: 'editor', member: 'viewer'});

// `apps:use` is running the workspace's apps in the member's own sessions, on
// their own files (home/<user>/agent/), which every member may.
const PERMISSIONS = Object.freeze({
  owner: new Set([
    'workspace:manage', 'members:manage', 'content:read', 'content:create',
    'content:edit', 'content:publish', 'content:delete', 'comments:write', 'apps:use',
  ]),
  editor: new Set([
    'content:read', 'content:create', 'content:edit', 'content:publish',
    'comments:write', 'apps:use',
  ]),
  viewer: new Set(['content:read', 'comments:write', 'apps:use']),
});

const GLOBAL_API_PATHS = new Set([
  '/api/health', '/api/workspaces', '/api/workspace-site', '/api/preferences',
  '/api/users', '/api/users/me', '/api/logs', '/api/perf',
  '/api/debug/memory', '/api/debug/routes', '/api/signup-policy', '/api/users/me/invitations',
  // Whether the member's own computer is connected to run their AI and its API keys
  // (server/runner.js), and their AI settings with the models to choose from (ai-settings.js).
  '/api/runner/status', '/api/runner/keys', '/api/ai/settings', '/api/ai/models',
  // Making a workspace, which belongs to no workspace yet.
  '/api/org',
]);

/** Endpoints whose data is user-global, platform-global, or pre-authentication. */
function isGlobalApiPath(pathname) {
  const value = String(pathname ?? '');
  return GLOBAL_API_PATHS.has(value)
    || value.startsWith('/api/auth/')
    || value.startsWith('/api/public/')
    || /^\/api\/invite\/[^/]+(?:\/accept)?$/.test(value)
    // The routes that serve them match with the same patterns (routes/paths.js).
    || APP_UI_ROUTE.test(value)
    || MARKET_ROUTE.test(value)
    || LAB_ROUTE.test(value)
    || /^\/api\/users\/[^/]+\/role$/.test(value);
}

function normalizeWorkspaceRole(role) {
  const first = String(role ?? '').split(',')[0].trim();
  if (WORKSPACE_ROLES.includes(first)) return first;
  return LEGACY_ROLE_MAP[first] ?? 'viewer';
}

function can(context, permission) {
  return Boolean(context && PERMISSIONS[context.role]?.has(permission));
}

function requirePermission(context, permission) {
  if (can(context, permission)) return context;
  const error = new Error('You do not have permission to perform this action');
  error.name = 'WorkspacePermissionError';
  error.status = 403;
  error.code = 'workspace-permission-denied';
  throw error;
}

function createWorkspaceContextResolver({db = require('./db').db} = {}) {
  const byId = db.prepare(
    `SELECT o.id AS workspaceId, o.slug AS workspaceSlug,
            m.id AS membershipId, m.userId, m.role
       FROM organization o
       JOIN member m ON m.organizationId = o.id
      WHERE o.id = ? AND o.status = 'active' AND m.userId = ?
      LIMIT 1`,
  );
  const bySlug = db.prepare(
    `SELECT o.id AS workspaceId, o.slug AS workspaceSlug,
            m.id AS membershipId, m.userId, m.role
       FROM organization o
       JOIN member m ON m.organizationId = o.id
      WHERE o.slug = ? AND o.status = 'active' AND m.userId = ?
      LIMIT 1`,
  );

  function fromRow(row) {
    if (!row) return null;
    return Object.freeze({
      userId: row.userId,
      workspaceId: row.workspaceId,
      membershipId: row.membershipId,
      role: normalizeWorkspaceRole(row.role),
    });
  }

  return Object.freeze({
    byId(userId, workspaceId) {
      if (typeof userId !== 'string' || !userId || typeof workspaceId !== 'string' || !workspaceId) {
        return null;
      }
      return fromRow(byId.get(workspaceId, userId));
    },
    bySlug(userId, workspaceSlug) {
      if (typeof userId !== 'string' || !userId || typeof workspaceSlug !== 'string' || !workspaceSlug) {
        return null;
      }
      return fromRow(bySlug.get(workspaceSlug, userId));
    },
  });
}

/** The workspace portion of an API URL, or null for a user-global endpoint. */
function matchWorkspaceApiPath(pathname) {
  const match = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(String(pathname ?? ''));
  if (!match) return null;
  try {
    return Object.freeze({
      workspaceId: decodeURIComponent(match[1]),
      workspacePath: match[2] || '/',
    });
  } catch {
    return Object.freeze({workspaceId: '', workspacePath: match[2] || '/'});
  }
}

/**
 * Translate the explicit public namespace to the temporary internal route
 * names. This disappears as individual handlers adopt their final paths.
 */
function workspaceDispatchPath(workspacePath) {
  const suffix = String(workspacePath ?? '/');
  if (suffix === '/documents' || suffix.startsWith('/documents/')) {
    return `/api/content${suffix.slice('/documents'.length)}`;
  }
  if (
    suffix === '/members' || suffix.startsWith('/members/')
    || suffix === '/invitations' || suffix.startsWith('/invitations/')
    || suffix === '/audit'
  ) {
    return `/api/org${suffix}`;
  }
  return `/api${suffix}`;
}

/**
 * Return the verified RequestContext unchanged for domain services.
 *
 * Keeping this small helper lets route modules stay terse while ensuring the
 * persistence boundary receives membership and role together with the user
 * and workspace. There is intentionally no `{orgId, userId}` compatibility
 * shape: a domain call must carry the context produced by this module.
 */
function storageScope(context) {
  if (!context?.workspaceId || !context?.userId) {
    const error = new Error('A verified workspace context is required');
    error.name = 'WorkspaceContextError';
    error.status = 404;
    error.code = 'workspace-not-found';
    throw error;
  }
  return context;
}

module.exports = {
  WORKSPACE_ROLES,
  LEGACY_ROLE_MAP,
  PERMISSIONS,
  normalizeWorkspaceRole,
  can,
  requirePermission,
  createWorkspaceContextResolver,
  matchWorkspaceApiPath,
  workspaceDispatchPath,
  storageScope,
  isGlobalApiPath,
};
