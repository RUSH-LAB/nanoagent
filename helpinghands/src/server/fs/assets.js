'use strict';

/**
 * Uploaded files (asset-store.js) and plugin blobs served from the workspace
 * file system. An asset is any file that is not Markdown, at its own path; a
 * plugin's blob is a file under `.plugins/<plugin>/blobs/`, and its key is the node id.
 */
const crypto = require('crypto');
const {contentTypeForAsset} = require('../asset-paths');
const {isAppState, isMarkdown} = require('./store');

const describe = node => ({
  id: node.id,
  path: node.path,
  contentType: node.contentType,
  byteSize: node.size,
  sha256: node.contentHash,
  createdAt: node.createdAt,
});

function createFsAssetStore({fs}) {
  return Object.freeze({
    async list(context) {
      return (await fs.list(context))
        .filter(node => node.kind === 'file' && !isMarkdown(node.path) && !isAppState(node.path))
        .map(describe);
    },
    async read(context, {id, path}) {
      const found = id ? await fs.readById(context, id) : await fs.read(context, path);
      return found ? {asset: describe(found.node), body: found.body} : null;
    },
    async put(context, path, body) {
      return describe(await fs.write(context, path, body, {contentType: contentTypeForAsset(path)}));
    },
    async remove(context, path) {
      return Boolean(await fs.remove(context, path));
    },
  });
}

/** The blob capability a plugin is handed (plugin-api.js), kept in the file system. */
function fsBlobs(name, {orgId, userId, fs}) {
  const context = {workspaceId: orgId, userId};
  const folder = `.plugins/${String(name).replace(/[^\w.-]/g, '_')}/blobs`;
  return Object.freeze({
    provider: 'fs',
    async put(bytes, extension = '') {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const suffix = /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : '';
      const id = crypto.randomUUID();
      const node = await fs.write(context, `${folder}/${id}${suffix}`, body, {
        id, contentType: suffix === '.pdf' ? 'application/pdf' : 'application/octet-stream', baseRev: 0,
      });
      return {key: node.id, sha256: node.contentHash, size: node.size};
    },
    async read(key) {
      return (await fs.readById(context, key))?.body ?? null;
    },
    async stat(key) {
      const node = await fs.byId(context, key);
      return node && !node.deletedAt ? {size: node.size, etag: node.contentHash} : null;
    },
    async remove(key) {
      const node = await fs.byId(context, key);
      if (!node || node.deletedAt) return false;
      return Boolean(await fs.remove(context, node.path));
    },
  });
}

module.exports = {createFsAssetStore, fsBlobs};
