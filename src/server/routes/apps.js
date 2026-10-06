'use strict';
const {agentWorkspaceId} = require('../agent-workspace');

// Apps: the NanoAgent plugin packages the private NanoAgent service publishes,
// and the caller's own agent workspace, where those apps leave their files.
// A prompt for an app goes through /api/ai/stream with an appId and runs on
// that app's NanoAgent agent inside the same workspace (routes/ai.js).
//
// The workspace is private: its id is derived from the caller's own workspace
// membership (agent-workspace.js), so no request can name anyone else's.

// Shown in the browser as themselves; everything else is text or a download.
// Never HTML or SVG, which would run in Mochi's origin.
const INLINE_TYPES = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf'};

function contentTypeFor(path, body) {
  const extension = path.split('.').pop().toLowerCase();
  if (INLINE_TYPES[extension]) return {type: INLINE_TYPES[extension], inline: true};
  const text = !body.includes(0) && Buffer.from(body.toString('utf8'), 'utf8').equals(body);
  return text ? {type: 'text/plain; charset=utf-8', inline: true} : {type: 'application/octet-stream', inline: false};
}

module.exports = async function app_routes(req, res, url, pathname, ctx) {
  if (pathname !== '/api/apps' && pathname !== '/api/agent-files' && pathname !== '/api/agent-files/content') return;
  const {json, requireWorkspacePermission, ai} = ctx;

  if (req.method === 'GET' && pathname === '/api/apps') {
    requireWorkspacePermission(req.context, 'content:read');
    const result = await ai.plugins();
    if (result.error) return json(res, result.status, {error: result.error});
    return json(res, 200, {apps: result.value.plugins});
  }

  const workspace = agentWorkspaceId(req.context);
  if (req.method === 'GET' && pathname === '/api/agent-files') {
    requireWorkspacePermission(req.context, 'content:read');
    const result = await ai.workspaceFiles(workspace);
    if (result.error) return json(res, result.status, {error: result.error});
    return json(res, 200, result.value);
  }

  if (pathname !== '/api/agent-files/content') return;
  const path = url.searchParams.get('path');
  if (!path || path.length > 1000) return json(res, 400, {error: 'path is required'});

  if (req.method === 'GET') {
    requireWorkspacePermission(req.context, 'content:read');
    const result = await ai.workspaceFile(workspace, path);
    if (result.error) return json(res, result.status, {error: result.error});
    const {type, inline: viewable} = contentTypeFor(path, result.value);
    const inline = viewable && url.searchParams.get('download') !== '1';
    const filename = path.split('/').pop().replace(/["\\\r\n]/g, '_');
    const origin = req.headers.origin;
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': result.value.length,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': origin || '*',
      ...(origin ? {'Access-Control-Allow-Credentials': 'true'} : {}),
      'Vary': 'Origin',
    });
    return res.end(result.value);
  }

  if (req.method === 'DELETE') {
    requireWorkspacePermission(req.context, 'content:edit');
    const result = await ai.deleteWorkspaceFile(workspace, path);
    if (result.error) return json(res, result.status, {error: result.error});
    return json(res, 200, {deleted: true});
  }
};
