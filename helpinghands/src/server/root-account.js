'use strict';

/**
 * The root account: the GitHub account named by ROOT_GITHUB_LOGIN, which
 * administers the platform.
 *
 * Provisioned at startup rather than on its first sign-in, so the sign-up
 * policy never stands between a fresh database and its administrator: the
 * account exists before GitHub ever sends root back, and the sign-in finds it by
 * GitHub's numeric account id. The login is resolved to that id here because a
 * login can be renamed and then claimed by someone else; the id cannot.
 */
const {createOAuthAccountIssuer} = require('better-auth/db');
const {githubProfileFields} = require('./workspace-auth');
const {githubProfile} = require('./github-users');

/**
 * The root user's id, creating the user and its GitHub account when this
 * database has neither. A verified user who already has root's public email
 * gets the GitHub account linked, the way Better Auth links at sign-in.
 */
async function ensureRootAccount(auth, {login = process.env.ROOT_GITHUB_LOGIN?.trim(), fetchImpl = fetch} = {}) {
  if (!login) throw new Error('RUSH requires ROOT_GITHUB_LOGIN, the GitHub account that administers the platform.');
  const profile = await githubProfile(login, fetchImpl);
  if (!profile) throw new Error(`GitHub has no user ${login}`);
  const {internalAdapter} = await auth.$context;
  const key = {issuer: createOAuthAccountIssuer('github'), accountId: String(profile.id)};

  const owner = await internalAdapter.findAccountOwnerByKey(key);
  if (owner?.kind === 'orphaned') throw new Error(`The GitHub account of ${login} references a missing user`);
  if (owner) {
    // Root's GitHub username and bio, current from this start until its next sign-in.
    await internalAdapter.updateUser(owner.user.id, githubProfileFields(profile));
    return {userId: owner.user.id, login: profile.login, created: false};
  }

  const email = (profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`).toLowerCase();
  const existing = (await internalAdapter.findUserByEmail(email))?.user;
  if (existing && !existing.emailVerified) throw new Error(`An unverified account already uses ${email}, root's GitHub email`);
  const user = existing
    ? await internalAdapter.updateUser(existing.id, githubProfileFields(profile))
    : await internalAdapter.createUser({
      name: profile.name || profile.login, email, emailVerified: true, image: profile.avatar_url, ...githubProfileFields(profile),
    });
  await internalAdapter.createAccount({userId: user.id, providerId: 'github', ...key});
  return {userId: user.id, login: profile.login, created: true};
}

module.exports = {ensureRootAccount};
