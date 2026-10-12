/**
 * Accounts for the server suites, as a GitHub sign-in leaves them: a user with
 * a verified email, its GitHub account, and a session whose cookie a browser
 * would hold. GitHub itself is the one part not exercised; everything from the
 * account rows to the session cookie is Better Auth's own.
 */
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createOAuthAccountIssuer} = require('better-auth/db');
const {serializeSignedCookie} = require('better-call');

let nextGithubId = 1;

/** A new session for `userId`, as its `name=value` cookie. */
export async function sessionCookie(auth, userId) {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  return (await serializeSignedCookie(context.authCookies.sessionToken.name, session.token, context.secret))
    .split(';')[0];
}

/** A signed-in GitHub account: `{id, cookie}`. */
export async function githubAccount(auth, name, email = `${name}@test.invalid`) {
  const {internalAdapter} = await auth.$context;
  const user = await internalAdapter.createUser({name, email, emailVerified: true});
  await internalAdapter.createAccount({
    userId: user.id, providerId: 'github', issuer: createOAuthAccountIssuer('github'), accountId: String(nextGithubId++),
  });
  return {id: user.id, cookie: await sessionCookie(auth, user.id)};
}
