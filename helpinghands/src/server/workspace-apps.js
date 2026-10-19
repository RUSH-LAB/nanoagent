'use strict';

const {checkUpload, checkedUploads} = require('./market-checks');

/**
 * A member's apps: the marketplace plugins they installed (postgres/user-plugins.js),
 * which they run in any workspace they are in, each from an install of the
 * plugin's package on the NanoAgent of their own computer. `ai`, Mochi's own NanoAgent, only offers packages.
 *
 * The marketplace offers NanoAgent's own packages and the uploads
 * (postgres/market.js), one id each: an upload may not take one of NanoAgent's.
 * A member's upload follows its latest version, or stays on the version they
 * chose until they update it; NanoAgent's own run as NanoAgent offers them.
 * NanoAgent installs a package by its sha256 and keeps it until
 * it restarts; opening an app sends the package when NanoAgent has no install
 * of it, which takes as long as building the plugin's environment, once.
 * An upload Mochi's NanoAgent refuses (market-checks.js) is `refused`: listed, never installed,
 * and opened as its page alone (NanoAgent's view of the package), so the member reads the
 * sessions they had with it and starts none until they run a version NanoAgent accepts.
 */
function createWorkspaceApps({ai, market, plugins}) {
  /** Every plugin a member may install, by id: `{value: Map<id, {source, entry}>}` or `{error, status}`. */
  async function catalog(userId) {
    const builtIn = await ai.packages();
    if (builtIn.error) return builtIn;
    const uploads = await checkedUploads({ai, market}, userId);
    if (uploads.error) return uploads;
    const offered = new Map(builtIn.value.packages.map(entry => [entry.id, {source: 'nanoagent', entry}]));
    for (const entry of uploads.value) offered.set(entry.id, {source: 'upload', entry});
    return {value: offered};
  }

  /** The install of `entry`'s package on the NanoAgent `on`, sending it first when it has none. */
  async function installed(on, userId, source, entry) {
    const found = await on.install(entry.sha256);
    if (found.status !== 404) return found.error ? found : {value: found.value.plugin};
    const data = source === 'upload'
      ? {value: (await market.get(userId, entry.id, entry.version))?.package}
      : await ai.packageFile(entry.id);
    if (data.error) return data;
    if (!data.value) return {error: `${entry.id} is no longer in the marketplace`, status: 404};
    const put = await on.installPackage(entry.sha256, data.value);
    return put.error ? put : {value: put.value.plugin};
  }

  /** The view of the upload `entry`'s package on the NanoAgent `on`: its page alone, `{value: {uiVersion}}`. */
  async function viewed(on, userId, entry) {
    const data = (await market.get(userId, entry.id, entry.version))?.package;
    if (!data) return {error: `${entry.id} ${entry.version} is no longer in the marketplace`, status: 404};
    const put = await on.viewPackage(entry.sha256, data);
    return put.error ? put : {value: put.value.view};
  }

  /**
   * Of the caller's upload `added`: the `latest` version published, whether they follow it, and
   * the `repository` the version they run was published from, and the latest (`latestRepository`).
   */
  const versionOf = added => ({
    latest: added.latest, autoUpdate: added.pinned === null, repository: added.repository, latestRepository: added.latestRepository,
  });

  /**
   * `added`, one of the caller's plugins, as they run it: its marketplace entry
   * `found`, and for an upload the version they run, the `latest` published,
   * and whether they follow it (`autoUpdate`).
   */
  function app(added, found) {
    const {id, source, tags} = added;
    if (!found || found.source !== source) return {id, name: id, status: 'unavailable', source, tags};
    if (source !== 'upload') return {...found.entry, source, tags};
    return {...found.entry, ...added.entry, sha256: added.sha256, source, tags, ...versionOf(added)};
  }

  /** `app`, for an upload checked at the version the caller runs (market-checks.js): `{value}` or `{error, status}`. */
  const checked = (userId, app) => (app.source === 'upload' && app.status !== 'unavailable'
    ? checkUpload({ai, market}, userId, app)
    : {value: app});

  /**
   * The caller's apps, each as `app` has it and `checked`; one that left the marketplace is
   * listed as `unavailable`, for them to remove.
   */
  async function list(context) {
    const offered = await catalog(context.userId);
    if (offered.error) return offered;
    const apps = await Promise.all((await plugins.list(context)).map(added => checked(context.userId, app(added, offered.value.get(added.id)))));
    return apps.find(result => result.error) ?? {value: apps.map(result => result.value)};
  }

  return Object.freeze({
    catalog,
    list,

    /**
     * Install every ready app of the caller's on the NanoAgent `on`, all at
     * once, so opening or running one finds it installed: `{value}`, each
     * app's `{id}` or `{id, error}`, or `{error, status}`.
     */
    async prepare(context, on) {
      const listed = await list(context);
      if (listed.error) return listed;
      return {
        value: await Promise.all(listed.value.filter(app => app.status === 'ready').map(async app => {
          const result = await installed(on, context.userId, app.source, app);
          return result.error ? {id: app.id, error: result.error} : {id: app.id};
        })),
      };
    },

    /** Install the marketplace plugin `id` for the caller: `{value}`, the installed app, or `{error, status}`. */
    async add(context, id) {
      const offered = await catalog(context.userId);
      if (offered.error) return offered;
      const found = offered.value.get(id);
      if (!found) return {error: `No plugin named ${id} in the marketplace`, status: 404};
      if (found.entry.status === 'refused') return {error: `${id} is under maintenance: ${found.entry.refusal}`, status: 409};
      return checked(context.userId, app(await plugins.add(context, id, found.source), found));
    },

    /**
     * Keep the caller's upload `id` on `version`, or with null have it follow
     * the latest: `{value}`, the app, or `{error, status}`.
     */
    async pin(context, id, version) {
      try {
        if (!await plugins.pin(context, id, version)) return {error: `You have not installed an upload named ${id}`, status: 404};
      } catch (error) {
        if (error.code === '23503') return {error: `${id} has no version ${version}`, status: 404};
        throw error;
      }
      const offered = await catalog(context.userId);
      if (offered.error) return offered;
      return checked(context.userId, app(await plugins.get(context, id), offered.value.get(id)));
    },

    /**
     * Why the caller's plugin `id` may not run as they have it: `{value}`, NanoAgent's refusal
     * of the upload's version they run (market-checks.js), or null for one that runs; or `{error, status}`.
     */
    async refusal(context, id) {
      const added = await plugins.get(context, id);
      if (!added) return {error: `You have not installed a plugin named ${id}`, status: 404};
      if (added.source !== 'upload') return {value: null};
      const checked = await checkUpload({ai, market}, context.userId, {id, version: added.version, sha256: added.sha256});
      return checked.error ? checked : {value: checked.value.status === 'refused' ? checked.value.refusal : null};
    },

    /** Replace the tags the caller files their plugin `id` under: whether they have one. */
    tag: (context, id, tags) => plugins.tag(context, id, tags),

    /** Uninstall the caller's plugin `id`: whether they had one. */
    remove: (context, id) => plugins.remove(context, id),

    /**
     * The caller's app `id`, installed and ready to run on the NanoAgent `on`
     * (the member's own computer's): its catalog entry, with the `sha256` its runs and page are
     * addressed by and its `uiVersion`, and for an upload `versionOf` it; or
     * `{error, status}`, 404 for a plugin the caller did not install. An upload whose version
     * NanoAgent refuses is its page alone, `refused` with its `refusal`, and never installed.
     */
    async open(context, id, on) {
      const added = await plugins.get(context, id);
      if (!added) return {error: `You have not installed a plugin named ${id}`, status: 404};
      // An upload's version comes with the caller's row; NanoAgent's from its own list.
      let entry = {id, version: added.version, sha256: added.sha256};
      if (added.source === 'nanoagent') {
        const builtIn = await ai.packages();
        if (builtIn.error) return builtIn;
        entry = builtIn.value.packages.find(found => found.id === id);
        if (!entry) return {error: `${id} is no longer in the marketplace`, status: 404};
      }
      if (added.source === 'upload') {
        const checked = await checkUpload({ai, market}, context.userId, entry);
        if (checked.error) return checked;
        if (checked.value.status === 'refused') {
          const view = await viewed(on, context.userId, entry);
          if (view.error) return view;
          return {value: {
            ...added.entry, sha256: added.sha256, uiVersion: view.value.uiVersion, status: 'refused', refusal: checked.value.refusal,
            source: added.source, ...versionOf(added),
          }};
        }
      }
      const result = await installed(on, context.userId, added.source, entry);
      if (result.error) return result;
      return {value: {...result.value, source: added.source, ...(added.source === 'upload' ? versionOf(added) : {})}};
    },
  });
}

/** Why the plugin `id`, at a version NanoAgent refuses (`refusal`), takes no new session or message. */
const outdated = (id, refusal) => `${id} is outdated: this version no longer runs here, so its sessions can be read but not continued (${refusal})`;

module.exports = {createWorkspaceApps, outdated};
