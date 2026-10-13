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

  /** NanoAgent's install of `entry`'s package, sending it first when NanoAgent has none. */
  async function installed(userId, source, entry) {
    const found = await ai.install(entry.sha256);
    if (found.status !== 404) return found.error ? found : {value: found.value.plugin};
    const data = source === 'upload'
      ? {value: (await market.get(userId, entry.id))?.package}
      : await ai.packageFile(entry.id);
    if (data.error) return data;
    if (!data.value) return {error: `${entry.id} is no longer in the marketplace`, status: 404};
    const put = await ai.installPackage(entry.sha256, data.value);
    return put.error ? put : {value: put.value.plugin};
  }

  return Object.freeze({
    catalog,

    /**
     * The workspace's apps, each its marketplace entry, `source` and the
     * workspace's `tags` for it; one that left the marketplace is listed as
     * `unavailable`, for an owner to remove.
     */
    async list(context) {
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
     * The workspace's app `id`, installed and ready to run: its NanoAgent catalog
     * entry, with the `sha256` its runs and page are addressed by and its
     * `uiVersion`; or `{error, status}`, 404 for a plugin the workspace did not add.
     */
    async open(context, id) {
      const added = await plugins.get(context, id);
      if (!added) return {error: `This workspace has no plugin named ${id}`, status: 404};
      const offered = await catalog(context.userId);
      if (offered.error) return offered;
      const found = offered.value.get(id);
      if (!found || found.source !== added.source) return {error: `${id} is no longer in the marketplace`, status: 404};
      const result = await installed(context.userId, found.source, found.entry);
      return result.error ? result : {value: {...result.value, source: found.source}};
    },
  });
}

module.exports = {createWorkspaceApps};
