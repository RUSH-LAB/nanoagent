'use strict';

const {resolveWorkspaceSite} = require('../workspace-site');

/** The refusal for an account that already owns its limit of workspaces, or null. */
async function workspaceLimitRefusal(tenancy, userId) {
  if (!tenancy) return null;
  const {allowed, owned} = await tenancy.workspaceAllowance(userId);
  if (owned < allowed) return null;
  return {
    error: `You can own up to ${allowed} workspace${allowed === 1 ? '' : 's'}. Archive or delete one, or ask an administrator for more.`,
    code: 'workspace-limit-reached',
  };
}

/** User-global workspace discovery and creation. */
module.exports = async function workspace_routes(req, res, url, pathname, ctx) {
  const {
    json, readBody, rateLimit, org, normalizeWorkspaceRole, tenancy,
    requireWorkspacePermission, cleanPendingObjects, workspaceContexts, workspaceSettings,
  } = ctx;
  if (pathname !== '/api/workspaces' && pathname !== '/api/workspace-site' && !pathname.startsWith('/api/workspaces/')) return;

  // ── One workspace and its site, by slug ──
  // Everything the navbar needs to draw a workspace in one round trip: the
  // membership as /api/workspaces lists it, and the site as /site resolves it.
  if (req.method === 'GET' && pathname === '/api/workspace-site') {
    const slug = url.searchParams.get('slug');
    const membership = slug && (await org.listMemberships(req.auth)).find(item => item.slug === slug);
    if (!membership) return json(res, 404, {error: 'Workspace not found'});
    const context = await workspaceContexts.byId(req.auth?.userId, membership.id);
    if (!context) return json(res, 404, {error: 'Workspace not found'});
    requireWorkspacePermission(context, 'content:read');
    return json(res, 200, {
      workspace: {...membership, role: normalizeWorkspaceRole(membership.role)},
      site: resolveWorkspaceSite(await workspaceSettings.get(context)),
    });
  }

  const userId = req.auth?.userId;

  if (req.method === 'GET' && pathname === '/api/workspaces') {
    const workspaces = (await org.listMemberships(req.auth)).map(workspace => ({
      ...workspace,
      role: normalizeWorkspaceRole(workspace.role),
    }));
    return json(res, 200, {
      userId,
      account: req.auth.account,
      workspaces,
      // Navigation preference only; scoped endpoints never authorize from it.
      defaultWorkspaceId: req.auth?.orgId ?? workspaces[0]?.id ?? null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/workspaces') {
    if (!await rateLimit(`workspace-create:${userId}`, 10)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
    const refusal = await workspaceLimitRefusal(tenancy, userId);
    if (refusal) return json(res, 409, refusal);
    try {
      const result = await org.createWorkspace(req.auth, {
        headers: req.headers, name: body.name, slug: body.slug,
      });
      if (result.error === 'invalid-name') return json(res, 400, {error: 'A workspace name is 2 to 60 characters', code: result.error});
      if (result.error === 'invalid-slug') return json(res, 400, {error: 'A short name is 2 to 40 lowercase letters, digits, or inner dashes', code: result.error});
      if (result.error === 'slug-taken') return json(res, 409, {error: 'That short name is taken', code: result.error});
      if (result.error) return json(res, 500, {error: 'The workspace could not be created', code: result.error});
      return json(res, 201, {workspace: {...result.organization, role: 'owner'}, channel: result.channel});
    } catch (error) {
      return json(res, 500, {error: error?.body?.message || 'The workspace could not be created'});
    }
  }

  // ── What this workspace has used against its limits ──
  if (req.method === 'GET' && req.context && req.workspacePath === '/usage') {
    requireWorkspacePermission(req.context, 'content:read');
    if (!tenancy) return json(res, 404, {error: 'Usage limits require PostgreSQL'});
    return json(res, 200, {usage: await tenancy.usage(req.context)});
  }

  // ── Leave it ──
  if (req.method === 'POST' && req.context && req.workspacePath === '/leave') {
    try {
      const result = await org.leaveWorkspace(req.context, {headers: req.headers});
      if (result.error === 'not-found') return json(res, 404, {error: 'Workspace not found'});
      return json(res, 200, {left: true});
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) && error.statusCode < 500 ? error.statusCode : 500;
      return json(res, status === 401 ? 403 : status, {
        error: status < 500 && error?.body?.message ? error.body.message : 'The workspace could not be left',
        ...(error?.body?.code ? {code: error.body.code} : {}),
      });
    }
  }

  if (req.method === 'GET' && req.context && req.workspacePath === '/') {
    const workspace = await org.getOrganization(req.context);
    if (!workspace) return json(res, 404, {error: 'Workspace not found'});
    return json(res, 200, {workspace, you: req.context});
  }

  if (req.method === 'DELETE' && req.context && req.workspacePath === '/') {
    try {
      requireWorkspacePermission(req.context, 'workspace:manage');
      const body = await readBody(req);
      const workspace = await org.getOrganization(req.context);
      if (!workspace) return json(res, 404, {error: 'Workspace not found'});
      if (body?.confirmSlug !== workspace.slug) {
        return json(res, 400, {error: 'Type the workspace slug to confirm', code: 'confirmation-required'});
      }
      const mode = body?.mode ?? 'archive';
      if (!['archive', 'delete'].includes(mode)) return json(res, 400, {error: 'mode must be archive or delete'});
      // Kept in the platform's record, because deleting a workspace deletes its own audit log.
      await tenancy?.recordWorkspaceRemoval(req.context.userId, workspace, mode);
      if (mode === 'archive') await org.archiveWorkspace(req.context);
      else {
        await org.deleteWorkspace(req.context);
        const cleanup = cleanPendingObjects ? await cleanPendingObjects() : {processed: 0, removed: 0, failed: 0};
        if (cleanup.failed) {
          return json(res, 202, {success: true, mode, objectCleanup: cleanup});
        }
      }
      return json(res, 200, {success: true, mode});
    } catch (error) {
      return json(res, error.status || 400, {error: error.message, ...(error.code ? {code: error.code} : {})});
    }
  }
};

module.exports.workspaceLimitRefusal = workspaceLimitRefusal;
