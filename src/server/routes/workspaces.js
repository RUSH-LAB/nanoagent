'use strict';

/** User-global workspace discovery and creation. */
module.exports = async function workspace_routes(req, res, url, pathname, ctx) {
  const {
    json, readBody, rateLimit, org, normalizeWorkspaceRole,
    requireWorkspacePermission, cleanPendingObjects,
  } = ctx;
  if (pathname !== '/api/workspaces' && !pathname.startsWith('/api/workspaces/')) return;

  const userId = req.auth?.userId;

  if (req.method === 'GET' && pathname === '/api/workspaces') {
    const workspaces = (await org.listMemberships(req.auth)).map(workspace => ({
      ...workspace,
      role: normalizeWorkspaceRole(workspace.role),
    }));
    return json(res, 200, {
      userId,
      workspaces,
      // Navigation preference only; scoped endpoints never authorize from it.
      defaultWorkspaceId: req.auth?.orgId ?? workspaces[0]?.id ?? null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/workspaces') {
    if (!rateLimit(`workspace-create:${userId}`, 10)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
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
      if (mode === 'archive') await org.archiveWorkspace(req.context);
      else if (mode === 'delete') {
        await org.deleteWorkspace(req.context);
        const cleanup = cleanPendingObjects ? await cleanPendingObjects() : {processed: 0, removed: 0, failed: 0};
        if (cleanup.failed) {
          return json(res, 202, {success: true, mode, objectCleanup: cleanup});
        }
      }
      else return json(res, 400, {error: 'mode must be archive or delete'});
      return json(res, 200, {success: true, mode});
    } catch (error) {
      return json(res, error.status || 400, {error: error.message, ...(error.code ? {code: error.code} : {})});
    }
  }
};
