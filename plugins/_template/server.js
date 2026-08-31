'use strict';
/**
 * __TITLE__: the API half.
 *
 * Takes (req, res, url, pathname, api). The shape matches a core route module in
 * src/server/routes/, because a plugin's endpoints are not a different kind of
 * endpoint, but the last argument does not: core gets the server's own `ctx`,
 * and a plugin gets the narrow API in src/server/plugin-api.js, built from the
 * capabilities its plugin.json asks for.
 *
 * Answer with api.respond and return; the dispatcher detects a sent response
 * through res.writableEnded and stops looking. Fall through silently for
 * anything this plugin does not own.
 *
 * Always available: respond, stream, readBody, rateLimit, caller, shared,
 * sanitize. Everything else is a capability the manifest has to ask for —
 * "cache", "content:read", "content:write", "network", "storage" — and one that
 * was not asked for is simply absent, so reaching for it fails loudly here
 * rather than quietly acquiring reach nobody granted.
 */

/** The largest page this endpoint will hand back, however much is asked for. */
const MAX_LIMIT = 100;

module.exports = async function __CAMEL___routes(req, res, url, pathname, api) {
  const {respond} = api;

  if (req.method === 'GET' && pathname === '/api/__NAME__/items') {
    const asked = parseInt(url.searchParams.get('limit'), 10);
    const limit = Math.min(Number.isNaN(asked) ? 20 : asked, MAX_LIMIT);
    return respond(res, 200, {items: [], limit});
  }
};

// What this plugin lends the rest of the server, merged into what every plugin
// and every core handler can see. Only for data other modules genuinely need: a
// core handler reads it and degrades honestly when no plugin is providing it,
// rather than reaching into plugins/ with a relative require. Delete if nothing
// needs it.
//
// module.exports.provides = {__CAMEL__: {}};
