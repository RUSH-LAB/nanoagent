/**
 * The server's half of the plugin contract.
 *
 * A tool in this codebase is a directory under plugins/, and plugins/loader.js
 * defines what that means and does the finding. The build half it loads is the
 * plugin's pages, its data, the command that opens it; this is the other half:
 * the endpoints it serves, and what it lends the rest of the server.
 *
 * A plugin is loaded here when it has a server.js, and that file exports a
 * (req, res, url, pathname, api) function. The shape matches a core route
 * module's, but the last argument does not: core gets `ctx`, the server's own
 * object, and a plugin gets the narrow API in ./plugin-api.js, built from the
 * capabilities its plugin.json asks for. That is the whole point. A plugin
 * holding `fs` could read the repository, and a plugin reading `ctx` would break
 * on any rename in core.
 *
 * It may also export `provides`, merged into what every plugin and every core
 * handler can see, which is how one plugin's data reaches code that is not part
 * of it: the bibliography publishes `references`, and the core handlers that
 * answer questions about it read that rather than requiring its files.
 *
 * Discovery is a directory listing rather than a list in a config file, so
 * adding a tool is adding a directory. The order is alphabetical and therefore
 * stable, which matters because the dispatcher runs route modules in order and
 * the first one to answer wins.
 */
const {PLUGINS_DIR, listPlugins, requireSlot} = require('../../plugins/loader');
const {API_VERSION, buildPluginApi} = require('./plugin-api');

/**
 * Every enabled plugin with a server half, as {name, routes, provides}.
 *
 * A plugin that throws while loading is reported and skipped by the loader
 * rather than taking the server down with it: one broken tool should not stop
 * the site, and the console line says which one to look at.
 */
function loadServerPlugins(dir = PLUGINS_DIR) {
  const loaded = [];
  for (const plugin of listPlugins(dir)) {
    const routes = requireSlot(plugin, 'server');
    if (!routes) continue;
    const {apiVersion, requires} = plugin.manifest;
    if (apiVersion !== API_VERSION) {
      console.error(
        `[plugins] ${plugin.name}/server.js declares apiVersion ${apiVersion ?? 'none'}, `
        + `this server offers ${API_VERSION}; skipped`,
      );
      continue;
    }
    loaded.push({name: plugin.name, routes, requires, provides: routes.provides ?? {}});
  }
  return loaded;
}

/**
 * Wrap a plugin's handler so the dispatcher can call it like any other route
 * module while the plugin itself never sees ctx.
 *
 * The API is built per request rather than once, because half of it is the
 * request: who is calling, and what the body says.
 */
function asRouteModule(plugin, getProvides) {
  const handler = async function plugin_routes(req, res, url, pathname, ctx) {
    return plugin.routes(req, res, url, pathname, buildPluginApi({
      name: plugin.name,
      requires: plugin.requires,
      ctx: {...ctx, pluginProvides: getProvides()},
      req,
    }));
  };
  Object.defineProperty(handler, 'name', {value: `${plugin.name}_routes`});
  return handler;
}

/**
 * Everything the loaded plugins publish, merged.
 *
 * Two plugins claiming the same name is a mistake worth hearing about rather
 * than resolving silently, since the loser would simply stop working.
 */
function collectProvides(plugins) {
  const provided = {};
  for (const plugin of plugins) {
    for (const [key, value] of Object.entries(plugin.provides)) {
      if (key in provided) {
        console.error(`[plugins] ${plugin.name} and another plugin both provide "${key}"; keeping the first`);
        continue;
      }
      provided[key] = value;
    }
  }
  return provided;
}

module.exports = {PLUGINS_DIR, API_VERSION, loadServerPlugins, collectProvides, asRouteModule};
