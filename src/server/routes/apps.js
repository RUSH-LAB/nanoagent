'use strict';
const {agentWorkspaceId} = require('../agent-workspace');
const {corsHeaders} = require('./ai');

// Apps: the NanoAgent plugin packages the private NanoAgent service publishes,
// and the caller's own agent workspace, where those apps leave their files and
// the caller manages them: list, read, save, delete, folders, moves.
// Each app's own page (its ui/ folder) is served from /api/apps/{id}/ui/ and
// shown in a sandboxed frame (src/components/PluginFrame), which runs the app's
// tasks through /api/apps/{id}/tasks/{task}/runs. A prompt for an app goes
// through /api/ai/stream with an appId and runs on that app's NanoAgent agent
// inside the same workspace (routes/ai.js).
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

const ROUTES = new Set(['/api/apps', '/api/agent-files', '/api/agent-files/content', '/api/agent-files/folder', '/api/agent-files/move']);
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UI_ROUTE = /^\/api\/apps\/([^/]+)\/ui\/(.+)$/;
const TASK_RUN_ROUTE = /^\/api\/apps\/([^/]+)\/tasks\/([^/]+)\/runs$/;

/**
 * The file a plugin page asks for, as decoded '/'-joined segments, or null for
 * a path that is malformed or could step outside the plugin's ui/ folder.
 */
function uiFilePath(raw) {
  const segments = [];
  for (const part of raw.split('/')) {
    let segment;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!segment || segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * A plugin's page and its files. Public, like any published asset: the page
 * runs in a sandboxed frame with an opaque origin, so its own requests carry no
 * session, and module scripts and fonts are fetched with CORS from origin
 * `null`, hence `*`. NanoAgent's Content-Security-Policy, which keeps the page
 * off the network, goes with every file; a file without one is refused.
 */
async function serveUiFile(res, json, ai, app, raw) {
  const path = uiFilePath(raw);
  if (!PLUGIN_ID.test(app) || !path) return json(res, 404, {error: 'Not found'});
  const result = await ai.pluginUiFile(app, path);
  if (result.error) return json(res, result.status, {error: result.error});
  const type = result.headers.get('content-type');
  const policy = result.headers.get('content-security-policy');
  if (!type || !policy) return json(res, 502, {error: 'NanoAgent sent a plugin page without its content type or Content-Security-Policy'});
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': result.value.length,
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  return res.end(result.value);
}

/**
 * One task run in the caller's own agent workspace, NanoAgent's `task.*`
 * events passed through as they arrive. A caller who hangs up cancels the run.
 */
async function streamTaskRun(req, res, ctx, app, task) {
  const {json, readBody, requireWorkspacePermission, ai, CORS_ORIGIN} = ctx;
  // A task acts through the app's tools, which is editing, not reading.
  requireWorkspacePermission(req.context, 'content:edit');
  if (!PLUGIN_ID.test(app)) return json(res, 404, {error: `No app named ${app}`});
  if (!task || task.length > 100) return json(res, 400, {error: 'task must be a task id'});
  let body;
  try {
    body = await readBody(req);
  } catch {
    body = null;
  }
  const args = body?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return json(res, 400, {error: 'Request body must be {"arguments": {...}}'});
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);
  try {
    const result = await ai.taskRun({workspace: agentWorkspaceId(req.context), app, task, args, signal: controller.signal});
    if (result.error) return json(res, result.status, {error: result.error});
    res.writeHead(200, {
      ...corsHeaders(req, CORS_ORIGIN),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // NanoAgent's heartbeats pass through too, keeping the connection inside
    // the idle limit server/index.js sets.
    const reader = result.value.getReader();
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done || res.writableEnded || res.destroyed) break;
        res.write(Buffer.from(value));
      }
    } catch {
      // The caller hung up or NanoAgent dropped the stream; either way it ends
      // here, and the page sees a run that stopped before task.done.
    } finally {
      reader.releaseLock();
    }
    // Dropped before ending, which emits the same 'close'; ended here, after the
    // stream, because the dispatcher decides a handler answered by
    // res.writableEnded (see routes/ai.js).
    res.off('close', onClose);
    return res.end();
  } finally {
    res.off('close', onClose);
  }
}

module.exports = async function app_routes(req, res, url, pathname, ctx) {
  const {json, readBody, readRawBody, requireWorkspacePermission, ai} = ctx;
  const ui = UI_ROUTE.exec(pathname);
  if (ui && req.method === 'GET') return serveUiFile(res, json, ai, ui[1], ui[2]);
  const taskRun = TASK_RUN_ROUTE.exec(pathname);
  if (taskRun && req.method === 'POST') {
    let task;
    try {
      task = decodeURIComponent(taskRun[2]);
    } catch {
      return json(res, 400, {error: 'task must be a task id'});
    }
    return streamTaskRun(req, res, ctx, taskRun[1], task);
  }
  if (!ROUTES.has(pathname)) return;
  const reply = (result, value = result.value) => (result.error
    ? json(res, result.status, {error: result.error})
    : json(res, 200, value));

  if (req.method === 'GET' && pathname === '/api/apps') {
    requireWorkspacePermission(req.context, 'content:read');
    const result = await ai.plugins();
    if (result.error) return json(res, result.status, {error: result.error});
    return json(res, 200, {apps: result.value.plugins});
  }

  const workspace = agentWorkspaceId(req.context);
  if (req.method === 'GET' && pathname === '/api/agent-files') {
    requireWorkspacePermission(req.context, 'content:read');
    return reply(await ai.workspaceFiles(workspace));
  }

  if (req.method === 'POST' && pathname === '/api/agent-files/move') {
    requireWorkspacePermission(req.context, 'content:edit');
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Request body must be {"from": path, "to": path}'});
    }
    if (typeof body?.from !== 'string' || typeof body?.to !== 'string') {
      return json(res, 400, {error: 'Request body must be {"from": path, "to": path}'});
    }
    return reply(await ai.moveWorkspaceEntry(workspace, body.from, body.to));
  }

  const path = url.searchParams.get('path');
  if (!path || path.length > 1000) return json(res, 400, {error: 'path is required'});

  if (pathname === '/api/agent-files/folder') {
    if (req.method !== 'POST' && req.method !== 'DELETE') return;
    requireWorkspacePermission(req.context, 'content:edit');
    return reply(req.method === 'POST'
      ? await ai.makeWorkspaceFolder(workspace, path)
      : await ai.deleteWorkspaceFolder(workspace, path));
  }

  if (pathname !== '/api/agent-files/content') return;

  if (req.method === 'PUT') {
    requireWorkspacePermission(req.context, 'content:edit');
    let body;
    try {
      body = await readRawBody(req);
    } catch {
      return json(res, 413, {error: 'File is too large'});
    }
    // A large save can outlast the 30 s idle limit server/index.js sets; ai.js bounds the wait.
    req.setTimeout(0);
    return reply(await ai.saveWorkspaceFile(workspace, path, body, {create: url.searchParams.get('create') === '1'}));
  }

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
    return reply(await ai.deleteWorkspaceFile(workspace, path));
  }
};
