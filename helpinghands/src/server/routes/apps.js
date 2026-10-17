'use strict';
const {APPS_NEED_FS, followRun, openEventStream} = require('./ai');
const {agentFolder} = require('../fs/agent-sync');
const {FsError} = require('../fs/store');
const {RUNNER_OFFLINE} = require('../ai');

// Apps: the marketplace plugins a member installed (workspace-apps.js), which
// they install, tag and uninstall at /api/apps/{id}, and the caller's own folder
// for each app, `home/<user>/agent/<app>/` in the workspace file system, where
// that app leaves its files (/api/agent-files?plugin=<app>).
// Opening an app (GET /api/apps/{id}) has the NanoAgent on the member's own
// computer install its package, by sha256; its own page (its ui/ folder) comes
// from that computer too, at /api/apps/{sha256}/ui/{page}/{uiVersion}/ (`page`
// names the computer's connection, server/runner.js), and is
// shown in a sandboxed frame (src/components/PluginFrame). A prompt for an app
// goes through /api/ai/stream with an appId and runs on that app's NanoAgent
// agent inside the same workspace (routes/ai.js).
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

const ROUTES = new Set(['/api/apps', '/api/app-installs', '/api/agent-files', '/api/agent-files/content']);
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APP_ROUTE = /^\/api\/apps\/([^/]+)$/;
const UI_ROUTE = /^\/api\/apps\/([^/]+)\/ui\/([^/]+)\/([^/]+)\/(.+)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UI_VERSION = /^[0-9a-f]{16}$/;
const SESSIONS_ROUTE = /^\/api\/apps\/([^/]+)\/sessions(?:\/([^/]+)(\/run)?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 * `null`, hence `*`. So it comes from the computer the path's `page` names: the
 * one that opened the plugin. NanoAgent's Content-Security-Policy, which keeps
 * the page off the network, goes with every file; a file without one is
 * refused. The path names the ui/ folder's version, so NanoAgent lets browsers
 * keep each file forever, and a plugin opened again loads without a request.
 */
async function serveUiFile(res, json, runners, sha256, page, version, raw) {
  const path = uiFilePath(raw);
  if (!SHA256.test(sha256) || !UUID.test(page) || !UI_VERSION.test(version) || !path) return json(res, 404, {error: 'Not found'});
  const computer = runners.byPage(page);
  if (!computer) return json(res, 503, {error: 'The RUSH Lab that opened this plugin is not connected any more. Open the plugin again.'});
  const result = await computer.installUiFile(sha256, version, path);
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
 * The caller's sessions with one app (postgres/sessions.js): list and start
 * them, read one back with every call it made, and archive or restore one
 * (PATCH `{archived}`). A session still answering a message says so, `running`
 * (its message, `{prompt}`, when read back), and its run is followed at `/run`,
 * every event so far and then each as it comes, and cancelled by DELETE there.
 */
async function sessionRoute(req, res, ctx, app, id, run) {
  const {json, requireWorkspacePermission} = ctx;
  if (!PLUGIN_ID.test(app) || (id !== null && !UUID.test(id))) return json(res, 404, {error: 'Not found'});
  if (!ctx.sessions || !ctx.appRuns) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
  try {
    if (run) {
      requireWorkspacePermission(req.context, 'apps:use');
      await ctx.appRuns.settle(req.context);
      if (!(await ctx.sessions.get(req.context, app, id)).running) {
        return json(res, 404, {error: 'This session is not answering a message any more. Open it again to see its answer.'});
      }
      if (req.method === 'GET') {
        openEventStream(req, res, ctx.CORS_ORIGIN);
        return await followRun(res, (onEvent, onEnd) => ctx.appRuns.subscribe(id, onEvent, onEnd));
      }
      if (req.method === 'DELETE') {
        await ctx.appRuns.cancel(req.context, id);
        return json(res, 200, {cancelled: id});
      }
      return json(res, 405, {error: 'Method not allowed'});
    }
    if (id === null && req.method === 'GET') {
      requireWorkspacePermission(req.context, 'content:read');
      await ctx.appRuns.settle(req.context);
      return json(res, 200, {sessions: await ctx.sessions.list(req.context, app)});
    }
    if (id === null && req.method === 'POST') {
      requireWorkspacePermission(req.context, 'apps:use');
      return json(res, 200, {session: await ctx.sessions.create(req.context, app)});
    }
    if (id !== null && req.method === 'GET') {
      requireWorkspacePermission(req.context, 'content:read');
      await ctx.appRuns.settle(req.context);
      return json(res, 200, {session: await ctx.sessions.get(req.context, app, id)});
    }
    if (id !== null && req.method === 'PATCH') {
      requireWorkspacePermission(req.context, 'apps:use');
      const body = await ctx.readBody(req).catch(() => null);
      if (typeof body?.archived !== 'boolean') return json(res, 400, {error: 'Request body must be {"archived": true} or {"archived": false}'});
      return json(res, 200, {session: await ctx.sessions.archive(req.context, app, id, body.archived)});
    }
  } catch (error) {
    if (error.name === 'SessionError') return json(res, error.status, {error: error.message});
    throw error;
  }
  return json(res, 405, {error: 'Method not allowed'});
}

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

/** `body.tags` trimmed and without repeats, or null for anything but a short list of short names. */
function tagsOf(body) {
  if (!Array.isArray(body?.tags) || body.tags.length > MAX_TAGS) return null;
  const tags = body.tags.map(tag => (typeof tag === 'string' ? tag.trim() : ''));
  if (tags.some(tag => !tag || tag.length > MAX_TAG_LENGTH)) return null;
  return [...new Set(tags)];
}

/**
 * One of the caller's apps: GET opens it, installed and ready to run on the
 * member's own computer, with the `computer` page id its page is served by; PUT
 * installs the marketplace plugin of that id, PATCH replaces the tags the
 * caller files it under (`{tags}`) or for an upload the version it stays on
 * (`{version}`, null to follow the latest), and DELETE uninstalls it. Each is
 * the member's own to do, in any role: an install is theirs, not the workspace's.
 */
async function appRoute(req, res, ctx, id) {
  const {json, readBody, requireWorkspacePermission, workspaceApps} = ctx;
  if (!PLUGIN_ID.test(id)) return json(res, 404, {error: `No plugin named ${id}`});
  if (!workspaceApps) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
  if (req.method === 'GET') {
    requireWorkspacePermission(req.context, 'content:read');
    const computer = ctx.runners.computer(req.context.userId);
    if (!computer) return json(res, 503, {error: RUNNER_OFFLINE});
    const page = ctx.runners.page(req.context.userId);
    const opened = await workspaceApps.open(req.context, id, computer);
    return opened.error ? json(res, opened.status, {error: opened.error}) : json(res, 200, {app: {...opened.value, computer: page}});
  }
  if (req.method === 'PUT') {
    requireWorkspacePermission(req.context, 'apps:use');
    const added = await workspaceApps.add(req.context, id);
    return added.error ? json(res, added.status, {error: added.error}) : json(res, 200, {app: added.value});
  }
  if (req.method === 'PATCH') {
    requireWorkspacePermission(req.context, 'apps:use');
    let body;
    try {
      body = await readBody(req);
    } catch {
      body = null;
    }
    if (body && 'version' in body) {
      if (body.version !== null && (typeof body.version !== 'string' || !body.version || body.version.length > 64)) {
        return json(res, 400, {error: 'Request body must be {"version": "<a published version>"} or {"version": null}'});
      }
      const pinned = await workspaceApps.pin(req.context, id, body.version);
      return pinned.error ? json(res, pinned.status, {error: pinned.error}) : json(res, 200, {app: pinned.value});
    }
    const tags = tagsOf(body);
    if (!tags) {
      return json(res, 400, {error: `Request body must be {"tags": [...]} (at most ${MAX_TAGS} names, each 1 to ${MAX_TAG_LENGTH} characters) or {"version": …}`});
    }
    if (!await workspaceApps.tag(req.context, id, tags)) return json(res, 404, {error: `You have not installed a plugin named ${id}`});
    return json(res, 200, {tags});
  }
  if (req.method === 'DELETE') {
    requireWorkspacePermission(req.context, 'apps:use');
    if (!await workspaceApps.remove(req.context, id)) return json(res, 404, {error: `You have not installed a plugin named ${id}`});
    return json(res, 200, {removed: id});
  }
  return json(res, 405, {error: 'Method not allowed'});
}

module.exports = async function app_routes(req, res, url, pathname, ctx) {
  const {json, readRawBody, requireWorkspacePermission} = ctx;
  const ui = UI_ROUTE.exec(pathname);
  if (ui && req.method === 'GET') return serveUiFile(res, json, ctx.runners, ui[1], ui[2], ui[3], ui[4]);
  const sessions = SESSIONS_ROUTE.exec(pathname);
  if (sessions) return sessionRoute(req, res, ctx, sessions[1], sessions[2] ?? null, Boolean(sessions[3]));
  const app = APP_ROUTE.exec(pathname);
  if (app) return appRoute(req, res, ctx, app[1]);
  if (!ROUTES.has(pathname)) return;

  if (req.method === 'GET' && pathname === '/api/apps') {
    requireWorkspacePermission(req.context, 'content:read');
    if (!ctx.workspaceApps) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
    const result = await ctx.workspaceApps.list(req.context);
    if (result.error) return json(res, result.status, {error: result.error});
    return json(res, 200, {apps: result.value});
  }

  // Entering a workspace installs the member's apps ahead of the first open, on
  // their computer, where their pages and runs are. Answered at once; an
  // install that fails is logged, and opening that app reports it.
  if (req.method === 'POST' && pathname === '/api/app-installs') {
    requireWorkspacePermission(req.context, 'content:read');
    if (!ctx.workspaceApps) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
    const computer = ctx.runners.computer(req.context.userId);
    if (!computer) return json(res, 503, {error: RUNNER_OFFLINE});
    ctx.workspaceApps.prepare(req.context, computer).then(
      result => {
        for (const failed of result.error ? [result] : result.value.filter(app => app.error)) {
          console.error(`[apps] preparing ${failed.id ?? 'the member\'s apps'} failed: ${failed.error}`);
        }
      },
      error => console.error('[apps] preparing the member\'s apps failed:', error),
    );
    return json(res, 202, {preparing: true});
  }

  const fs = ctx.workspaceFs;
  if (!fs) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
  const scope = req.context;
  const plugin = url.searchParams.get('plugin');
  if (!plugin || !PLUGIN_ID.test(plugin)) return json(res, 400, {error: 'plugin is required'});
  const folder = agentFolder(scope, plugin);
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
      requireWorkspacePermission(scope, 'apps:use');
      let body;
      try {
        body = await readRawBody(req);
      } catch {
        return json(res, 413, {error: 'File is too large'});
      }
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
