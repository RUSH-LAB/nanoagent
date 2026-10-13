'use strict';

/**
 * Accounts by GitHub username (migrations/0017_github_profile.sql). A blog post
 * names its authors by GitHub username, and its byline is what GitHub said
 * about each at their last sign-in.
 */
const TIMEOUT_MS = 30000;
// GitHub's rule for a username: letters, digits and single inner hyphens, at most 39.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** `raw` as a GitHub username, without the '@' it may be written with, or null when it cannot be one. */
function githubLoginOf(raw) {
  const login = String(raw ?? '').trim().replace(/^@/, '');
  return LOGIN_RE.test(login) ? login : null;
}

/**
 * GitHub's public profile of `login`, or null when GitHub has no such user.
 * Throws when GitHub does not answer either way.
 */
async function githubProfile(login, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'mochi'},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub did not answer for ${login} (HTTP ${response.status})`);
  return response.json();
}

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

module.exports = {createGithubUsers, githubProfile, githubLoginOf};
