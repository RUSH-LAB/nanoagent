'use strict';

/**
 * Mochi Lab without its window: the one-line install that lets a member who
 * uses Mochi in the browser run their AI and plugins on their own Mac.
 *
 *   PUT /api/lab/bundles/{target}      the release job uploads a target's bundle: the raw
 *                                      gzip tarball, header X-Lab-Stamp, and
 *                                      Authorization: Bearer LAB_UPLOAD_TOKEN
 *   GET /api/lab/install               signed in: {command}, the line the member pastes in a terminal
 *   GET /api/lab/install.sh?token=     the install script that line runs (src/runner/install.sh)
 *   GET /api/lab/bundles/{target}      the target's newest bundle, by ?token= or a session,
 *                                      with X-Lab-Stamp and X-Lab-Sha256
 *
 * The command is `curl -fsSL '<SITE_URL>/api/lab/install.sh?token=<t>' | sh`.
 * `t` is a download token for the member that lasts an hour (lab-tokens.js),
 * signed with the session secret, so curl needs no session; the script gets
 * the site and the token in place of `__MOCHI_SITE__` and `__MOCHI_TOKEN__`,
 * to download the bundle with and then open the sign-in page Mochi Lab's
 * relay asks for. Targets are aarch64-apple-darwin and x86_64-apple-darwin.
 * Each keeps its newest bundle only, in PostgreSQL (postgres/lab.js), sent on
 * a chunk at a time. Without LAB_UPLOAD_TOKEN set, uploads answer 503.
 */
const crypto = require('crypto');
const fs = require('fs/promises');
const {signDownloadToken, verifyDownloadToken} = require('../lab-tokens');

const TARGETS = new Set(['aarch64-apple-darwin', 'x86_64-apple-darwin']);
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const STAMP = /^[A-Za-z0-9._-]{1,128}$/;
const ROUTE = /^\/api\/lab\/(?:(install)|(install\.sh)|bundles\/([^/]+))$/;

/** Whether `header` is `Bearer <token>`, compared in constant time. */
function bearerIs(header, token) {
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

/**
 * A script for `| sh` that says why there is no install, and fails. It is answered 200: the
 * command's `curl -f` would drop the body of an error status, and `sh` would say nothing.
 */
function refuseScript(res, message) {
  res.writeHead(200, {'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(`echo 'Mochi Lab: ${message}' >&2\nexit 1\n`);
}

/** Write `bundle` to `res` a chunk at a time, waiting while the caller is slow; stop if they go. */
async function sendBundle(res, bundles, userId, bundle) {
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Length': bundle.size,
    'Content-Disposition': `attachment; filename="mochi-lab-${bundle.target}.tar.gz"`,
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
  const {json, lab: {bundles, secret, siteUrl, uploadToken, installScript}} = ctx;
  const [, install, script, target] = match;

  if (install) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    if (!req.auth?.userId) return json(res, 401, {error: 'Sign in to install Mochi Lab'});
    const token = signDownloadToken(secret, req.auth.userId);
    return json(res, 200, {command: `curl -fsSL '${siteUrl}/api/lab/install.sh?token=${token}' | sh`});
  }

  if (script) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
    const token = url.searchParams.get('token');
    if (!verifyDownloadToken(secret, token)) {
      return refuseScript(res, 'this install link is invalid or has expired. Copy the command again from Settings, AI, on Mochi.');
    }
    const body = (await fs.readFile(installScript, 'utf8'))
      .replaceAll('__MOCHI_SITE__', siteUrl).replaceAll('__MOCHI_TOKEN__', token);
    res.writeHead(200, {'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store'});
    return res.end(body);
  }

  if (req.method === 'PUT') {
    if (!uploadToken) return json(res, 503, {error: 'Uploading Mochi Lab bundles is not configured: set LAB_UPLOAD_TOKEN'});
    if (!bearerIs(req.headers.authorization, uploadToken)) return json(res, 401, {error: 'Uploading a bundle takes Authorization: Bearer LAB_UPLOAD_TOKEN'});
    if (!bundles) return json(res, 503, {error: 'Mochi Lab bundles need PostgreSQL (DATABASE_URL)'});
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
    const token = url.searchParams.get('token');
    const userId = token === null ? req.auth?.userId : verifyDownloadToken(secret, token);
    if (!userId) return json(res, 401, {error: token === null ? 'Sign in to download Mochi Lab' : 'This download link is invalid or has expired'});
    if (!bundles) return json(res, 503, {error: 'Mochi Lab bundles need PostgreSQL (DATABASE_URL)'});
    const bundle = TARGETS.has(target) ? await bundles.bundle(userId, target) : null;
    if (!bundle) return json(res, 404, {error: `No Mochi Lab bundle for ${target}`});
    return sendBundle(res, bundles, userId, bundle);
  }

  return json(res, 405, {error: 'Method not allowed'});
};
