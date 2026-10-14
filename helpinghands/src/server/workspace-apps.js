'use strict';

/**
 * A workspace's apps: the marketplace plugins it added (postgres/workspace-plugins.js),
 * each run from NanoAgent's install of the plugin's current package.
 *
 * The marketplace offers NanoAgent's own packages and the uploads
 * (postgres/market.js), one id each: an upload may not take one of NanoAgent's.
 * A workspace keeps only which ids it added, so it always runs a plugin's
 * latest version. NanoAgent installs a package by its sha256 and keeps it until
 * it restarts; opening an app sends the package when NanoAgent has no install
 * of it, which takes as long as building the plugin's environment, once.
 */
function createWorkspaceApps({ai, market, plugins}) {
  /** Every plugin a workspace may add, by id: `{value: Map<id, {source, entry}>}` or `{error, status}`. */
  async function catalog(userId) {
    const builtIn = await ai.packages();
    if (builtIn.error) return builtIn;
    const offered = new Map(builtIn.value.packages.map(entry => [entry.id, {source: 'nanoagent', entry}]));
    for (const entry of await market.list(userId)) offered.set(entry.id, {source: 'upload', entry});
    return {value: offered};
  }

  /** The install of `entry`'s package on the NanoAgent `on`, sending it first when it has none. */
  async function installed(on, userId, source, entry) {
    const found = await on.install(entry.sha256);
    if (found.status !== 404) return found.error ? found : {value: found.value.plugin};
    const data = source === 'upload'
      ? {value: (await market.get(userId, entry.id))?.package}
      : await ai.packageFile(entry.id);
    if (data.error) return data;
    if (!data.value) return {error: `${entry.id} is no longer in the marketplace`, status: 404};
    const put = await on.installPackage(entry.sha256, data.value);
    return put.error ? put : {value: put.value.plugin};
  }

  /**
   * The workspace's apps, each its marketplace entry, `source` and the
   * workspace's `tags` for it; one that left the marketplace is listed as
   * `unavailable`, for an owner to remove.
   */
  async function list(context) {
    const offered = await catalog(context.userId);
    if (offered.error) return offered;
    return {
      value: (await plugins.list(context)).map(({id, source, tags}) => {
        const found = offered.value.get(id);
        return found && found.source === source
          ? {...found.entry, source, tags}
          : {id, name: id, status: 'unavailable', source, tags};
      }),
    };
  }

  return Object.freeze({
    catalog,
    list,

    /**
     * Install every ready app of the workspace on the NanoAgent `on`, all at
     * once, so opening or running one finds it installed: `{value}`, each
     * app's `{id}` or `{id, error}`, or `{error, status}`.
     */
    async prepare(context, on = ai) {
      const listed = await list(context);
      if (listed.error) return listed;
      return {
        value: await Promise.all(listed.value.filter(app => app.status === 'ready').map(async app => {
          const result = await installed(on, context.userId, app.source, app);
          return result.error ? {id: app.id, error: result.error} : {id: app.id};
        })),
      };
    },

    /** Add the marketplace plugin `id`: `{value}`, the added app, or `{error, status}`. */
    async add(context, id) {
      const offered = await catalog(context.userId);
      if (offered.error) return offered;
      const found = offered.value.get(id);
      if (!found) return {error: `No plugin named ${id} in the marketplace`, status: 404};
      const {tags} = await plugins.add(context, id, found.source);
      return {value: {...found.entry, source: found.source, tags}};
    },

    /** Replace the tags the workspace files its plugin `id` under: whether it has one. */
    tag: (context, id, tags) => plugins.tag(context, id, tags),

    /** Remove the workspace's plugin `id`: whether it had one. */
    remove: (context, id) => plugins.remove(context, id),

    /**
     * The workspace's app `id`, installed and ready to run on the NanoAgent `on`
     * (Mochi's, which serves its page, unless a run goes to the member's own
     * computer): its catalog entry, with the `sha256` its runs and page are
     * addressed by and its `uiVersion`; or `{error, status}`, 404 for a plugin
     * the workspace did not add.
     */
    async open(context, id, on = ai) {
      const added = await plugins.get(context, id);
      if (!added) return {error: `This workspace has no plugin named ${id}`, status: 404};
      // An upload's version comes with the workspace's row; NanoAgent's from its own list.
      let entry = {id, sha256: added.sha256};
      if (added.source === 'nanoagent') {
        const builtIn = await ai.packages();
        if (builtIn.error) return builtIn;
        entry = builtIn.value.packages.find(found => found.id === id);
        if (!entry) return {error: `${id} is no longer in the marketplace`, status: 404};
      }
      const result = await installed(on, context.userId, added.source, entry);
      return result.error ? result : {value: {...result.value, source: added.source}};
    },
  });
}

module.exports = {createWorkspaceApps};
