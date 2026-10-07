'use strict';

/**
 * The workspace file system API (docs/plans/workspace-filesystem.md), for
 * members, at /api/workspaces/:id/fs/…:
 *
 *   GET    tree?prefix=&deleted=1     nodes, without contents
 *   GET    stat?path=                 one node
 *   GET    file?path= | ?id=          the bytes; the node's rev is the ETag
 *   PUT    file?path=&baseRev=        create or replace; baseRev=0 means "must not exist"
 *   POST   folder?path=               create a folder and any missing parents
 *   POST   move {from, to, baseRev}
 *   DELETE node?path=&baseRev=        to the trash, with everything inside
 *   POST   restore {id}
 *   DELETE trash                      empty the trash
 *   PUT    access {path, access}      workspace, private, public, or null to inherit
 *   GET    history?path=              every revision, newest first
 *   GET    revision?path=&seq=        the bytes of one revision
 *   GET    changes?since=&limit=      the change feed sync clients follow
 */
const ROUTE = /^\/api\/fs\/(tree|stat|file|folder|move|node|restore|trash|access|history|revision|changes)$/;

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

function sendBytes(req, res, {body, contentType, etag, filename}) {
  const origin = req.headers.origin;
  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': body.length,
    'Content-Disposition': `inline; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
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

module.exports = async function fs_routes(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match || !req.context) return;
  const {json, readBody, readRawBody, requireWorkspacePermission, workspaceFs: fs, invalidateCache, cacheKey} = ctx;
  if (!fs) {
    return json(res, 409, {
      error: 'The workspace file system is not enabled on this server (CONTENT_STORE=legacy)', code: 'fs-disabled',
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
        filename: found.node.path.split('/').pop(),
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
      const {path, access} = await readBody(req) ?? {};
      const node = await fs.setAccess(scope, path, access ?? null);
      changed();
      return json(res, 200, {node});
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

    if (req.method === 'GET' && action === 'changes') {
      permit('content:read');
      return json(res, 200, await fs.changes(scope, {since: param('since'), limit: param('limit')}));
    }
  } catch (error) {
    return fail(json, res, error);
  }
  return undefined;
};
