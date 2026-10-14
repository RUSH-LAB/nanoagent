'use strict';
const {withRequestContext} = require('./client');

/** The hash and hint of the OpenRouter key Mochi made for each member (migration 0029). */
function createPostgresOpenRouterGrants({pool}) {
  const run = (userId, operation) => withRequestContext(pool, {userId, workspaceId: null}, operation);
  return Object.freeze({
    /** The member's key as {hash, hint}, or null when Mochi has made them none. */
    async get(userId) {
      const row = (await run(userId, client => client.query('select hash, hint from openrouter_grant where user_id = $1', [userId]))).rows[0];
      return row ?? null;
    },
    async put(userId, {hash, hint}) {
      await run(userId, client => client.query(
        `insert into openrouter_grant (user_id, hash, hint) values ($1, $2, $3)
         on conflict (user_id) do update set hash = excluded.hash, hint = excluded.hint, created_at = now()`,
        [userId, hash, hint],
      ));
    },
  });
}

module.exports = {createPostgresOpenRouterGrants};
