'use strict';

/**
 * The workspace file system API (docs/plans/workspace-filesystem.md), for
 * members, at /api/workspaces/:id/fs/…:
 *
 *   GET    tree?prefix=&deleted=1     nodes, without contents
 *   GET    stat?path=                 one node
 *   GET    file?path= | ?id=          the bytes; the node's rev is the ETag; &download=1 to save it
 *   PUT    file?path=&baseRev=        create or replace; baseRev=0 means "must not exist"
 *   POST   folder?path=               create a folder and any missing parents
 *   POST   move {from, to, baseRev}
 *   DELETE node?path=&baseRev=        to the trash, with everything inside
 *   POST   restore {id}
 *   DELETE trash                      empty the trash
 *   PUT    access {path, access, members}
 *                                     workspace, private, shared (with `members`), public, or null to inherit
 *   GET    share?path=                who a shared node is shared with
 *   GET    history?path=              every revision, newest first
 *   GET    revision?path=&seq=        the bytes of one revision
 *   GET    changes?since=&limit=      the change feed sync clients follow, and catch up from after a reconnect
 *   GET    search?q=&case=1&word=1    the lines of text files that have `q` (fs/textSearch.js), by file:
 *                                     {files: [{path, rev, matches: [{line, column, length, preview}]}], truncated}
 *   GET    events                     the workspace's push channel (fs/events.js), server-sent events:
 *                                     `ready` {stream, cursor}, then `changes` {cursor, structural, changes}
 *                                     batches and `update` {nodeId, update, rev} for the files it follows
 *
 * Markdown files are mergeable (fs/crdt.js):
 *
 *   GET    crdt?path=&stream=         the Yjs document as one update; X-Rev is its revision.
 *                                     With `stream`, that event stream receives its updates from now on
 *   POST   crdt?path=                 apply an editor's Yjs update; the merged text is a new revision
 *   DELETE follow?stream=&node=       stop sending a stream a file's updates
 */
const {lineMatches} = require('../fs/textSearch');

const ROUTE = /^\/api\/fs\/(tree|stat|file|folder|move|node|restore|trash|access|share|history|revision|changes|events|crdt|follow|search)$/;
const HEARTBEAT_MS = 25_000;
// A search reads text files up to the size the workbench edits (EDIT_LIMIT in components/Workbench),
// and answers with at most this many matches, longest lines cut to PREVIEW_LENGTH around their match.
const SEARCH_FILE_LIMIT = 2 * 1024 * 1024;
const SEARCH_MATCH_LIMIT = 2000;
const PREVIEW_LENGTH = 240;

function fail(json, res, error) {
  if (error?.status && error?.code) {
    return json(res, error.status, {
      error: error.message, code: error.code, ...(error.currentRev !== undefined ? {currentRev: error.currentRev} : {}),
    });
  }
  // Row-level security refused the write: the caller may not change this.
  if (error?.code === '42501') return json(res, 403, {error: 'You may not change this', code: 'forbidden'});
  throw error;
}

function sendBytes(req, res, {body, contentType, etag, filename, download = false}) {
  const origin = req.headers.origin;
  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': body.length,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
    'Cache-Control': 'private, no-cache',
    'ETag': `"${etag}"`,
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': origin || '*',
    ...(origin ? {'Access-Control-Allow-Credentials': 'true'} : {}),
    'Access-Control-Expose-Headers': 'ETag, X-Node-Id, X-Rev',
    'Vary': 'Origin',
  });
  res.end(body);
}

/** A match with its line cut to PREVIEW_LENGTH around it, `column` then counted in what is kept, `cut` how much went before. */
function preview(match) {
  if (match.preview.length <= PREVIEW_LENGTH) return {...match, cut: 0};
  const cut = Math.max(0, Math.min(match.column - 1 - 40, match.preview.length - PREVIEW_LENGTH));
  return {...match, preview: match.preview.slice(cut, cut + PREVIEW_LENGTH), cut};
}

module.exports = async function fs_routes(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match || !req.context) return;
  const {
    json, readBody, readRawBody, requireWorkspacePermission, workspaceFs: fs, crdt, fsHub, invalidateCache, cacheKey, CORS_ORIGIN,
  } = ctx;
  if (!fs) {
    return json(res, 409, {
      error: 'The workspace file system needs PostgreSQL (DATABASE_URL)', code: 'fs-disabled',
    });
  }
  const scope = req.context;
  const action = match[1];
  const param = name => url.searchParams.get(name);
  const changed = () => invalidateCache?.(cacheKey(scope.workspaceId, ''));
  const permit = permission => requireWorkspacePermission(scope, permission);

  try {
    if (req.method === 'GET' && action === 'tree') {
      permit('content:read');
      const nodes = param('deleted') === '1'
        ? await fs.trash(scope)
        : await fs.list(scope, {prefix: param('prefix')});
      return json(res, 200, {nodes});
    }

    if (req.method === 'GET' && action === 'stat') {
      permit('content:read');
      const node = await fs.stat(scope, param('path'));
      return node ? json(res, 200, {node}) : json(res, 404, {error: 'Not found', code: 'not-found'});
    }

    if (req.method === 'GET' && action === 'file') {
      permit('content:read');
      const found = param('id') ? await fs.readById(scope, param('id')) : await fs.read(scope, param('path'));
      if (!found) return json(res, 404, {error: 'Not found', code: 'not-found'});
      res.setHeader('X-Node-Id', found.node.id);
      res.setHeader('X-Rev', String(found.node.rev));
      return sendBytes(req, res, {
        body: found.body, contentType: found.node.contentType, etag: found.node.rev,
        filename: found.node.path.split('/').pop(), download: param('download') === '1',
      });
    }

    if (req.method === 'PUT' && action === 'file') {
      permit('content:edit');
      const body = await readRawBody(req);
      const baseRev = param('baseRev');
      const node = await fs.write(scope, param('path'), body, {
        ...(baseRev === null ? {} : {baseRev: Number(baseRev)}),
      });
      changed();
      // Anyone editing this file live sees the plain write as a change too.
      if (crdt && fsHub.followed(scope.workspaceId, node.id) && /\.mdx?$/i.test(node.path)) {
        fsHub.broadcast(scope.workspaceId, node.id, (await crdt.state(scope, node.path)).changes, node.rev);
      }
      return json(res, 200, {node});
    }

    if (req.method === 'POST' && action === 'folder') {
      permit('content:edit');
      const node = await fs.mkdir(scope, param('path'));
      changed();
      return json(res, 200, {node});
    }

    if (req.method === 'POST' && action === 'move') {
      permit('content:edit');
      const {from, to, baseRev} = await readBody(req) ?? {};
      const node = await fs.move(scope, from, to, {baseRev});
      changed();
      return json(res, 200, {node});
    }

    if (req.method === 'DELETE' && action === 'node') {
      permit('content:delete');
      const baseRev = param('baseRev');
      const node = await fs.remove(scope, param('path'), {...(baseRev === null ? {} : {baseRev: Number(baseRev)})});
      if (!node) return json(res, 404, {error: 'Not found', code: 'not-found'});
      changed();
      return json(res, 200, {node});
    }

    if (req.method === 'POST' && action === 'restore') {
      permit('content:edit');
      const {id} = await readBody(req) ?? {};
      const node = await fs.restore(scope, id);
      changed();
      return json(res, 200, {node});
    }

    if (req.method === 'DELETE' && action === 'trash') {
      permit('content:delete');
      const removed = await fs.emptyTrash(scope);
      changed();
      return json(res, 200, {removed});
    }

    if (req.method === 'PUT' && action === 'access') {
      permit('content:publish');
      const {path, access, members} = await readBody(req) ?? {};
      if (members !== undefined && (!Array.isArray(members) || members.some(member => typeof member !== 'string'))) {
        return json(res, 400, {error: 'members must be a list of user ids', code: 'bad-members'});
      }
      const node = await fs.setAccess(scope, path, access ?? null, {members});
      changed();
      return json(res, 200, {node});
    }

    if (req.method === 'GET' && action === 'share') {
      permit('content:read');
      const members = await fs.sharedWith(scope, param('path'));
      return members ? json(res, 200, {members}) : json(res, 404, {error: 'Not shared', code: 'not-shared'});
    }

    if (req.method === 'GET' && action === 'history') {
      permit('content:read');
      const revisions = await fs.history(scope, param('path'));
      return revisions ? json(res, 200, {revisions}) : json(res, 404, {error: 'Not found', code: 'not-found'});
    }

    if (req.method === 'GET' && action === 'revision') {
      permit('content:read');
      const found = await fs.readRevision(scope, param('path'), Number(param('seq')));
      if (!found) return json(res, 404, {error: 'Not found', code: 'not-found'});
      const node = await fs.stat(scope, param('path'));
      return sendBytes(req, res, {
        body: found.body, contentType: node.contentType, etag: `${node.id}:${found.change.seq}`,
        filename: found.change.path.split('/').pop(),
      });
    }

    if (action === 'crdt' && req.method === 'GET') {
      permit('content:read');
      // Followed before it is read, so no update falls between the two.
      if (param('stream')) {
        const node = await fs.stat(scope, param('path'));
        if (!node) return json(res, 404, {error: 'Not found', code: 'not-found'});
        fsHub.follow(scope, param('stream'), node.id);
      }
      const state = await crdt.state(scope, param('path'));
      if (state.changes) fsHub.broadcast(scope.workspaceId, state.nodeId, state.changes, state.rev);
      res.setHeader('X-Rev', String(state.rev));
      res.setHeader('X-Node-Id', state.nodeId);
      return sendBytes(req, res, {
        body: Buffer.from(state.update), contentType: 'application/octet-stream', etag: `${state.nodeId}:${state.rev}`,
        filename: 'state.yjs',
      });
    }

    if (action === 'crdt' && req.method === 'POST') {
      permit('content:edit');
      const update = await readRawBody(req);
      const {node, changes} = await crdt.merge(scope, param('path'), update);
      fsHub.broadcast(scope.workspaceId, node.id, changes, node.rev);
      changed();
      return json(res, 200, {node});
    }

    if (action === 'follow' && req.method === 'DELETE') {
      permit('content:read');
      fsHub.unfollow(scope, param('stream'), param('node'));
      return json(res, 200, {following: false});
    }

    if (action === 'events' && req.method === 'GET') {
      permit('content:read');
      // Listened for first: a browser gone while the stream opens still stops it.
      const closed = new Promise(resolve => res.on('close', resolve));
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const stream = await fsHub.listen(scope, send, () => res.end());
      const origin = req.headers.origin;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': CORS_ORIGIN === '*' ? (origin || '*') : CORS_ORIGIN,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      });
      res.flushHeaders?.();
      // The stream outlives the server's idle limit; the heartbeat keeps proxies from closing it.
      req.setTimeout(0);
      send('ready', {stream: stream.id, cursor: stream.cursor});
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
      await closed;
      clearInterval(heartbeat);
      stream.stop();
      return res.end();
    }

    if (req.method === 'GET' && action === 'search') {
      permit('content:read');
      const q = param('q') ?? '';
      if (!q) return json(res, 400, {error: 'Say what to search for', code: 'bad-query'});
      const options = {matchCase: param('case') === '1', wholeWord: param('word') === '1'};
      const files = [];
      let count = 0;
      for (const file of await fs.readMany(scope, {text: SEARCH_FILE_LIMIT})) {
        const matches = lineMatches(file.body.toString('utf8'), q, options, SEARCH_MATCH_LIMIT + 1 - count);
        if (!matches.length) continue;
        files.push({path: file.path, rev: file.rev, matches: matches.map(match => preview(match))});
        count += matches.length;
        if (count > SEARCH_MATCH_LIMIT) break;
      }
      if (count > SEARCH_MATCH_LIMIT) files.at(-1).matches.pop();
      return json(res, 200, {files, truncated: count > SEARCH_MATCH_LIMIT});
    }

    if (req.method === 'GET' && action === 'changes') {
      permit('content:read');
      return json(res, 200, await fs.changes(scope, {since: param('since'), limit: param('limit')}));
    }
  } catch (error) {
    return fail(json, res, error);
  }
  return undefined;
};
