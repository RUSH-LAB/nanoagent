/**
 * The plugin system: what a tool in this codebase is, and how the site finds it.
 *
 * A plugin is a directory under plugins/. It is never listed anywhere; the site
 * discovers it by looking, so adding a tool is adding a directory. What the
 * directory contains decides what the plugin contributes, one conventional
 * filename per contribution:
 *
 *   plugin.json   Who it is: title, description, whether it is enabled, the
 *                 `options` handed to index.js, and — for a plugin with a
 *                 server half — the `apiVersion` it was written against and the
 *                 `requires` capabilities it is granted. The only required file.
 *   index.js      The build half: a Docusaurus plugin factory. Pages, global
 *                 data, build artifacts, the command that opens the tool.
 *   server.js     The API half: (req, res, url, pathname, ctx), plus an optional
 *                 `provides` merged onto ctx. Loaded by src/server/plugins.js,
 *                 which shares this file's discovery rules.
 *   remark.js     Markdown syntax: a remark plugin factory, added to the chain
 *                 every content page is parsed with.
 *
 * Every slot is optional, and a plugin that fills none of them is inert but
 * legal. Anything else in the directory (components/, lib/, proofs/) belongs to
 * the plugin alone and is nobody else's business.
 *
 * Two rules keep discovery honest. A directory whose name starts with `_` is
 * skipped, which is what makes plugins/_template a template rather than a
 * plugin. And a plugin that throws while loading is reported and skipped rather
 * than taking the build down with it: one broken tool should not cost the whole
 * site, and the console line says which one to look at.
 *
 * Order is alphabetical by directory name, and therefore stable. It matters in
 * both directions: the server dispatcher runs route modules in order and the
 * first to answer wins, and the remark chain transforms each page in order.
 */
const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = __dirname;

/** The conventional filenames, so no caller spells them itself. */
const SLOTS = {build: 'index.js', server: 'server.js', remark: 'remark.js'};

/** A directory that is deliberately not a plugin: plugins/_template. */
const isReserved = name => name.startsWith('_') || name.startsWith('.');

/**
 * A plugin's manifest, or null if the directory has none.
 *
 * The name is the directory name rather than a field, so the two can never
 * disagree; a `name` in the file is ignored. Unreadable or malformed JSON is a
 * mistake worth hearing about, and disables that plugin alone.
 */
function readManifest(dir, name) {
  const file = path.join(dir, 'plugin.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      title: parsed.title ?? name,
      description: parsed.description ?? '',
      enabled: parsed.enabled !== false,
      options: parsed.options ?? {},
      // Which version of the server's plugin API the server half was written
      // against, and which capabilities it asks for. Both matter only to
      // server.js; a plugin that is pages and markdown declares neither.
      apiVersion: parsed.apiVersion ?? null,
      requires: Array.isArray(parsed.requires) ? parsed.requires : [],
    };
  } catch (err) {
    console.error(`[plugins] ${name}/plugin.json is not valid JSON: ${err.message}; skipped`);
    return null;
  }
}

/**
 * Every enabled plugin, as {name, dir, manifest, slots}, in alphabetical order.
 *
 * `slots` holds the absolute path of each conventional file the plugin actually
 * has, so a caller asks whether a plugin fills its slot rather than probing the
 * filesystem again. This is the single discovery pass: the build half below and
 * the server half in src/server/plugins.js both start here.
 */
function listPlugins(dir = PLUGINS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || isReserved(entry.name)) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifest = readManifest(pluginDir, entry.name);
    if (!manifest) continue;
    if (!manifest.enabled) continue;

    const slots = {};
    for (const [slot, filename] of Object.entries(SLOTS)) {
      const file = path.join(pluginDir, filename);
      if (fs.existsSync(file)) slots[slot] = file;
    }
    found.push({name: entry.name, dir: pluginDir, manifest, slots});
  }
  return found;
}

/**
 * Require a plugin's slot, reporting and skipping a module that fails to load
 * or does not export the function the slot is defined to hold.
 */
function requireSlot(plugin, slot) {
  const file = plugin.slots[slot];
  if (!file) return null;
  try {
    const loaded = require(file);
    if (typeof loaded !== 'function') {
      console.error(`[plugins] ${plugin.name}/${SLOTS[slot]} does not export a function; skipped`);
      return null;
    }
    return loaded;
  } catch (err) {
    console.error(`[plugins] ${plugin.name}/${SLOTS[slot]} failed to load: ${err.message}`);
    return null;
  }
}

/**
 * The build halves, in the shape docusaurus.config.js spreads into `plugins`.
 *
 * Each entry is [factory, options], the options being the manifest's `options`
 * block, which is where a plugin's configuration lives now that no plugin is
 * named in the site config.
 */
function loadBuildPlugins(dir = PLUGINS_DIR) {
  const loaded = [];
  for (const plugin of listPlugins(dir)) {
    const factory = requireSlot(plugin, 'build');
    if (factory) loaded.push([factory, plugin.manifest.options]);
  }
  return loaded;
}

/**
 * The markdown syntax the plugins contribute, in the shape docusaurus.config.js
 * spreads into `remarkPlugins`.
 *
 * These run after remark-math, which the site puts ahead of them, so math is
 * already parsed out of the tree before any plugin walks its text nodes.
 */
function loadRemarkPlugins(dir = PLUGINS_DIR) {
  const loaded = [];
  for (const plugin of listPlugins(dir)) {
    const factory = requireSlot(plugin, 'remark');
    if (factory) loaded.push(factory);
  }
  return loaded;
}

module.exports = {PLUGINS_DIR, SLOTS, listPlugins, requireSlot, loadBuildPlugins, loadRemarkPlugins};
