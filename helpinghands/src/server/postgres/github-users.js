'use strict';

/**
 * Accounts by GitHub username (migrations/0017_github_profile.sql), as
 * ../github-users.js. app_user is outside row-level security, like every table
 * Better Auth owns.
 */
function createPostgresGithubUsers({pool}) {
  return Object.freeze({
    /** The accounts with these GitHub usernames, keyed by lowercase username. */
    async byLogins(logins) {
      if (!logins.length) return new Map();
      const {rows} = await pool.query(
        `select github_login as login, display_name as name, image, github_bio as bio from app_user
          where lower(github_login) = any(select lower(login) from unnest($1::text[]) as login)`,
        [logins],
      );
      return new Map(rows.map(row => [row.login.toLowerCase(), row]));
    },
    /** The GitHub username of an account, or null before its first sign-in records one. */
    async loginOf(userId) {
      return (await pool.query('select github_login from app_user where id = $1', [userId])).rows[0]?.github_login ?? null;
    },
    /** Take `login` from whichever account holds it, because GitHub now gives it to someone signing in. */
    async release(login) {
      await pool.query('update app_user set github_login = null where lower(github_login) = lower($1)', [login]);
    },
  });
}

module.exports = {createPostgresGithubUsers};
