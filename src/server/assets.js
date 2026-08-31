const crypto = require('crypto');

function ids(context) {
  if (!context?.workspaceId || !context?.userId) {
    const error = new Error('A verified workspace context is required');
    error.status = 404;
    error.code = 'workspace-not-found';
    throw error;
  }
  return context;
}

function createAssets({db = require('./db').db, newId = () => crypto.randomUUID(), now = () => new Date().toISOString()} = {}) {
  const insert = db.prepare(`INSERT INTO asset
    (id, organizationId, objectKey, contentType, byteSize, sha256, createdBy, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const getRow = db.prepare(`SELECT id, objectKey, contentType, byteSize, sha256, createdBy, createdAt
    FROM asset WHERE id = ? AND organizationId = ?`);
  const removeRow = db.prepare('DELETE FROM asset WHERE id = ? AND organizationId = ?');
  return Object.freeze({
    create(context, value) {
      const {workspaceId, userId} = ids(context);
      const asset = {id: value.id || newId(), ...value, createdBy: userId, createdAt: now()};
      insert.run(asset.id, workspaceId, asset.objectKey, asset.contentType, asset.byteSize, asset.sha256, userId, asset.createdAt);
      return asset;
    },
    get(context, id) {
      return getRow.get(String(id), ids(context).workspaceId) ?? null;
    },
    remove(context, id) {
      return removeRow.run(String(id), ids(context).workspaceId).changes > 0;
    },
  });
}

module.exports = {...createAssets(), createAssets};
