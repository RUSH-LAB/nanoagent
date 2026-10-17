'use strict';
const {escapeLiteral} = require('pg');
const {queryInContext, withRequestContext} = require('./client');

/**
 * The plugins each member installed from the marketplace (migration 0037), the
 * tags they file them under, and for an upload the version they stay on, or
 * null to follow its latest (0041): what they see on the Plugins page, in
 * every workspace they are in. Row-level security shows and changes only the
 * caller's own.
 */
function createPostgresUserPlugins({pool}) {
  const run = (context, operation) => withRequestContext(pool, context, operation);
  const installed = row => ({
    id: row.plugin_id, source: row.source, tags: row.tags, installedAt: row.installed_at,
    pinned: row.pinned, version: row.version, latest: row.latest, sha256: row.sha256, entry: row.entry, repository: row.repository,
  });
  // An upload's install at the version it runs: the one it stays on, or the latest.
  const COLUMNS = `u.plugin_id, u.source, u.tags, u.installed_at, u.version as pinned, v.version, m.version as latest, v.sha256, v.entry, v.repository
    from user_plugin u left join market_plugin m on m.id = u.upload_id
    left join market_plugin_version v on v.plugin_id = m.id and v.version = coalesce(u.version, m.version)`;

  return Object.freeze({
    /** The caller's plugins, in the order they were installed. */
    async list(context) {
      return run(context, async client => (await client.query(
        `select ${COLUMNS} order by u.installed_at, u.plugin_id`,
      )).rows.map(installed));
    },
    /** One of the caller's plugins, with the `version` and `sha256` an upload runs and its `latest`, or null. */
    async get(context, id) {
      // Opening a plugin asks this, so it is one round trip. An upload's row
      // goes when its market_plugin does (migration 0037), so it always has one.
      const [row] = await queryInContext(pool, context, `select ${COLUMNS} where u.plugin_id = ${escapeLiteral(id)}`);
      return row ? installed(row) : null;
    },
    /** Install a plugin from `source` (`nanoagent` or `upload`); installing it again changes nothing. */
    async add(context, id, source) {
      return run(context, async client => {
        await client.query(
          `insert into user_plugin (user_id, plugin_id, source) values ($1, $2, $3)
           on conflict (user_id, plugin_id) do nothing`,
          [context.userId, id, source],
        );
        return installed((await client.query(`select ${COLUMNS} where u.plugin_id = $1`, [id])).rows[0]);
      });
    },
    /**
     * Keep the caller's upload `id` on `version`, or with null have it follow
     * the latest: whether they have it. Throws `23503` for a version never published.
     */
    async pin(context, id, version) {
      return run(context, async client => (await client.query(
        "update user_plugin set version = $2 where plugin_id = $1 and source = 'upload'", [id, version],
      )).rowCount > 0);
    },
    /** Replace the plugin's tags: whether the caller has it. */
    async tag(context, id, tags) {
      return run(context, async client => (await client.query(
        'update user_plugin set tags = $2 where plugin_id = $1', [id, tags],
      )).rowCount > 0);
    },
    /** Whether the caller had the plugin. */
    async remove(context, id) {
      return run(context, async client => (await client.query(
        'delete from user_plugin where plugin_id = $1', [id],
      )).rowCount > 0);
    },
    /** Install for `userId` the marketplace uploads among `ids`: the ids installed, of those the marketplace has. */
    async preinstall(userId, ids) {
      return run({userId, workspaceId: null}, async client => (await client.query(
        `insert into user_plugin (user_id, plugin_id, source)
         select $1, m.id, 'upload' from market_plugin m where m.id = any($2)
         on conflict (user_id, plugin_id) do nothing returning plugin_id`,
        [userId, ids],
      )).rows.map(row => row.plugin_id));
    },
  });
}

module.exports = {createPostgresUserPlugins};
