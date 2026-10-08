'use strict';

const {cleanAssetPath, contentTypeForAsset} = require('../asset-paths');

function fail(json, res, error, fallback) {
  return json(res, error?.status || 400, {
    error: error?.message || fallback,
    ...(error?.code ? {code: error.code} : {}),
  });
}

module.exports = async function asset_routes(req, res, url, pathname, ctx) {
  const assetPath = req.context && req.workspacePath === '/assets' ? '/api/assets' : pathname;
  if (assetPath !== '/api/assets' || !req.context) return;
  const {
    json, readRawBody, rateLimit, requireWorkspacePermission, assetStore,
  } = ctx;
  const logicalPath = url.searchParams.get('path');
  const assetId = url.searchParams.get('id');

  if (req.method === 'GET' && !logicalPath && !assetId) {
    try {
      requireWorkspacePermission(req.context, 'content:read');
      return json(res, 200, {assets: await assetStore.list(req.context)});
    } catch (error) {
      return fail(json, res, error, 'Could not list assets');
    }
  }

  const clean = logicalPath == null ? null : cleanAssetPath(logicalPath);
  if (!assetId && !clean) return json(res, 400, {error: 'Invalid asset path'});
  if (assetId && (assetId.length > 200 || !/^[\w-]+$/.test(assetId))) {
    return json(res, 400, {error: 'Invalid asset id'});
  }

  if (req.method === 'GET') {
    try {
      requireWorkspacePermission(req.context, 'content:read');
      const found = await assetStore.read(req.context, assetId ? {id: assetId} : {path: clean});
      if (!found) return json(res, 404, {error: 'Asset not found'});
      const {asset, body} = found;
      const inline = String(asset.contentType).startsWith('image/') || asset.contentType === 'application/pdf';
      const filename = String(asset.path || asset.id).split('/').pop().replace(/["\\]/g, '_');
      const origin = req.headers.origin;
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': body.length,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'Cache-Control': 'private, max-age=300',
        'ETag': `"${asset.sha256}"`,
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': origin || '*',
        ...(origin ? {'Access-Control-Allow-Credentials': 'true'} : {}),
        'Vary': 'Origin',
      });
      return res.end(body);
    } catch (error) {
      return fail(json, res, error, 'Could not read asset');
    }
  }

  if (req.method === 'PUT') {
    if (!rateLimit(`asset:${req.context.workspaceId}:${req.context.userId}`, 30)) {
      return json(res, 429, {error: 'Too many uploads. Try again in a minute.'});
    }
    try {
      requireWorkspacePermission(req.context, 'content:edit');
      const body = await readRawBody(req);
      if (!body.length) return json(res, 400, {error: 'Asset body is empty'});
      const asset = await assetStore.put(req.context, clean, body);
      return json(res, 200, {
        success: true,
        asset: {
          id: asset.id, path: clean, contentType: contentTypeForAsset(clean), byteSize: body.length, sha256: asset.sha256,
        },
        url: `/api/workspaces/${encodeURIComponent(req.context.workspaceId)}/assets?path=${encodeURIComponent(clean)}`,
      });
    } catch (error) {
      return fail(json, res, error, 'Could not upload asset');
    }
  }

  if (req.method === 'DELETE') {
    try {
      requireWorkspacePermission(req.context, 'content:delete');
      if (!await assetStore.remove(req.context, clean)) return json(res, 404, {error: 'Asset not found'});
      return json(res, 200, {success: true});
    } catch (error) {
      return fail(json, res, error, 'Could not delete asset');
    }
  }
};
