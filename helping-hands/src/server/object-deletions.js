/** Durable outbox for object-storage deletion after a workspace is removed. */
function createObjectDeletionQueue({db = null, pool = null} = {}) {
  if (pool) {
    return Object.freeze({
      async list(limit = 100) {
        return (await pool.query(
          `select id, workspace_id as "workspaceId", object_key as "objectKey", attempts
             from object_deletion order by requested_at, id limit $1`, [limit],
        )).rows;
      },
      async complete(id) {
        await pool.query('delete from object_deletion where id = $1', [id]);
      },
      async fail(id, error) {
        await pool.query(
          'update object_deletion set attempts = attempts + 1, last_error = $1 where id = $2',
          [String(error?.message || error).slice(0, 2000), id],
        );
      },
    });
  }
  if (!db) throw new Error('An SQL database is required for object cleanup');
  const list = db.prepare(`select id, "workspaceId", "objectKey", attempts
    from object_deletion order by "requestedAt", id limit ?`);
  const complete = db.prepare('delete from object_deletion where id = ?');
  const fail = db.prepare('update object_deletion set attempts = attempts + 1, "lastError" = ? where id = ?');
  return Object.freeze({
    list: async (limit = 100) => list.all(limit),
    complete: async id => { complete.run(id); },
    fail: async (id, error) => { fail.run(String(error?.message || error).slice(0, 2000), id); },
  });
}

async function drainObjectDeletions(queue, storage, {limit = 100} = {}) {
  const result = {processed: 0, removed: 0, failed: 0};
  for (const item of await queue.list(limit)) {
    result.processed++;
    try {
      const removed = await storage.remove(item.objectKey);
      if (!removed && await storage.stat(item.objectKey)) throw new Error('Object storage refused deletion');
      await queue.complete(item.id);
      result.removed++;
    } catch (error) {
      await queue.fail(item.id, error);
      result.failed++;
    }
  }
  return result;
}

module.exports = {createObjectDeletionQueue, drainObjectDeletions};
