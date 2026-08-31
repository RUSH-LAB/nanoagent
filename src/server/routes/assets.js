'use strict';

const {cleanAssetPath, contentTypeForAsset, assetObjectKey} = require('../asset-paths');

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
    json, readRawBody, rateLimit, requireWorkspacePermission,
    assets, objectStorage, crypto,
  } = ctx;
  const logicalPath = url.searchParams.get('path');

  if (req.method === 'GET' && !logicalPath) {
    try {
      requireWorkspacePermission(req.context, 'content:read');
      const rows = await assets.list(req.context);
      return json(res, 200, {assets: rows.map(asset => ({
        id: asset.id,
        path: asset.path,
        contentType: asset.contentType,
        byteSize: Number(asset.byteSize),
        sha256: asset.sha256,
        createdAt: asset.createdAt,
      }))});
    } catch (error) {
      return fail(json, res, error, 'Could not list assets');
    }
  }

  const clean = cleanAssetPath(logicalPath);
  if (!clean) return json(res, 400, {error: 'Invalid asset path'});

  if (req.method === 'GET') {
    try {
      requireWorkspacePermission(req.context, 'content:read');
      const asset = await assets.getByPath(req.context, clean);
      if (!asset) return json(res, 404, {error: 'Asset not found'});
      const body = await objectStorage.get(asset.objectKey);
      if (!body) return json(res, 404, {error: 'Asset not found'});
      const inline = String(asset.contentType).startsWith('image/') || asset.contentType === 'application/pdf';
      const origin = req.headers.origin;
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': body.length,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${clean.split('/').pop().replace(/["\\]/g, '_')}"`,
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
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const objectKey = assetObjectKey(req.context.workspaceId, clean, sha256);
      const contentType = contentTypeForAsset(clean);
      const previous = await assets.getByPath(req.context, clean);
      await objectStorage.put(objectKey, body, contentType);
      let asset;
      try {
        asset = await assets.put(req.context, {
          path: clean, objectKey, contentType, byteSize: body.length, sha256,
        });
      } catch (error) {
        await objectStorage.remove(objectKey).catch(() => {});
        throw error;
      }
      if (previous && previous.objectKey !== objectKey) {
        await objectStorage.remove(previous.objectKey).catch(() => {});
      }
      return json(res, 200, {
        success: true,
        asset: {id: asset.id, path: clean, contentType, byteSize: body.length, sha256},
        url: `/api/workspaces/${encodeURIComponent(req.context.workspaceId)}/assets?path=${encodeURIComponent(clean)}`,
      });
    } catch (error) {
      return fail(json, res, error, 'Could not upload asset');
    }
  }

  if (req.method === 'DELETE') {
    try {
      requireWorkspacePermission(req.context, 'content:delete');
      const asset = await assets.getByPath(req.context, clean);
      if (!asset) return json(res, 404, {error: 'Asset not found'});
      await objectStorage.remove(asset.objectKey);
      await assets.remove(req.context, asset.id);
      return json(res, 200, {success: true});
    } catch (error) {
      return fail(json, res, error, 'Could not delete asset');
    }
  }
};
