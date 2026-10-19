'use strict';

/**
 * RUSH Lab, the app that runs a member's AI and plugins on their own Mac or Windows PC
 * (desktop/src-tauri): its download, and the link that connects it to their account.
 *
 *   PUT /api/lab/bundles/{target}      the release job uploads a target's app, its dmg or Windows
 *                                      installer, with header X-Lab-Stamp and Authorization: Bearer LAB_UPLOAD_TOKEN
 *   GET /api/lab/bundles/{target}      anyone: the target's newest app, with X-Lab-Stamp and X-Lab-Sha256
 *   PUT /api/lab/updates/{target}      the release job uploads a target's update, the updater's archive
 *                                      (RUSH Lab.app.tar.gz on macOS; on Windows the installer again),
 *                                      with X-Lab-Stamp, X-Lab-Signature (its .sig) and Authorization: Bearer LAB_UPLOAD_TOKEN
 *   GET /api/lab/updates/{target}      anyone: what the app's updater asks (desktop/src-tauri/src/update.rs),
 *                                      {version, url, signature}, 204 while there is none
 *   GET /api/lab/updates/{target}/app.tar.gz   anyone: that update's archive
 *   PUT /api/lab/engine                the release job uploads the engine, what every target's app runs
 *                                      (lab.mjs, the relay and NanoAgent, desktop/scripts/engine.mjs), with
 *                                      X-Lab-Stamp, X-Lab-Signature (its .sig), X-Lab-Shell (the shell it
 *                                      runs in) and Authorization: Bearer LAB_UPLOAD_TOKEN
 *   GET /api/lab/engine                anyone: what the app asks (desktop/src-tauri/src/engine.rs),
 *                                      {stamp, shell, sha256, signature, url}, 204 while there is none
 *   GET /api/lab/engine/engine.tar.gz  anyone: that engine's archive
 *   GET /api/lab/releases              anyone: what the app follows (desktop/src-tauri/src/releases.rs), a
 *                                      stream of `release` events, {engine, updates: {target: version}},
 *                                      each null while there is none: one as it opens, and one as each
 *                                      update or engine is uploaded
 *   GET /install.sh                    anyone: the script that installs the app on a Mac (lab-install.js),
 *                                      curl -fsSL <SITE_URL>/install.sh | sh
 *   GET /install.ps1                   anyone: the script that installs the app on Windows (lab-install.js),
 *                                      irm <SITE_URL>/install.ps1 | iex
 *   GET /api/lab/connect               signed in: {link}, which the browser hands the app
 *   GET /api/lab/session?token=        {member: {id, login}}: whose the link is, which the app asks
 *                                      the member to confirm
 *   POST /api/lab/session?token=       {session, member: {id, login}}: the app keeps the session as
 *                                      the member's connection on this computer, for its relay,
 *                                      so it connects with no sign-in page
 *   GET /api/lab/sign-in?state=        in macOS's sign-in sheet over the app's window, which opens it
 *                                      to sign in: signed in, back to the app with
 *                                      <scheme>://sign-in?state=&token=; signed out, the sign-in page first
 *   GET /api/lab/window-sign-in?token= in the app's window: signs it in as the token's member, and
 *                                      opens the site
 *
 * GitHub's sign-in asks for passkeys the app's window cannot give, so the window
 * signs in in macOS's sign-in sheet, where passkeys work and Safari's sign-ins
 * carry over; `state` is the app's, so it takes back only the sign-in it asked for.
 *
 * The link is `<scheme>://connect?site=<SITE_URL>&token=<t>`, `scheme` the links of the app that
 * serves this site (lab-app.js servedApp). `t` is a token for the member that
 * lasts an hour (lab-tokens.js), signed with the session secret, so the app needs no session to
 * use it. Targets are aarch64-apple-darwin, x86_64-apple-darwin and x86_64-pc-windows-msvc. Each
 * keeps its newest app and update only, and the site its newest engine, in PostgreSQL
 * (postgres/lab.js), sent a chunk at a time. An update's version is the one its signature was made
 * for, which the updater checks it against; an engine is signed with the same key, and the app checks
 * its sha256 and signature, and takes it only for the shell it names. Without LAB_UPLOAD_TOKEN set, uploads answer 503.
 */
const crypto = require('crypto');
const {signDownloadToken, verifyDownloadToken} = require('../lab-tokens');
const {signInUrl} = require('../../utils/signIn');
const {INSTALL_SCRIPTS} = require('../lab-install');
const {LAB_ROUTE: ROUTE} = require('./paths');

const DMG = 'application/x-apple-diskimage';
// The engine is one archive for every target.
const ENGINE = 'any';
const GZIP = 'application/gzip';
const EXE = 'application/vnd.microsoft.portable-executable';
// How each target's bundles are sent: their type, and what each is called on the member's computer.
// Windows' installer is its update too, which the updater runs over the app.
const DOWNLOADS = {
  'aarch64-apple-darwin': {app: [DMG, 'RUSH-Lab-Apple-silicon.dmg'], update: [GZIP, 'RUSH-Lab-aarch64-apple-darwin.app.tar.gz']},
  'x86_64-apple-darwin': {app: [DMG, 'RUSH-Lab-Intel.dmg'], update: [GZIP, 'RUSH-Lab-x86_64-apple-darwin.app.tar.gz']},
  'x86_64-pc-windows-msvc': {app: [EXE, 'RUSH-Lab-Setup.exe'], update: [EXE, 'RUSH-Lab-Setup.exe']},
  [ENGINE]: {engine: [GZIP, 'RUSH-Lab-engine.tar.gz']},
};
const TARGETS = new Set(Object.keys(DOWNLOADS).filter(target => target !== ENGINE));
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const STAMP = /^[A-Za-z0-9._-]{1,128}$/;
// What `tauri signer sign` writes to a .sig: base64.
const SIGNATURE = /^[A-Za-z0-9+/]{1,4096}={0,2}$/;
// The shell an engine runs in: the git tree of desktop/ (desktop/scripts/shell.mjs).
const SHELL = /^[0-9a-f]{40}$/;
// The app's sign-in state: random, which it names its sign-in by.
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
// The stream of releases outlives the server's idle limit; the heartbeat keeps proxies from closing it.
const HEARTBEAT_MS = 25_000;
// The responses of the apps following the releases.
const followers = new Set();

/** The version an update's signature (its .sig) was made for, which its trusted comment names, or null. */
function signedVersion(signature) {
  return /^trusted comment: .*\tversion:(\d+\.\d+\.\d+)$/m.exec(Buffer.from(signature, 'base64').toString('utf8'))?.[1] ?? null;
}

/** What this site serves, as a `release` event: its engine's stamp and each target's update's version, null while it has none. */
async function release(bundles) {
  const engine = await bundles.bundle(ENGINE, 'engine');
  const updates = {};
  for (const target of TARGETS) {
    const update = await bundles.bundle(target, 'update');
    updates[target] = update ? signedVersion(update.signature) : null;
  }
  return `event: release\ndata: ${JSON.stringify({engine: engine?.stamp ?? null, updates})}\n\n`;
}

/** Whether `header` is `Bearer <token>`, compared in constant time. */
function bearerIs(header, token) {
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

/** Write `bundle` to `res` a chunk at a time, waiting while the caller is slow; stop if they go. */
async function sendBundle(res, bundles, bundle) {
  const [type, name] = DOWNLOADS[bundle.target][bundle.kind];
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': bundle.size,
    'Content-Disposition': `attachment; filename="${name}"`,
    'X-Lab-Stamp': bundle.stamp,
    'X-Lab-Sha256': bundle.sha256,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    for await (const data of bundles.chunks(bundle)) {
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
  const {json, lab: {bundles, secret, siteUrl, scheme, uploadToken, findMember, createSession, sessionCookie}} = ctx;
  const install = INSTALL_SCRIPTS.get(pathname);
  if (install) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    res.writeHead(200, {'Content-Type': `${install.type}; charset=utf-8`, 'Cache-Control': 'no-cache'});
    return res.end(install.script(siteUrl));
  }
  const match = ROUTE.exec(pathname);
  if (!match) return;
  const [, connect, session, signIn, windowSignIn, appTarget, updateTarget, updateArchive, engine, engineArchive, releases] = match;
  const kind = engine ? 'engine' : updateTarget ? 'update' : 'app';
  const target = engine ? ENGINE : appTarget ?? updateTarget;
  const archive = updateArchive ?? engineArchive;

  if (signIn) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    const state = url.searchParams.get('state');
    if (!STATE.test(state ?? '')) return json(res, 400, {error: 'Sign in from the RUSH Lab app'});
    const location = req.auth?.userId
      ? `${scheme}://sign-in?${new URLSearchParams({site: siteUrl, state, token: signDownloadToken(secret, req.auth.userId)})}`
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
    return json(res, 200, {link: `${scheme}://connect?${query}`});
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

  if (releases) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    if (!bundles) return json(res, 503, {error: 'RUSH Lab bundles need PostgreSQL (DATABASE_URL)'});
    // Listened for first: an app gone while the stream opens still stops it.
    const closed = new Promise(resolve => res.on('close', resolve));
    const first = await release(bundles);
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'});
    req.setTimeout(0);
    res.write(first);
    followers.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    await closed;
    clearInterval(heartbeat);
    followers.delete(res);
    return res.end();
  }

  if (archive && req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});

  if (req.method === 'PUT') {
    if (!uploadToken) return json(res, 503, {error: 'Uploading RUSH Lab is not configured: set LAB_UPLOAD_TOKEN'});
    if (!bearerIs(req.headers.authorization, uploadToken)) return json(res, 401, {error: 'Uploading RUSH Lab takes Authorization: Bearer LAB_UPLOAD_TOKEN'});
    if (!bundles) return json(res, 503, {error: 'RUSH Lab bundles need PostgreSQL (DATABASE_URL)'});
    if (kind !== 'engine' && !TARGETS.has(target)) return json(res, 400, {error: `The target is one of ${[...TARGETS].join(', ')}`});
    const stamp = req.headers['x-lab-stamp'];
    if (!STAMP.test(stamp ?? '')) return json(res, 400, {error: 'Name the bundle in X-Lab-Stamp: letters, digits, ".", "_" and "-"'});
    const signature = kind === 'app' ? null : req.headers['x-lab-signature'];
    if (kind === 'update' && !(SIGNATURE.test(signature ?? '') && signedVersion(signature))) {
      return json(res, 400, {error: 'Send the update\'s signature, its .sig, which names its version, in X-Lab-Signature'});
    }
    if (kind === 'engine' && !SIGNATURE.test(signature ?? '')) return json(res, 400, {error: 'Send the engine\'s signature, its .sig, in X-Lab-Signature'});
    const shell = kind === 'engine' ? req.headers['x-lab-shell'] : null;
    if (kind === 'engine' && !SHELL.test(shell ?? '')) return json(res, 400, {error: 'Name the shell the engine runs in, the git tree of desktop/, in X-Lab-Shell'});
    if (Number(req.headers['content-length']) > MAX_BUNDLE_BYTES) {
      return json(res, 413, {error: `A bundle may be ${MAX_BUNDLE_BYTES / 1024 / 1024} MB at most`});
    }
    try {
      const stored = await bundles.replace({target, kind, stamp, signature, shell}, req, MAX_BUNDLE_BYTES);
      // Each app following the releases hears of it at once.
      if (kind !== 'app') {
        const news = await release(bundles);
        for (const follower of followers) follower.write(news);
      }
      return json(res, 200, stored);
    } catch (error) {
      if (!error.status) throw error;
      return json(res, error.status, {error: error.message});
    }
  }

  if (req.method === 'GET') {
    if (!bundles) return json(res, 503, {error: 'RUSH Lab bundles need PostgreSQL (DATABASE_URL)'});
    const bundle = kind === 'engine' || TARGETS.has(target) ? await bundles.bundle(target, kind) : null;
    // The app's question: the engine this site serves, or 204 for none.
    if (kind === 'engine' && !archive) {
      if (!bundle) {
        res.writeHead(204, {'Cache-Control': 'no-cache'});
        return res.end();
      }
      const {stamp, shell, sha256, signature} = bundle;
      return json(res, 200, {stamp, shell, sha256, signature, url: `${siteUrl}/api/lab/engine/engine.tar.gz`});
    }
    // The updater's question: the build this site serves, or 204 for none.
    if (kind === 'update' && !archive && TARGETS.has(target)) {
      if (!bundle) {
        res.writeHead(204, {'Cache-Control': 'no-cache'});
        return res.end();
      }
      return json(res, 200, {version: signedVersion(bundle.signature), url: `${siteUrl}/api/lab/updates/${target}/app.tar.gz`, signature: bundle.signature});
    }
    if (!bundle) return json(res, 404, {error: kind === 'engine' ? 'No RUSH Lab engine yet' : `No RUSH Lab ${kind === 'update' ? 'update' : 'app'} for ${target} yet`});
    return sendBundle(res, bundles, bundle);
  }

  return json(res, 405, {error: 'Method not allowed'});
};
