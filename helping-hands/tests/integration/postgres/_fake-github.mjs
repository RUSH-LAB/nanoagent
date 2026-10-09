/**
 * GitHub, for a server under test: loaded into it with `--import`, this answers
 * the requests Better Auth and root-account.js send to github.com and
 * api.github.com from FAKE_GITHUB_USERS, a JSON list of profiles
 * `{id, login, name, email, verified}`. The authorization code is the login,
 * so a test signs in as a user by sending that login back to the callback.
 * Everything else is the server's own code, unchanged.
 */
const users = JSON.parse(process.env.FAKE_GITHUB_USERS);
const byLogin = login => users.find(user => user.login === login);
const realFetch = globalThis.fetch;

const profile = ({verified, ...user}) => user;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
    const login = new URLSearchParams(String(init.body)).get('code');
    if (!byLogin(login)) return Response.json({error: 'bad_verification_code'});
    return Response.json({access_token: `token-${login}`, token_type: 'bearer', scope: 'read:user,user:email'});
  }
  if (url.origin === 'https://api.github.com') {
    const named = url.pathname.match(/^\/users\/([^/]+)$/);
    if (named) {
      const user = byLogin(decodeURIComponent(named[1]));
      return user ? Response.json(profile(user)) : Response.json({message: 'Not Found'}, {status: 404});
    }
    const authorization = new Headers(init.headers).get('authorization') ?? '';
    const user = byLogin(authorization.replace(/^Bearer token-/, ''));
    if (!user) return Response.json({message: 'Bad credentials'}, {status: 401});
    if (url.pathname === '/user') return Response.json(profile(user));
    if (url.pathname === '/user/emails') return Response.json([{email: user.email, primary: true, verified: user.verified}]);
  }
  return realFetch(input, init);
};
