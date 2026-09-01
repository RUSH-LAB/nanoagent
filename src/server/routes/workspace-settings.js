'use strict';

const {resolveWorkspaceSite, validateWorkspaceSite} = require('../workspace-site');

module.exports = async function workspace_settings_routes(req, res, _url, _pathname, ctx) {
  if (!req.context) return;
  const {
    json, readBody, rateLimit, requireWorkspacePermission, workspaceSettings,
    documents, scopeFor,
  } = ctx;
  const member = req.workspacePath === '/member-preferences';
  const site = req.workspacePath === '/site';
  if (req.workspacePath !== '/settings' && !member && !site) return;

  try {
    if (req.method === 'GET') {
      requireWorkspacePermission(req.context, 'content:read');
      if (site) {
        const [settings, rows] = await Promise.all([
          workspaceSettings.get(req.context),
          documents.list(scopeFor(req)),
        ]);
        return json(res, 200, {site: resolveWorkspaceSite(settings, rows)});
      }
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
      if (site) {
        const checked = validateWorkspaceSite(body?.site);
        const settings = await workspaceSettings.update(req.context, checked);
        const rows = await documents.list(scopeFor(req));
        return json(res, 200, {success: true, site: resolveWorkspaceSite(settings, rows)});
      }
      const settings = member
        ? await workspaceSettings.updateMember(req.context, body?.settings)
        : await workspaceSettings.update(req.context, body?.settings);
      return json(res, 200, {success: true, settings});
    }
  } catch (error) {
    return json(res, error.status || 400, {error: error.message, ...(error.code ? {code: error.code} : {})});
  }
};
