'use strict';

/**
 * RUSH Lab, the app that runs a member's AI and plugins on their own Mac
 * (desktop/src-tauri): its download, and the link that connects it to their account.
 *
 *   PUT /api/lab/bundles/{target}      the release job uploads a target's app, its dmg, with
 *                                      header X-Lab-Stamp and Authorization: Bearer LAB_UPLOAD_TOKEN
 *   GET /api/lab/bundles/{target}      signed in: the target's newest dmg, with X-Lab-Stamp and X-Lab-Sha256
 *   GET /api/lab/connect               signed in: {link}, which the browser hands the app
 *   GET /api/lab/session?token=        {member: {id, login}}: whose the link is, which the app asks
 *                                      the member to confirm
 *   POST /api/lab/session?token=       {session, member: {id, login}}: the app keeps the session as
 *                                      the member's connection on this computer, for its relay,
 *                                      so it connects with no sign-in page
 *   GET /api/lab/sign-in?state=        in the member's browser, which the app's window sends them to
 *                                      to sign in: signed in, back to the app with
 *                                      rushlab://sign-in?state=&token=; signed out, the sign-in page first
 *   GET /api/lab/window-sign-in?token= in the app's window: signs it in as the token's member, and
 *                                      opens the site
 *
 * GitHub's sign-in asks for passkeys the app's window cannot give, so the window
 * signs in through the member's browser, where they are signed in already or
 * sign in as they always do; `state` is the app's, so it takes back only the
 * sign-in it asked for.
 *
 * The link is `rushlab://connect?site=<SITE_URL>&token=<t>`. `t` is a token for the member that
 * lasts an hour (lab-tokens.js), signed with the session secret, so the app needs no session to
 * use it. Targets are aarch64-apple-darwin and x86_64-apple-darwin. Each keeps its newest dmg
 * only, in PostgreSQL (postgres/lab.js), sent on a chunk at a time. Without LAB_UPLOAD_TOKEN set,
 * uploads answer 503.
 */
const crypto = require('crypto');
const {signDownloadToken, verifyDownloadToken} = require('../lab-tokens');
const {signInUrl} = require('../../utils/signIn');

const TARGETS = new Set(['aarch64-apple-darwin', 'x86_64-apple-darwin']);
// What the download is called on the member's computer, by target.
const FILE_NAMES = {'aarch64-apple-darwin': 'RUSH-Lab-Apple-silicon.dmg', 'x86_64-apple-darwin': 'RUSH-Lab-Intel.dmg'};
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const STAMP = /^[A-Za-z0-9._-]{1,128}$/;
const ROUTE = /^\/api\/lab\/(?:(connect)|(session)|(sign-in)|(window-sign-in)|bundles\/([^/]+))$/;
// The app's sign-in state: random, which it names its sign-in by.
const STATE = /^[A-Za-z0-9_-]{16,128}$/;

/** Whether `header` is `Bearer <token>`, compared in constant time. */
function bearerIs(header, token) {
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

/** Write `bundle` to `res` a chunk at a time, waiting while the caller is slow; stop if they go. */
async function sendBundle(res, bundles, userId, bundle) {
  res.writeHead(200, {
    'Content-Type': 'application/x-apple-diskimage',
    'Content-Length': bundle.size,
    'Content-Disposition': `attachment; filename="${FILE_NAMES[bundle.target]}"`,
    'X-Lab-Stamp': bundle.stamp,
    'X-Lab-Sha256': bundle.sha256,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    for await (const data of bundles.chunks(userId, bundle)) {
      if (res.destroyed) break;
      if (!res.write(data)) {
        await new Promise(resolve => {
          const settle = () => { res.off('drain', settle); res.off('close', settle); resolve(); };
          res.on('drain', settle);
          res.on('close', settle);
        });
      }
    }
  } catch (error) {
    // Its length is promised, so a bundle cut short closes the connection.
    console.error('[lab] Could not send a bundle:', error.message);
    res.destroy();
  }
  res.end();
}

module.exports = async function lab(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match) return;
  const {json, lab: {bundles, secret, siteUrl, uploadToken, findMember, createSession, sessionCookie}} = ctx;
  const [, connect, session, signIn, windowSignIn, target] = match;

  if (signIn) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    const state = url.searchParams.get('state');
    if (!STATE.test(state ?? '')) return json(res, 400, {error: 'Sign in from the RUSH Lab app'});
    const location = req.auth?.userId
      ? `rushlab://sign-in?${new URLSearchParams({site: siteUrl, state, token: signDownloadToken(secret, req.auth.userId)})}`
      : signInUrl(`${pathname}?${new URLSearchParams({state})}`);
    res.writeHead(302, {Location: location, 'Cache-Control': 'no-store'});
    return res.end();
  }

  if (windowSignIn) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    const userId = verifyDownloadToken(secret, url.searchParams.get('token'));
    const created = userId && await createSession(userId);
    if (!created) return json(res, 401, {error: 'This sign-in is invalid or has expired. Sign in from the RUSH Lab app again.'});
    res.writeHead(302, {Location: '/', 'Set-Cookie': await sessionCookie(created.token), 'Cache-Control': 'no-store'});
    return res.end();
  }

  if (connect) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    if (!req.auth?.userId) return json(res, 401, {error: 'Sign in to connect RUSH Lab'});
    const query = new URLSearchParams({site: siteUrl, token: signDownloadToken(secret, req.auth.userId)});
    return json(res, 200, {link: `rushlab://connect?${query}`});
  }

  if (session) {
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, {error: 'Method not allowed'});
    const userId = verifyDownloadToken(secret, url.searchParams.get('token'));
    if (!userId) return json(res, 401, {error: 'This connect link is invalid or has expired. Click Connect on RUSH Lab again.'});
    if (req.method === 'GET') {
      const member = await findMember(userId);
      if (!member) return json(res, 401, {error: 'This connect link\'s member is gone'});
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
      return res.end(JSON.stringify({member: {id: userId, login: member.login}}));
    }
    // The same session the device grant gives once a member approves a computer: the link was
    // theirs, shown to them signed in, and they confirmed it in the app, so it stands for that approval.
    const created = await createSession(userId);
    if (!created) return json(res, 401, {error: 'This connect link\'s member is gone'});
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    return res.end(JSON.stringify({session: created.token, member: {id: userId, login: created.login}}));
  }

  if (req.method === 'PUT') {
    if (!uploadToken) return json(res, 503, {error: 'Uploading RUSH Lab is not configured: set LAB_UPLOAD_TOKEN'});
    if (!bearerIs(req.headers.authorization, uploadToken)) return json(res, 401, {error: 'Uploading RUSH Lab takes Authorization: Bearer LAB_UPLOAD_TOKEN'});
    if (!bundles) return json(res, 503, {error: 'RUSH Lab bundles need PostgreSQL (DATABASE_URL)'});
    if (!TARGETS.has(target)) return json(res, 400, {error: `The target is one of ${[...TARGETS].join(', ')}`});
    const stamp = req.headers['x-lab-stamp'];
    if (!STAMP.test(stamp ?? '')) return json(res, 400, {error: 'Name the bundle in X-Lab-Stamp: letters, digits, ".", "_" and "-"'});
    if (Number(req.headers['content-length']) > MAX_BUNDLE_BYTES) {
      return json(res, 413, {error: `A bundle may be ${MAX_BUNDLE_BYTES / 1024 / 1024} MB at most`});
    }
    try {
      return json(res, 200, await bundles.replace(target, stamp, req, MAX_BUNDLE_BYTES));
    } catch (error) {
      if (!error.status) throw error;
      return json(res, error.status, {error: error.message});
    }
  }

  if (req.method === 'GET') {
    const userId = req.auth?.userId;
    if (!userId) return json(res, 401, {error: 'Sign in to download RUSH Lab'});
    if (!bundles) return json(res, 503, {error: 'RUSH Lab bundles need PostgreSQL (DATABASE_URL)'});
    const bundle = TARGETS.has(target) ? await bundles.bundle(userId, target) : null;
    if (!bundle) return json(res, 404, {error: `No RUSH Lab app for ${target} yet`});
    return sendBundle(res, bundles, userId, bundle);
  }

  return json(res, 405, {error: 'Method not allowed'});
};
