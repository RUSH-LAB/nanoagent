'use strict';
const {escapeLiteral} = require('pg');
const {queryInContext, withRequestContext} = require('./client');

/**
 * The plugins each member installed from the marketplace (migration 0037), and
 * the tags they file them under: what they see on the Plugins page, in every
 * workspace they are in. Row-level security shows and changes only the
 * caller's own.
 */
function createPostgresUserPlugins({pool}) {
  const run = (context, operation) => withRequestContext(pool, context, operation);
  const installed = row => ({id: row.plugin_id, source: row.source, tags: row.tags, installedAt: row.installed_at});
  const COLUMNS = 'plugin_id, source, tags, installed_at';

  return Object.freeze({
    /** The caller's plugins, in the order they were installed. */
    async list(context) {
      return run(context, async client => (await client.query(
        `select ${COLUMNS} from user_plugin order by installed_at, plugin_id`,
      )).rows.map(installed));
    },
    /** One of the caller's plugins, with an upload's current `sha256`, or null. */
    async get(context, id) {
      // Opening a plugin asks this, so it is one round trip. An upload's row
      // goes when its market_plugin does (migration 0037), so it always has one.
      const [row] = await queryInContext(pool, context,
        `select u.plugin_id, u.source, u.tags, u.installed_at, m.sha256
           from user_plugin u left join market_plugin m on m.id = u.upload_id
          where u.plugin_id = ${escapeLiteral(id)}`,
      );
      return row ? {...installed(row), sha256: row.sha256} : null;
    },
    /** Install a plugin from `source` (`nanoagent` or `upload`); installing it again changes nothing. */
    async add(context, id, source) {
      return run(context, async client => {
        await client.query(
          `insert into user_plugin (user_id, plugin_id, source) values ($1, $2, $3)
           on conflict (user_id, plugin_id) do nothing`,
          [context.userId, id, source],
        );
        return installed((await client.query(
          `select ${COLUMNS} from user_plugin where plugin_id = $1`, [id],
        )).rows[0]);
      });
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
  });
}

module.exports = {createPostgresUserPlugins};
