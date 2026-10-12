'use strict';

/**
 * Accounts by GitHub username (migrations/0017_github_profile.sql). A blog post
 * names its authors by GitHub username, and its byline is what GitHub said
 * about each at their last sign-in.
 */
function createGithubUsers({db = require('./db').db} = {}) {
  const loginOf = db.prepare('SELECT "githubLogin" AS login FROM "user" WHERE id = ?');
  const release = db.prepare('UPDATE "user" SET "githubLogin" = NULL WHERE lower("githubLogin") = lower(?)');
  return Object.freeze({
    /** The accounts with these GitHub usernames, keyed by lowercase username. */
    async byLogins(logins) {
      if (!logins.length) return new Map();
      const rows = db.prepare(
        `SELECT "githubLogin" AS login, name, image, "githubBio" AS bio FROM "user"
          WHERE lower("githubLogin") IN (${logins.map(() => 'lower(?)').join(', ')})`,
      ).all(...logins);
      return new Map(rows.map(row => [row.login.toLowerCase(), row]));
    },
    /** The GitHub username of an account, or null before its first sign-in records one. */
    async loginOf(userId) {
      return loginOf.get(userId)?.login ?? null;
    },
    /** Take `login` from whichever account holds it, because GitHub now gives it to someone signing in. */
    async release(login) {
      release.run(login);
    },
  });
}

module.exports = {createGithubUsers};
