/**
 * Signing in with GitHub against a server started with fakeGithubEnv: the
 * browser's half of the OAuth flow, over HTTP. GitHub's half is the fake.
 */
import {fileURLToPath} from 'node:url';

const PRELOAD = fileURLToPath(new URL('./_fake-github.mjs', import.meta.url));

/** The environment that makes the spawned server's GitHub the fake, knowing `users`. */
export function fakeGithubEnv(users) {
  return {
    NODE_OPTIONS: `--import=${PRELOAD}`,
    FAKE_GITHUB_USERS: JSON.stringify(users),
    GITHUB_CLIENT_ID: 'acceptance-client',
    GITHUB_CLIENT_SECRET: 'acceptance-secret',
  };
}

const cookiesOf = response => response.headers.getSetCookie().map(value => value.split(';', 1)[0]);

/**
 * Sign in as GitHub user `login` through /api/auth/sign-in/social and the
 * callback. `request(path, {method, cookie, body})` sends one request to the
 * server. Resolves to `{cookie}` with the session cookie, or `{error}` with the
 * code Better Auth redirected with.
 */
export async function signInWithGithub(request, login) {
  const started = await request('/api/auth/sign-in/social', {method: 'POST', body: {provider: 'github', callbackURL: '/'}});
  if (!started.ok) throw new Error(`sign-in/social answered ${started.status}: ${await started.text()}`);
  const {url} = await started.json();
  const state = new URL(url).searchParams.get('state');
  const callback = await request(
    `/api/auth/callback/github?code=${encodeURIComponent(login)}&state=${encodeURIComponent(state)}`,
    {cookie: cookiesOf(started).join('; ')},
  );
  const location = new URL(callback.headers.get('location'), 'http://callback.invalid');
  const error = location.searchParams.get('error');
  if (error) return {error};
  const session = cookiesOf(callback).find(pair => pair.startsWith('better-auth.session_token='));
  if (!session) throw new Error(`the callback set no session cookie (HTTP ${callback.status}, ${location})`);
  return {cookie: session};
}
