'use strict';
const {withRequestContext} = require('./client');

/** The hash of the OpenRouter key Mochi made for each member (migration 0029). */
function createPostgresOpenRouterGrants({pool}) {
  const run = (userId, operation) => withRequestContext(pool, {userId, workspaceId: null}, operation);
  return Object.freeze({
    /** The hash of the member's key, or null when Mochi has made them none. */
    async hash(userId) {
      const row = (await run(userId, client => client.query('select hash from openrouter_grant where user_id = $1', [userId]))).rows[0];
      return row?.hash ?? null;
    },
    async put(userId, hash) {
      await run(userId, client => client.query(
        `insert into openrouter_grant (user_id, hash) values ($1, $2)
         on conflict (user_id) do update set hash = excluded.hash, created_at = now()`,
        [userId, hash],
      ));
    },
  });
}

module.exports = {createPostgresOpenRouterGrants};
