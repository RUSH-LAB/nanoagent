'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// Platform administration of tenants: the sign-up policy and default limits,
// every account, every workspace, and the record of what administrators did.
// The decisions and the platform-admin check live in postgres/tenancy.js; this
// module translates HTTP to it. Also the one public read, /api/signup-policy,
// which tells the sign-in screen whether to offer sign-up.

const USER_RE = /^\/api\/admin\/users\/([^/]+)(?:\/(ban|sessions|workspace-limit))?$/;
const WORKSPACE_RE = /^\/api\/admin\/workspaces\/([^/]+)\/(limits|status)$/;

function sendTenancyError(json, res, error) {
  if (error?.name !== 'TenancyError') throw error;
  return json(res, error.status, {
    error: error.message,
    code: error.code,
    ...(error.workspaces ? {workspaces: error.workspaces} : {}),
  });
}

module.exports = async function admin_routes(req, res, url, pathname, ctx) {
  const {json, readBody, rateLimit, tenancy, roles, cleanPendingObjects} = ctx;

  if (req.method === 'GET' && pathname === '/api/signup-policy') {
    const policy = tenancy ? await tenancy.policy() : null;
    return json(res, 200, {signupMode: policy?.signupMode ?? 'open'});
  }

  if (!pathname.startsWith('/api/admin/')) return;
  if (!tenancy) return json(res, 503, {error: 'Platform administration requires PostgreSQL'});
  const actorId = req.auth?.userId;
  if (!await roles.isAdmin(actorId)) {
    return json(res, 403, {error: 'Only platform administrators can do that', code: 'not-platform-admin'});
  }
  if (req.method !== 'GET' && !await rateLimit(`admin-write:${actorId}`, 60)) {
    return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
  }

  const body = async () => {
    try {
      return await readBody(req);
    } catch {
      const error = new Error('Invalid request');
      error.status = 400;
      throw error;
    }
  };

  try {
    // ── Policy: sign-up and default limits ──
    if (pathname === '/api/admin/policy') {
      if (req.method === 'GET') return json(res, 200, {policy: await tenancy.policy()});
      if (req.method === 'PUT') return json(res, 200, {policy: await tenancy.updatePolicy(actorId, await body())});
    }

    // ── Accounts ──
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      return json(res, 200, {users: await tenancy.listUsers(actorId)});
    }
    const user = USER_RE.exec(pathname);
    if (user) {
      const [, userId, action] = user;
      if (action === 'ban' && req.method === 'POST') {
        const {reason} = await body();
        return json(res, 200, await tenancy.banUser(actorId, userId, reason));
      }
      if (action === 'ban' && req.method === 'DELETE') {
        await tenancy.unbanUser(actorId, userId);
        return json(res, 200, {unbanned: true});
      }
      if (action === 'sessions' && req.method === 'DELETE') {
        return json(res, 200, await tenancy.revokeSessions(actorId, userId));
      }
      if (action === 'workspace-limit' && req.method === 'PUT') {
        const {maxWorkspaces} = await body();
        await tenancy.setUserWorkspaceLimit(actorId, userId, maxWorkspaces ?? null);
        return json(res, 200, {maxWorkspaces: maxWorkspaces ?? null});
      }
      if (!action && req.method === 'DELETE') {
        const result = await tenancy.deleteUser(actorId, userId);
        if (result.queuedObjects && cleanPendingObjects) await cleanPendingObjects();
        return json(res, 200, {deleted: true});
      }
    }

    // ── Workspaces ──
    if (req.method === 'GET' && pathname === '/api/admin/workspaces') {
      return json(res, 200, {workspaces: await tenancy.listWorkspaces(actorId)});
    }
    const workspace = WORKSPACE_RE.exec(pathname);
    if (workspace && req.method === 'PUT') {
      const [, workspaceId, action] = workspace;
      const sent = await body();
      if (action === 'limits') {
        return json(res, 200, {limits: await tenancy.setWorkspaceLimits(actorId, workspaceId, sent?.limits ?? null)});
      }
      return json(res, 200, await tenancy.setWorkspaceStatus(actorId, workspaceId, sent?.status));
    }

    // ── What administrators did ──
    if (req.method === 'GET' && pathname === '/api/admin/audit') {
      return json(res, 200, {events: await tenancy.listAudit(actorId, url.searchParams.get('limit'))});
    }
  } catch (error) {
    if (error?.status === 400 && error.message === 'Invalid request') return json(res, 400, {error: 'Invalid request'});
    return sendTenancyError(json, res, error);
  }
};

module.exports.USER_RE = USER_RE;
module.exports.WORKSPACE_RE = WORKSPACE_RE;
module.exports.sendTenancyError = sendTenancyError;
