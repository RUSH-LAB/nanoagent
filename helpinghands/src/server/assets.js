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
    (id, organizationId, path, objectKey, contentType, byteSize, sha256, createdBy, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upsert = db.prepare(`INSERT INTO asset
    (id, organizationId, path, objectKey, contentType, byteSize, sha256, createdBy, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (organizationId, path) DO UPDATE SET
      objectKey = excluded.objectKey,
      contentType = excluded.contentType,
      byteSize = excluded.byteSize,
      sha256 = excluded.sha256,
      createdBy = excluded.createdBy,
      createdAt = excluded.createdAt`);
  const getRow = db.prepare(`SELECT id, path, objectKey, contentType, byteSize, sha256, createdBy, createdAt
    FROM asset WHERE id = ? AND organizationId = ?`);
  const getPath = db.prepare(`SELECT id, path, objectKey, contentType, byteSize, sha256, createdBy, createdAt
    FROM asset WHERE path = ? AND organizationId = ?`);
  const listRows = db.prepare(`SELECT id, path, objectKey, contentType, byteSize, sha256, createdBy, createdAt
    FROM asset WHERE organizationId = ? ORDER BY path`);
  const removeRow = db.prepare('DELETE FROM asset WHERE id = ? AND organizationId = ?');
  return Object.freeze({
    create(context, value) {
      const {workspaceId, userId} = ids(context);
      const asset = {id: value.id || newId(), ...value, createdBy: userId, createdAt: now()};
      insert.run(asset.id, workspaceId, asset.path || asset.id, asset.objectKey, asset.contentType, asset.byteSize, asset.sha256, userId, asset.createdAt);
      return asset;
    },
    put(context, value) {
      const {workspaceId, userId} = ids(context);
      const asset = {id: value.id || newId(), ...value, createdBy: userId, createdAt: now()};
      upsert.run(asset.id, workspaceId, asset.path, asset.objectKey, asset.contentType, asset.byteSize, asset.sha256, userId, asset.createdAt);
      return getPath.get(asset.path, workspaceId);
    },
    get(context, id) {
      return getRow.get(String(id), ids(context).workspaceId) ?? null;
    },
    getByPath(context, path) {
      return getPath.get(String(path), ids(context).workspaceId) ?? null;
    },
    list(context) {
      return listRows.all(ids(context).workspaceId);
    },
    remove(context, id) {
      return removeRow.run(String(id), ids(context).workspaceId).changes > 0;
    },
  });
}

module.exports = {...createAssets(), createAssets};
