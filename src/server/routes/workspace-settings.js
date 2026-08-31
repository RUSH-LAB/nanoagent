'use strict';

module.exports = async function workspace_settings_routes(req, res, _url, _pathname, ctx) {
  if (!req.context) return;
  const {json, readBody, rateLimit, requireWorkspacePermission, workspaceSettings} = ctx;
  const member = req.workspacePath === '/member-preferences';
  if (req.workspacePath !== '/settings' && !member) return;

  try {
    if (req.method === 'GET') {
      requireWorkspacePermission(req.context, 'content:read');
      const settings = member
        ? await workspaceSettings.getMember(req.context)
        : await workspaceSettings.get(req.context);
      return json(res, 200, {settings});
    }
    if (req.method === 'PUT') {
      requireWorkspacePermission(req.context, member ? 'content:read' : 'workspace:manage');
      if (!rateLimit(`workspace-settings:${req.context.workspaceId}:${req.context.userId}`, 30)) {
        return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      }
      const body = await readBody(req);
      const settings = member
        ? await workspaceSettings.updateMember(req.context, body?.settings)
        : await workspaceSettings.update(req.context, body?.settings);
      return json(res, 200, {success: true, settings});
    }
  } catch (error) {
    return json(res, error.status || 400, {error: error.message, ...(error.code ? {code: error.code} : {})});
  }
};
