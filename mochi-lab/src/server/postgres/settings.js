const crypto = require('crypto');
const {withRequestContext} = require('./client');
const MAX_SETTINGS_BYTES = 64 * 1024;

function requireContext(context) {
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

function requireAssetContext(context) {
  if (!context?.workspaceId || !context?.userId) {
    const error = new Error('A verified workspace context is required');
    error.status = 404;
    error.code = 'workspace-not-found';
    throw error;
  }
  return context;
}

function createPostgresSettings({pool, now = () => new Date().toISOString()}) {
  const run = (context, operation) => {
    const verified = requireContext(context);
    return withRequestContext(pool, verified, operation);
  };
  const merge = (current, patch) => checked({...current, ...checked(patch), updatedAt: now()});
  return Object.freeze({
    async get(context) {
      return run(context, async client => (await client.query(
        'select value from workspace_settings where workspace_id = $1', [context.workspaceId],
      )).rows[0]?.value ?? {});
    },
    async update(context, patch) {
      return run(context, async client => {
        const current = (await client.query(
          'select value from workspace_settings where workspace_id = $1 for update', [context.workspaceId],
        )).rows[0]?.value ?? {};
        const next = merge(current, patch);
        await client.query(
          `insert into workspace_settings(workspace_id, value, updated_at) values ($1, $2::jsonb, $3)
           on conflict (workspace_id) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [context.workspaceId, JSON.stringify(next), next.updatedAt],
        );
        return next;
      });
    },
    async getMember(context) {
      return run(context, async client => (await client.query(
        'select value from workspace_member_preferences where workspace_id = $1 and user_id = $2',
        [context.workspaceId, context.userId],
      )).rows[0]?.value ?? {});
    },
    async updateMember(context, patch) {
      return run(context, async client => {
        const current = (await client.query(
          `select value from workspace_member_preferences
            where workspace_id = $1 and user_id = $2 for update`, [context.workspaceId, context.userId],
        )).rows[0]?.value ?? {};
        const next = merge(current, patch);
        await client.query(
          `insert into workspace_member_preferences(workspace_id, user_id, value, updated_at)
           values ($1, $2, $3::jsonb, $4)
           on conflict (workspace_id, user_id) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [context.workspaceId, context.userId, JSON.stringify(next), next.updatedAt],
        );
        return next;
      });
    },
  });
}

function createPostgresPreferences({pool, now = () => new Date().toISOString()}) {
  const requireUser = userId => {
    if (!userId || typeof userId !== 'string') {
      const error = new Error('Preferences require a signed-in user');
      error.status = 401;
      error.code = 'no-identity';
      throw error;
    }
    return userId;
  };
  const run = (userId, operation) => withRequestContext(pool, {userId: requireUser(userId), workspaceId: null}, operation);
  return Object.freeze({
    async get(userId) {
      return run(userId, async client => (await client.query(
        'select value from user_preferences where user_id = $1', [userId],
      )).rows[0]?.value ?? {});
    },
    async set(userId, value) {
      const updatedAt = value?.updatedAt ?? now();
      return run(userId, async client => {
        await client.query(
          `insert into user_preferences(user_id, value, updated_at) values ($1, $2::jsonb, $3)
           on conflict (user_id) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [userId, JSON.stringify(value ?? {}), updatedAt],
        );
        return value ?? {};
      });
    },
    async merge(userId, patch) {
      return run(userId, async client => {
        const current = (await client.query('select value from user_preferences where user_id = $1 for update', [userId])).rows[0]?.value ?? {};
        const next = {...current, ...patch, updatedAt: now()};
        await client.query(
          `insert into user_preferences(user_id, value, updated_at) values ($1, $2::jsonb, $3)
           on conflict (user_id) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [userId, JSON.stringify(next), next.updatedAt],
        );
        return next;
      });
    },
  });
}

function createPostgresAssets({pool, newId = () => crypto.randomUUID(), now = () => new Date().toISOString()}) {
  const run = (context, operation) => withRequestContext(pool, requireAssetContext(context), operation);
  const columns = `id, path, object_key as "objectKey", content_type as "contentType",
    byte_size as "byteSize", sha256, created_by as "createdBy", created_at as "createdAt"`;
  return Object.freeze({
    async create(context, value) {
      const asset = {id: value.id || newId(), ...value, createdBy: context.userId, createdAt: now()};
      await run(context, client => client.query(
        `insert into asset(id, workspace_id, path, object_key, content_type, byte_size, sha256, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [asset.id, context.workspaceId, asset.path || asset.id, asset.objectKey, asset.contentType, asset.byteSize, asset.sha256, context.userId, asset.createdAt],
      ));
      return asset;
    },
    async put(context, value) {
      const asset = {id: value.id || newId(), ...value, createdBy: context.userId, createdAt: now()};
      return run(context, async client => (await client.query(
        `insert into asset(id, workspace_id, path, object_key, content_type, byte_size, sha256, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (workspace_id, path) do update set
           object_key = excluded.object_key, content_type = excluded.content_type,
           byte_size = excluded.byte_size, sha256 = excluded.sha256,
           created_by = excluded.created_by, created_at = excluded.created_at
         returning ${columns}`,
        [asset.id, context.workspaceId, asset.path, asset.objectKey, asset.contentType, asset.byteSize, asset.sha256, context.userId, asset.createdAt],
      )).rows[0]);
    },
    async get(context, id) {
      return run(context, async client => (await client.query(
        `select ${columns} from asset where id = $1`, [String(id)],
      )).rows[0] ?? null);
    },
    async getByPath(context, path) {
      return run(context, async client => (await client.query(
        `select ${columns} from asset where path = $1`, [String(path)],
      )).rows[0] ?? null);
    },
    async list(context) {
      return run(context, async client => (await client.query(
        `select ${columns} from asset order by path`,
      )).rows);
    },
    async remove(context, id) {
      return run(context, async client => (await client.query('delete from asset where id = $1', [String(id)])).rowCount > 0);
    },
  });
}

module.exports = {createPostgresSettings, createPostgresPreferences, createPostgresAssets};
