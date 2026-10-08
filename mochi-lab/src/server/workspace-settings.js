const MAX_SETTINGS_BYTES = 64 * 1024;

function contextIds(context) {
  if (!context?.workspaceId || !context?.userId || !context?.membershipId) {
    const error = new Error('A verified workspace context is required');
    error.status = 404;
    error.code = 'workspace-not-found';
    throw error;
  }
  return context;
}

function checked(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Settings must be an object');
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError(`Invalid settings key: ${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SETTINGS_BYTES) throw new TypeError('Settings are too large');
  return value;
}

function createWorkspaceSettings({db = require('./db').db, now = () => new Date().toISOString()} = {}) {
  const workspaceGet = db.prepare('SELECT value FROM workspace_settings WHERE organizationId = ?');
  const workspacePut = db.prepare(`INSERT INTO workspace_settings (organizationId, value, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT (organizationId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`);
  const memberGet = db.prepare('SELECT value FROM workspace_member_preferences WHERE organizationId = ? AND userId = ?');
  const memberPut = db.prepare(`INSERT INTO workspace_member_preferences (organizationId, userId, value, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT (organizationId, userId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`);

  const parse = row => row ? JSON.parse(row.value) : {};
  const merge = (current, patch) => checked({...current, ...checked(patch), updatedAt: now()});

  return Object.freeze({
    get(context) {
      const {workspaceId} = contextIds(context);
      return parse(workspaceGet.get(workspaceId));
    },
    update(context, patch) {
      const {workspaceId} = contextIds(context);
      return db.transaction(() => {
        const next = merge(parse(workspaceGet.get(workspaceId)), patch);
        workspacePut.run(workspaceId, JSON.stringify(next), next.updatedAt);
        return next;
      })();
    },
    getMember(context) {
      const {workspaceId, userId} = contextIds(context);
      return parse(memberGet.get(workspaceId, userId));
    },
    updateMember(context, patch) {
      const {workspaceId, userId} = contextIds(context);
      return db.transaction(() => {
        const next = merge(parse(memberGet.get(workspaceId, userId)), patch);
        memberPut.run(workspaceId, userId, JSON.stringify(next), next.updatedAt);
        return next;
      })();
    },
  });
}

module.exports = {...createWorkspaceSettings(), createWorkspaceSettings, MAX_SETTINGS_BYTES};
