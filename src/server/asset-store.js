'use strict';

/**
 * Uploaded workspace files (images, PDFs, data), as one interface over either
 * store CONTENT_STORE selects:
 *
 *   list(context)                     [{id, path, contentType, byteSize, sha256, createdAt}]
 *   read(context, {id} | {path})      {asset, body} or null
 *   put(context, path, body)          the stored asset
 *   remove(context, path)             whether something was removed
 *
 * The legacy store keeps metadata in `asset` and bytes in object storage; the
 * file system keeps both in its own tables (fs/assets.js).
 */
const crypto = require('crypto');
const {assetObjectKey, contentTypeForAsset} = require('./asset-paths');

function createLegacyAssetStore({assets, objectStorage}) {
  const describe = asset => ({
    id: asset.id,
    path: asset.path,
    contentType: asset.contentType,
    byteSize: Number(asset.byteSize),
    sha256: asset.sha256,
    createdAt: asset.createdAt,
  });
  return Object.freeze({
    async list(context) {
      return (await assets.list(context)).map(describe);
    },
    async read(context, {id, path}) {
      const asset = id ? await assets.get(context, id) : await assets.getByPath(context, path);
      if (!asset) return null;
      const body = await objectStorage.get(asset.objectKey);
      return body ? {asset: describe(asset), body} : null;
    },
    async put(context, path, body) {
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const objectKey = assetObjectKey(context.workspaceId, path, sha256);
      const contentType = contentTypeForAsset(path);
      const previous = await assets.getByPath(context, path);
      await objectStorage.put(objectKey, body, contentType);
      let asset;
      try {
        asset = await assets.put(context, {path, objectKey, contentType, byteSize: body.length, sha256});
      } catch (error) {
        await objectStorage.remove(objectKey).catch(() => {});
        throw error;
      }
      if (previous && previous.objectKey !== objectKey) {
        await objectStorage.remove(previous.objectKey).catch(() => {});
      }
      return describe(asset);
    },
    async remove(context, path) {
      const asset = await assets.getByPath(context, path);
      if (!asset) return false;
      await objectStorage.remove(asset.objectKey);
      await assets.remove(context, asset.id);
      return true;
    },
  });
}

module.exports = {createLegacyAssetStore};
