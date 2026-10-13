'use strict';
const {withRequestContext} = require('./client');

/**
 * The plugins each workspace added from the marketplace (migration 0019): what
 * its members see on the Plugins page. Row-level security lets every member
 * read the list and only an owner change it.
 */
function createPostgresWorkspacePlugins({pool}) {
  const run = (context, operation) => withRequestContext(pool, context, operation);
  const added = row => ({id: row.plugin_id, source: row.source, addedAt: row.added_at});

  return Object.freeze({
    /** The workspace's plugins, in the order they were added. */
    async list(context) {
      return run(context, async client => (await client.query(
        'select plugin_id, source, added_at from workspace_plugin order by added_at, plugin_id',
      )).rows.map(added));
    },
    async get(context, id) {
      return run(context, async client => {
        const row = (await client.query(
          'select plugin_id, source, added_at from workspace_plugin where plugin_id = $1', [id],
        )).rows[0];
        return row ? added(row) : null;
      });
    },
    /** Add a plugin from `source` (`nanoagent` or `upload`); adding it again changes nothing. */
    async add(context, id, source) {
      return run(context, async client => {
        await client.query(
          `insert into workspace_plugin (workspace_id, plugin_id, source, added_by) values ($1, $2, $3, $4)
           on conflict (workspace_id, plugin_id) do nothing`,
          [context.workspaceId, id, source, context.userId],
        );
        return added((await client.query(
          'select plugin_id, source, added_at from workspace_plugin where plugin_id = $1', [id],
        )).rows[0]);
      });
    },
    /** Whether the workspace had the plugin. */
    async remove(context, id) {
      return run(context, async client => (await client.query(
        'delete from workspace_plugin where plugin_id = $1', [id],
      )).rowCount > 0);
    },
  });
}

module.exports = {createPostgresWorkspacePlugins};
