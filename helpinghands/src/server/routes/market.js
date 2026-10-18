'use strict';

/**
 * The plugin marketplace (/marketplace), for anyone signed in:
 *
 *   GET    /api/market                every plugin: NanoAgent's own, then the uploads
 *   POST   /api/market                publish {url}, a plugin's folder in a public GitHub repository
 *   GET    /api/market/{id}/package   download one, at its latest version
 *   GET    /api/market/{id}/source    for its uploader, the newest commit on GitHub that changed
 *                                     their upload's folder since its latest version, or null
 *   DELETE /api/market/{id}           remove an upload of yours
 *
 * NanoAgent's own plugins come from the NanoAgent service (/v1/packages); the
 * uploads are in PostgreSQL (postgres/market.js). Publishing names a GitHub
 * repository (server/github.js): the commit its ref names now is fetched, and
 * NanoAgent packs the plugin folder in it as a `nanoagent plugin pack` archive,
 * checking every plugin rule without running it. Publishing again takes the
 * ref's newest commit, as a new version newer than the latest (postgres/market.js).
 * Nothing here runs a plugin either: whoever downloads one runs it on their own
 * machine (market-publish.js). A plugin's author is the GitHub account of
 * whoever published it, so publishing takes an account signed in with GitHub.
 * An upload Mochi's NanoAgent now refuses is listed `refused`, with its `refusal` (market-checks.js).
 */
const {checkedUploads} = require('../market-checks');
const {publishFromGithub} = require('../market-publish');
const {MARKET_ROUTE: ROUTE} = require('./paths');

const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sendPackage(res, data, filename) {
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Length': data.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

module.exports = async function market(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match) return;
  const {json, ai, github, readBody, rateLimit, market: uploads} = ctx;
  const userId = req.auth?.userId;
  if (!userId) return json(res, 401, {error: 'Sign in to use the marketplace'});
  if (!uploads) return json(res, 503, {error: 'The marketplace needs PostgreSQL (DATABASE_URL)'});
  const [, id, part] = match;
  if (id !== undefined && !PLUGIN_ID.test(id)) return json(res, 404, {error: 'No plugin by that name'});

  if (req.method === 'GET' && id === undefined) {
    const builtIn = await ai.packages();
    if (builtIn.error) return json(res, builtIn.status, {error: builtIn.error});
    const listed = builtIn.value.packages.map(entry => ({...entry, source: 'nanoagent', owner: null, mine: false}));
    const checked = await checkedUploads({ai, market: uploads}, userId);
    if (checked.error) return json(res, checked.status, {error: checked.error});
    const uploaded = checked.value.map(plugin => ({...plugin, mine: plugin.owner.id === userId}));
    return json(res, 200, {plugins: [...listed, ...uploaded]});
  }

  if (req.method === 'POST' && id === undefined) {
    if (!req.auth.account?.githubLogin) return json(res, 403, {error: 'Sign in with GitHub to publish: a plugin is listed by its publisher\'s GitHub account'});
    if (!await rateLimit(`market-upload:${userId}`, 10)) return json(res, 429, {error: 'Too many uploads. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'The request body must be JSON: {"url": "https://github.com/<owner>/<repo>"}'});
    }
    const published = await publishFromGithub({ai, github, market: uploads}, userId, body?.url);
    if (published.error) return json(res, published.status, {error: published.error});
    return json(res, 201, {plugin: published.plugin});
  }

  if (req.method === 'GET' && part === 'source') {
    const upload = await uploads.get(userId, id);
    if (!upload || upload.owner.id !== userId || !upload.repository) return json(res, 404, {error: `You have no upload named ${id} from GitHub`});
    const newer = await github.newer(upload.repository);
    if (newer.error) return json(res, newer.status, {error: newer.error});
    return json(res, 200, {newer: newer.value});
  }

  if (req.method === 'GET' && part === 'package') {
    const upload = await uploads.get(userId, id);
    if (upload) return sendPackage(res, upload.package, `${upload.id}-${upload.version}.tar.gz`);
    const builtIn = await ai.packageFile(id);
    if (builtIn.error) return json(res, builtIn.status, {error: builtIn.error});
    const filename = /filename="([^"]+)"/.exec(builtIn.headers.get('content-disposition') ?? '')?.[1];
    if (!filename) return json(res, 502, {error: 'NanoAgent sent a package without its file name'});
    return sendPackage(res, builtIn.value, filename);
  }

  if (req.method === 'DELETE' && id !== undefined && !part) {
    if (!await uploads.remove(userId, id)) return json(res, 404, {error: `You have no upload named ${id}`});
    return json(res, 200, {removed: id});
  }

  return json(res, 405, {error: 'Method not allowed'});
};
