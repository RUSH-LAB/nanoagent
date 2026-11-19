'use strict';

/**
 * GET /api/traces/export: every trace a member ran in RUSH Lab, as JSON Lines, one line per run (a Harness tab Terminal session, a
 * Harness tab or `nanoagent harness` session, a scored run) and then one per NanoAgent chat of a plugin page (benchmark/export.js for
 * what a line holds). Outside any workspace: `rushlab nanoagent export` and the plugin page's Dashboard both download it.
 *
 *   plugin  only the runs and chats of this plugin
 *   member  whose: absent, the caller's own; a member's id, or `all` for every member, which only a platform administrator may ask
 *   since   created at or after this time; until  created before this time
 *
 * Each line is read and written in turn, so the export streams. One that cannot be read ends the response before its end, which the
 * client sees as a broken transfer, never as a shorter export.
 */
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

/** Whose traces the caller asks for: their own id, another member's, or null for every member, which only an administrator may. */
async function memberOf(url, userId, roles) {
  const raw = url.searchParams.get('member');
  if (raw === null || raw === userId) return userId;
  if (!await roles.isAdmin(userId)) throw new ExportRequestError(403, 'Only platform administrators export other members\' traces');
  return raw === 'all' ? null : raw;
}

/** Write one line, waiting for the socket to take what it holds first (or the client to leave). */
async function write(res, line) {
  if (res.write(`${JSON.stringify(line)}\n`)) return;
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

module.exports = async function traceExport(req, res, url, pathname, ctx) {
  if (!TRACE_EXPORT_ROUTE.test(pathname)) return undefined;
  const {json, roles, traceExport: traces} = ctx;
  if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
  if (!req.auth?.userId) return json(res, 401, {error: 'Not signed in'});
  if (!traces) return json(res, 503, {error: 'The trace export needs PostgreSQL (DATABASE_URL)'});
  const {userId} = req.auth;
  let filter;
  try {
    filter = {member: await memberOf(url, userId, roles), plugin: url.searchParams.get('plugin'), since: timeOf(url, 'since'), until: timeOf(url, 'until')};
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
