'use strict';

/**
 * GET /api/traces/export: every trace a member ran in RUSH Lab, as JSON Lines, one line per run (a Harness tab Terminal session, a
 * Harness tab or `nanoagent harness` session, a scored run) and then one per NanoAgent chat of a plugin page (benchmark/export.js for
 * what a line holds). Outside any workspace: `rushlab nanoagent export` and the plugin page's Dashboard both download it.
 *
 *   plugin  only the runs and chats of this plugin
 *   member  whose: absent, the caller's own; a member's id, or `all` for every member, which only a platform administrator may ask,
 *           and only from the CLI (`nanoagent export`, signed in with RUSH Lab's bearer token), never from a page, whose browser
 *           session sends a cookie: the plugin page's Dashboard downloads the member's own traces and nobody else's
 *   since   created at or after this time; until  created before this time
 *
 * Each line is read and written in turn, so the export streams. One that cannot be read ends the response before its end, which the
 * client sees as a broken transfer, never as a shorter export.
 *
 * GET /api/traces/workspaces/<attempt id>: a Terminal session's files, uploaded when it ended, as the tar.zst its export line links
 * (`workspace.url`), to whoever may export its run: its member, or a platform administrator from the CLI (as memberOf). Its chunks are
 * read and written in turn.
 */
const {UUID} = require('../benchmark/http');
const {TRACE_EXPORT_ROUTE} = require('./paths');

class ExportRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function timeOf(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) throw new ExportRequestError(400, `${name} is a timestamp, such as 2026-11-01 or 2026-11-01T09:00:00Z`);
  return new Date(time).toISOString();
}

/**
 * Whose traces the caller asks for: their own id, another member's, or null for every member, which only an administrator may, from
 * the CLI's bearer connection.
 */
async function memberOf(req, url, userId, roles) {
  const raw = url.searchParams.get('member');
  if (raw === null || raw === userId) return userId;
  if (!await roles.isAdmin(userId)) throw new ExportRequestError(403, 'Only platform administrators export other members\' traces');
  if (!/^Bearer\s/i.test(req.headers.authorization ?? '')) {
    throw new ExportRequestError(403, 'Other members\' traces are exported only from the CLI: nanoagent export member=all');
  }
  return raw === 'all' ? null : raw;
}

/** Write `data` (bytes, or a line as JSON), waiting for the socket to take what it holds first (or the client to leave). */
async function write(res, data) {
  if (res.write(Buffer.isBuffer(data) ? data : `${JSON.stringify(data)}\n`)) return;
  await new Promise(resolve => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

const WORKSPACES = '/api/traces/workspaces/';

async function workspaceDownload(req, res, json, traces, userId, attemptId) {
  const found = UUID.test(attemptId) ? await traces.workspace(userId, attemptId) : null;
  if (!found) return json(res, 404, {error: 'No uploaded files of that session for you to read'});
  if (found.member !== userId && !/^Bearer\s/i.test(req.headers.authorization ?? '')) {
    return json(res, 403, {error: 'Other members\' files are downloaded only from the CLI\'s connection, as nanoagent export member=all is'});
  }
  const {workspace} = found;
  res.writeHead(200, {
    'Content-Type': 'application/zstd', 'Content-Length': workspace.bytes, 'Content-Disposition': `attachment; filename="workspace-${attemptId}.tar.zst"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  });
  req.setTimeout(0);
  let closed = false;
  res.on('close', () => { closed = true; });
  try {
    for (const chunk of workspace.chunks) {
      if (closed) return;
      await write(res, await traces.workspaceChunk(userId, attemptId, chunk));
    }
    res.end();
  } catch (error) {
    console.error('[traces] workspace download failed:', error);
    res.destroy(error);
  }
}

module.exports = async function traceExport(req, res, url, pathname, ctx) {
  if (!TRACE_EXPORT_ROUTE.test(pathname)) return undefined;
  const {json, roles, traceExport: traces} = ctx;
  if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
  if (!req.auth?.userId) return json(res, 401, {error: 'Not signed in'});
  if (!traces) return json(res, 503, {error: 'The trace export needs PostgreSQL (DATABASE_URL)'});
  const {userId} = req.auth;
  if (pathname.startsWith(WORKSPACES)) return workspaceDownload(req, res, json, traces, userId, pathname.slice(WORKSPACES.length));
  let filter;
  try {
    filter = {member: await memberOf(req, url, userId, roles), plugin: url.searchParams.get('plugin'), since: timeOf(url, 'since'), until: timeOf(url, 'until')};
  } catch (error) {
    if (error instanceof ExportRequestError) return json(res, error.status, {error: error.message});
    throw error;
  }
  const runIds = await traces.runIds(userId, filter);
  const chats = await traces.chats(userId, filter);
  const name = `traces${filter.plugin ? `-${filter.plugin.replace(/[^\w.-]/g, '_')}` : ''}.jsonl`;
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  });
  req.setTimeout(0);
  let closed = false;
  res.on('close', () => { closed = true; });
  try {
    for (const runId of runIds) {
      if (closed) return;
      await write(res, await traces.runLine(userId, runId));
    }
    for (const chat of chats) {
      if (closed) return;
      await write(res, await traces.chatLine(chat));
    }
    res.end();
  } catch (error) {
    console.error('[traces] export failed:', error);
    res.destroy(error);
  }
};
