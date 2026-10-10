'use strict';
const {APPS_NEED_FS, corsHeaders} = require('./ai');
const {agentFolder, prepareHome} = require('../fs/agent-sync');
const {FsError} = require('../fs/store');
const {budgetRefusal} = require('../ai-metering');

// Apps: the NanoAgent plugin packages the private NanoAgent service publishes,
// and the caller's own agent folder, `home/<user>/agent/` in the workspace file
// system, where those apps leave their files and the app pages list, read and
// save them.
// Each app's own page (its ui/ folder) is served from /api/apps/{id}/ui/{uiVersion}/ and
// shown in a sandboxed frame (src/components/PluginFrame), which runs the app's
// tasks through /api/apps/{id}/tasks/{task}/runs. A prompt for an app goes
// through /api/ai/stream with an appId and runs on that app's NanoAgent agent
// inside the same workspace (routes/ai.js).
//
// The folder is private: its path comes from the caller's own identity, so no
// request can name anyone else's. Each run works on a copy of it in a scratch
// folder of NanoAgent's own (fs/agent-sync.js).

// Shown in the browser as themselves; everything else is text or a download.
// Never HTML or SVG, which would run in Mochi's origin.
const INLINE_TYPES = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf'};

function contentTypeFor(path, body) {
  const extension = path.split('.').pop().toLowerCase();
  if (INLINE_TYPES[extension]) return {type: INLINE_TYPES[extension], inline: true};
  const text = !body.includes(0) && Buffer.from(body.toString('utf8'), 'utf8').equals(body);
  return text ? {type: 'text/plain; charset=utf-8', inline: true} : {type: 'application/octet-stream', inline: false};
}

const ROUTES = new Set(['/api/apps', '/api/agent-files', '/api/agent-files/content']);
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UI_ROUTE = /^\/api\/apps\/([^/]+)\/ui\/([^/]+)\/(.+)$/;
const UI_VERSION = /^[0-9a-f]{16}$/;
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
 * off the network, goes with every file; a file without one is refused. The
 * path names the ui/ folder's version, so NanoAgent lets browsers keep each
 * file forever, and a plugin opened again loads without a request.
 */
async function serveUiFile(res, json, ai, app, version, raw) {
  const path = uiFilePath(raw);
  if (!PLUGIN_ID.test(app) || !UI_VERSION.test(version) || !path) return json(res, 404, {error: 'Not found'});
  const result = await ai.pluginUiFile(app, version, path);
  if (result.error) return json(res, result.status, {error: result.error});
  const type = result.headers.get('content-type');
  const policy = result.headers.get('content-security-policy');
  const caching = result.headers.get('cache-control');
  if (!type || !policy || !caching) {
    return json(res, 502, {error: 'NanoAgent sent a plugin page without its content type, Content-Security-Policy or Cache-Control'});
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': result.value.length,
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': caching,
    'Access-Control-Allow-Origin': '*',
  });
  return res.end(result.value);
}

/**
 * One task run on the caller's own agent folder, NanoAgent's `task.*`
 * events passed through as they arrive. A caller who hangs up cancels the run.
 */
async function streamTaskRun(req, res, ctx, app, task) {
  const {json, readBody, requireWorkspacePermission, ai, aiMeter, CORS_ORIGIN} = ctx;
  // A task acts through the app's tools, which is editing, not reading.
  requireWorkspacePermission(req.context, 'content:edit');
  try {
    await aiMeter.assertAllowed(req.context);
  } catch (error) {
    const refusal = budgetRefusal(error);
    if (refusal) return json(res, refusal.status, refusal.body);
    throw error;
  }
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

  if (!ctx.agentSync) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
  const controller = new AbortController();
  const onClose = () => controller.abort();
  // The run itself, which leaves the response open: the stream ends only after
  // the run's files are written back (below), so a page that reloads its files
  // on task.done finds them.
  const runTask = async workspace => {
    res.on('close', onClose);
    try {
      const result = await ai.taskRun({workspace, app, task, args, signal: controller.signal});
      if (result.error) return json(res, result.status, {error: result.error});
      // A task run's events carry no price, so it is charged at NanoAgent's per-run cap.
      await aiMeter.record(req.context, 'task', null, {ran: true});
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
      return undefined;
    } finally {
      res.off('close', onClose);
    }
  };

  // The run works on a copy of the member's agent folder, and its results are
  // written back there (fs/agent-sync.js).
  try {
    await ctx.agentSync.run(req.context, runTask);
  } catch (error) {
    if (!res.headersSent) return json(res, error.status || 502, {error: error.message});
    console.error('[apps] The run finished but its files could not be written back:', error);
  }
  // Ended here, after the stream, because the dispatcher decides a handler
  // answered by res.writableEnded (see routes/ai.js).
  if (!res.writableEnded) res.end();
  return undefined;
}

module.exports = async function app_routes(req, res, url, pathname, ctx) {
  const {json, readRawBody, requireWorkspacePermission, ai} = ctx;
  const ui = UI_ROUTE.exec(pathname);
  if (ui && req.method === 'GET') return serveUiFile(res, json, ai, ui[1], ui[2], ui[3]);
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

  if (req.method === 'GET' && pathname === '/api/apps') {
    requireWorkspacePermission(req.context, 'content:read');
    const result = await ai.plugins();
    if (result.error) return json(res, result.status, {error: result.error});
    return json(res, 200, {apps: result.value.plugins});
  }

  const fs = ctx.workspaceFs;
  if (!fs) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
  const scope = req.context;
  const folder = agentFolder(scope);
  if (req.method === 'GET' && pathname === '/api/agent-files') {
    requireWorkspacePermission(scope, 'content:read');
    const files = (await fs.list(scope, {prefix: folder})).filter(node => node.kind === 'file');
    return json(res, 200, {files: files.map(node => ({path: node.path.slice(folder.length + 1), size: node.size}))});
  }

  const path = url.searchParams.get('path');
  if (!path || path.length > 1000) return json(res, 400, {error: 'path is required'});
  if (pathname !== '/api/agent-files/content') return;

  try {
    if (req.method === 'PUT') {
      requireWorkspacePermission(scope, 'content:edit');
      let body;
      try {
        body = await readRawBody(req);
      } catch {
        return json(res, 413, {error: 'File is too large'});
      }
      await prepareHome(fs, scope);
      const create = url.searchParams.get('create') === '1';
      const node = await fs.write(scope, `${folder}/${path}`, body, create ? {baseRev: 0} : {});
      return json(res, 200, {path, size: node.size});
    }

    if (req.method === 'GET') {
      requireWorkspacePermission(scope, 'content:read');
      const found = await fs.read(scope, `${folder}/${path}`);
      if (!found) return json(res, 404, {error: 'file not found'});
      const {type, inline: viewable} = contentTypeFor(path, found.body);
      const inline = viewable && url.searchParams.get('download') !== '1';
      const filename = path.split('/').pop().replace(/["\\\r\n]/g, '_');
      const origin = req.headers.origin;
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': found.body.length,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': origin || '*',
        ...(origin ? {'Access-Control-Allow-Credentials': 'true'} : {}),
        'Vary': 'Origin',
      });
      return res.end(found.body);
    }
  } catch (error) {
    if (error instanceof FsError) return json(res, error.status, {error: error.message, code: error.code});
    throw error;
  }
  return undefined;
};
