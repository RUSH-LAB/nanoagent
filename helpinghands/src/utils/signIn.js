/**
 * Which pages need a session, and where a visitor without one is sent.
 *
 * The server that sends a page decides, before any of it is sent: a visitor who
 * is signed out is redirected to the sign-in page rather than handed the page
 * to paint while the browser asks whether they may see it. The production
 * server (server/index.js), the development server (docusaurus.config.js), and
 * the browser's own gate (theme/Root.js) all ask this module, so they agree.
 *
 * CommonJS for the same reason as utils/paths.js: the server needs it too.
 */

/** The sign-in page (pages/signin). */
const SIGN_IN_PATH = '/signin';

/**
 * Pages anyone may open.
 *
 * The sign-in page itself, and /join: an invitation link is followed by
 * somebody who has no account yet, and /join is written for exactly that
 * visitor, reading the invitation without a session and saying which
 * workspace, who sent it, and which address it names.
 */
const OPEN = [SIGN_IN_PATH, '/join'];

/**
 * A workspace's documents, which a visitor who is signed out may read when the
 * workspace publishes them. The page itself asks the public API and says
 * "not found" for anything unpublished.
 */
const PUBLISHED = /^\/w\/[^/]+\/documents(?:\/|$)/;

function isOpenPage(pathname) {
  return OPEN.some(page => pathname === page || pathname.startsWith(`${page}/`))
    || PUBLISHED.test(pathname);
}

/** The sign-in page, with or without its trailing slash. */
function isSignInPage(pathname) {
  return pathname.replace(/\/$/, '') === SIGN_IN_PATH;
}

/**
 * Whether the answer to a request depends on the session: a browser navigation
 * (it accepts HTML) to a page rather than a file, which is either a page that
 * needs a session or the sign-in page, which somebody signed in skips. Scripts,
 * styles, and images carry no workspace data and pass, and so does the API,
 * which answers for itself: RUSH Lab's window opens /api/lab/window-sign-in
 * signed out, to sign in.
 */
function asksForSession({method, headers, url}) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!String(headers.accept || '').includes('text/html')) return false;
  const {pathname} = new URL(url, 'http://localhost');
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  if (/\.[^/]+$/.test(pathname) && !pathname.endsWith('.html')) return false;
  return isSignInPage(pathname) || !isOpenPage(pathname);
}

/**
 * Where a request that asks for the session goes instead, or null to serve it:
 * somebody signed out to the sign-in page, and somebody signed in from the
 * sign-in page to where they were going.
 */
function redirectFor({url}, signedIn) {
  const {pathname, search} = new URL(url, 'http://localhost');
  if (isSignInPage(pathname)) return signedIn ? nextFrom(search) : null;
  return signedIn ? null : signInUrl(url);
}

/** The sign-in page, remembering where the visitor was going. */
function signInUrl(destination) {
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(destination)}`;
}

/**
 * Where to go after signing in, from the sign-in page's query string. Only a
 * path on this site: `next` arrives in a URL anybody can write, and following
 * it to another origin would make the sign-in page an open redirect.
 */
function nextFrom(search) {
  const next = new URLSearchParams(search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

module.exports = {isOpenPage, isSignInPage, asksForSession, redirectFor, signInUrl, nextFrom};
