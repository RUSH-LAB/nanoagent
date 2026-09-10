const crypto = require('crypto');
const {withRequestContext} = require('./postgres/client');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function objectKeyWorkspace(key) {
  const value = String(key ?? '');
  const workspaceId = value.split('/')[0];
  if (!workspaceId || !/^[A-Za-z0-9_.-]+$/.test(workspaceId)
      || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw new Error(`Invalid object key: ${value}`);
  }
  return workspaceId;
}

/** PostgreSQL is the durable source of truth for every uploaded byte. */
function postgresObjectStorage({pool}) {
  if (!pool) throw new Error('PostgreSQL object storage requires a database pool');
  const run = (key, operation) => withRequestContext(pool, {
    workspaceId: objectKeyWorkspace(key),
    // Blob authorization happens through the scoped asset record before this
    // layer is called. The blob policy itself is scoped by workspace id.
    userId: 'object-storage',
  }, operation);

  return Object.freeze({
    provider: 'postgres',
    async put(key, body, contentType = 'application/octet-stream') {
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const workspaceId = objectKeyWorkspace(key);
      await run(key, client => client.query(
        `insert into object_blob(object_key, workspace_id, body, content_type, byte_size, sha256, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (object_key) do update set
           workspace_id = excluded.workspace_id,
           body = excluded.body,
           content_type = excluded.content_type,
           byte_size = excluded.byte_size,
           sha256 = excluded.sha256,
           updated_at = excluded.updated_at`,
        [String(key), workspaceId, payload, String(contentType), payload.length, hash(payload)],
      ));
    },
    async get(key) {
      return run(key, async client => (await client.query(
        'select body from object_blob where object_key = $1', [String(key)],
      )).rows[0]?.body ?? null);
    },
    async stat(key) {
      return run(key, async client => {
        const row = (await client.query(
          'select byte_size as size, sha256 as etag from object_blob where object_key = $1', [String(key)],
        )).rows[0];
        return row ? {size: Number(row.size), etag: row.etag} : null;
      });
    },
    async remove(key) {
      return run(key, async client => (await client.query(
        'delete from object_blob where object_key = $1', [String(key)],
      )).rowCount > 0);
    },
  });
}

/** Ephemeral non-production fallback; it never writes to var/objects. */
function memoryObjectStorage({values = new Map()} = {}) {
  return Object.freeze({
    provider: 'memory',
    async put(key, body, contentType = 'application/octet-stream') {
      const payload = Buffer.from(body);
      values.set(String(key), {body: payload, contentType, sha256: hash(payload)});
    },
    async get(key) {
      const value = values.get(String(key));
      return value ? Buffer.from(value.body) : null;
    },
    async stat(key) {
      const value = values.get(String(key));
      return value ? {size: value.body.length, etag: value.sha256} : null;
    },
    async remove(key) {
      return values.delete(String(key));
    },
  });
}

function createObjectStorage(env = process.env, {pool} = {}) {
  if (pool) return postgresObjectStorage({pool});
  if (env.NODE_ENV === 'production') {
    throw new Error('Production requires PostgreSQL object storage');
  }
  return memoryObjectStorage();
}

module.exports = {createObjectStorage, memoryObjectStorage, postgresObjectStorage, objectKeyWorkspace};
