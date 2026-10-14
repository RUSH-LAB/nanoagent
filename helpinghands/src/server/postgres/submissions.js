'use strict';
const crypto = require('crypto');
const {withRequestContext} = require('./client');

/**
 * What members submit to their workspace (migration 0026): each a published
 * plugin and the statement its submitter agreed to. Row-level security lets an
 * owner read every submission and any other member only their own, and lets
 * nobody change one.
 */
function createPostgresSubmissions({pool}) {
  const run = (context, operation) => withRequestContext(pool, context, operation);
  const submission = row => ({
    id: row.id,
    plugin: {id: row.plugin_id, version: row.version, sha256: row.sha256, repository: row.repository},
    statement: row.statement,
    submitter: {id: row.user_id, name: row.display_name, github: row.github_login},
    createdAt: row.created_at,
  });
  const SELECT = `select s.*, u.display_name, u.github_login
    from workspace_submission s join app_user u on u.id = s.user_id`;

  return Object.freeze({
    /** The submissions the caller may read, newest first. */
    async list(context) {
      return run(context, async client => (await client.query(
        `${SELECT} order by s.created_at desc, s.id`,
      )).rows.map(submission));
    },
    /** Record the caller's submission of `plugin`, a marketplace listing, agreeing to `statement`. */
    async add(context, plugin, statement) {
      return run(context, async client => {
        const id = crypto.randomUUID();
        await client.query(
          `insert into workspace_submission (id, workspace_id, user_id, plugin_id, version, sha256, repository, statement)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [id, context.workspaceId, context.userId, plugin.id, plugin.version, plugin.sha256,
            JSON.stringify(plugin.repository), statement],
        );
        return submission((await client.query(`${SELECT} where s.id = $1`, [id])).rows[0]);
      });
    },
  });
}

module.exports = {createPostgresSubmissions};
