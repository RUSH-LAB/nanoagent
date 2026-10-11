'use strict';

const MAX_NAVIGATION_ITEMS = 24;
const MAX_COLLECTIONS = 32;
const MAX_BLOG_GROUPS = 100;
const MAX_AUTHORS = 100;
const MAX_PLUGINS = 64;
const HOME_LAYOUTS = new Set(['title', 'library', 'document']);
const LEGACY_PLUGIN_FLAGS = Object.freeze({
  bibliography: 'citations',
  'lean-proofs': 'leanProofs',
  'math-registry': 'interactiveMath',
  'wiki-links': 'wikiLinks',
});

function text(value, name, {required = false, max = 120} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) throw new TypeError(`${name} must be 1 to ${max} characters`);
  return cleaned;
}

function contentPath(value, name) {
  const path = text(value, name, {required: true, max: 400});
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new TypeError(`${name} must be a workspace-relative path`);
  }
  return path.replace(/^\.\//, '');
}

function httpUrl(value, name) {
  const candidate = text(value, name, {max: 1000});
  if (!candidate) return null;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new TypeError(`${name} must be an HTTP URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError(`${name} must be an HTTP URL`);
  return candidate;
}

function validateNavigation(value) {
  if (!Array.isArray(value)) throw new TypeError('navigation must be an array');
  if (value.length > MAX_NAVIGATION_ITEMS) throw new TypeError(`navigation may contain at most ${MAX_NAVIGATION_ITEMS} items`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`navigation[${index}] must be an object`);
    const navigation = {
      label: text(item.label, `navigation[${index}].label`, {required: true, max: 50}),
      path: contentPath(item.path, `navigation[${index}].path`),
    };
    if (item.hidden === true) navigation.hidden = true;
    return navigation;
  });
}

function validateCollections(value) {
  if (!Array.isArray(value)) throw new TypeError('collections must be an array');
  if (value.length > MAX_COLLECTIONS) throw new TypeError(`collections may contain at most ${MAX_COLLECTIONS} items`);
  const keys = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`collections[${index}] must be an object`);
    const key = text(item.key, `collections[${index}].key`, {required: true, max: 60});
    if (keys.has(key)) throw new TypeError(`Duplicate collection key: ${key}`);
    keys.add(key);
    if (!['docs', 'blog'].includes(item.type)) throw new TypeError(`collections[${index}].type must be docs or blog`);
    const collection = {
      key,
      type: item.type,
      pathPrefix: contentPath(item.pathPrefix, `collections[${index}].pathPrefix`),
      title: text(item.title, `collections[${index}].title`, {required: true, max: 80}),
      description: text(item.description, `collections[${index}].description`, {max: 240}),
      sidebarTitle: text(item.sidebarTitle, `collections[${index}].sidebarTitle`, {max: 80}),
      landingPath: item.landingPath ? contentPath(item.landingPath, `collections[${index}].landingPath`) : null,
      showReadingTime: item.showReadingTime === undefined ? item.type === 'blog' : Boolean(item.showReadingTime),
    };
    if (item.type === 'blog' && item.groups != null) {
      if (!Array.isArray(item.groups)) throw new TypeError(`collections[${index}].groups must be an array`);
      if (item.groups.length > MAX_BLOG_GROUPS) {
        throw new TypeError(`collections[${index}].groups may contain at most ${MAX_BLOG_GROUPS} items`);
      }
      const groupNames = new Set();
      collection.groups = item.groups.map((group, groupIndex) => {
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
          throw new TypeError(`collections[${index}].groups[${groupIndex}] must be an object`);
        }
        const title = text(group.title, `collections[${index}].groups[${groupIndex}].title`, {required: true, max: 100});
        const identity = title.toLocaleLowerCase();
        if (groupNames.has(identity)) throw new TypeError(`Duplicate blog group: ${title}`);
        groupNames.add(identity);
        return {title};
      });
    }
    return collection;
  });
}

function validatePlugins(value, rendering = {}) {
  if (value == null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('plugins must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_PLUGINS) throw new TypeError(`plugins may contain at most ${MAX_PLUGINS} entries`);
  const plugins = Object.fromEntries(entries.map(([name, configuration]) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError(`Invalid plugin name: ${name}`);
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
      throw new TypeError(`plugins.${name} must be an object`);
    }
    return [name, {enabled: configuration.enabled !== false}];
  }));
  // Schema v1 exposed plugin switches under `rendering`. Translate those
  // values on read so deployed workspace data upgrades without a global
  // fallback or a coordinated rewrite.
  for (const [name, legacyFlag] of Object.entries(LEGACY_PLUGIN_FLAGS)) {
    if (plugins[name] === undefined && rendering[legacyFlag] !== undefined) {
      plugins[name] = {enabled: Boolean(rendering[legacyFlag])};
    }
  }
  return plugins;
}

function validateSocials(value, name) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([platform, url]) => [
    text(platform, `${name} platform`, {required: true, max: 40}),
    httpUrl(url, `${name}.${platform}`),
  ]));
}

function validateAuthors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('authors must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_AUTHORS) throw new TypeError(`authors may contain at most ${MAX_AUTHORS} entries`);
  return Object.fromEntries(entries.map(([key, author]) => {
    const authorKey = text(key, 'author key', {required: true, max: 100});
    if (!author || typeof author !== 'object' || Array.isArray(author)) throw new TypeError(`authors.${authorKey} must be an object`);
    return [authorKey, {
      name: text(author.name, `authors.${authorKey}.name`, {required: true, max: 120}),
      title: text(author.title, `authors.${authorKey}.title`, {max: 200}),
      url: httpUrl(author.url, `authors.${authorKey}.url`),
      imageUrl: httpUrl(author.imageUrl ?? author.image_url, `authors.${authorKey}.imageUrl`),
      socials: validateSocials(author.socials, `authors.${authorKey}.socials`),
    }];
  }));
}

function validateAuthoring(value) {
  if (value == null) return {quickNotesPath: null, defaultAuthor: null};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('authoring must be an object');
  return {
    quickNotesPath: value.quickNotesPath ? contentPath(value.quickNotesPath, 'authoring.quickNotesPath') : null,
    defaultAuthor: text(value.defaultAuthor, 'authoring.defaultAuthor', {max: 100}),
  };
}

function validateWorkspaceSite(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('site configuration must be an object');
  const site = value.site ?? {};
  if (!site || typeof site !== 'object' || Array.isArray(site)) throw new TypeError('site must be an object');
  const rendering = value.rendering ?? {};
  if (!rendering || typeof rendering !== 'object' || Array.isArray(rendering)) throw new TypeError('rendering must be an object');
  if (site.homeLayout != null && !HOME_LAYOUTS.has(site.homeLayout)) {
    throw new TypeError('site.homeLayout must be title, library, or document');
  }
  const validated = {
    schemaVersion: 2,
    site: {
      title: text(site.title, 'site.title', {max: 80}),
      tagline: text(site.tagline, 'site.tagline', {max: 200}),
      logoAssetId: text(site.logoAssetId, 'site.logoAssetId', {max: 100}),
      homeDocument: site.homeDocument ? contentPath(site.homeDocument, 'site.homeDocument') : null,
      homeLayout: site.homeLayout ?? null,
    },
    navigation: value.navigation == null ? [] : validateNavigation(value.navigation),
    collections: value.collections == null ? [] : validateCollections(value.collections),
    authors: value.authors == null ? {} : validateAuthors(value.authors),
    authoring: validateAuthoring(value.authoring),
    plugins: validatePlugins(value.plugins, rendering),
    rendering: {
      math: rendering.math === undefined ? true : Boolean(rendering.math),
    },
  };
  if (validated.site.homeLayout === 'document'
    && !validated.site.homeDocument
    && !validated.navigation[0]?.path) {
    throw new TypeError('site.homeDocument is required for the document home page');
  }
  return validated;
}

function quickNotesPathFor(site) {
  return site.authoring.quickNotesPath
    ?? site.collections.find(collection => collection.type === 'blog')?.pathPrefix
    ?? null;
}

function resolveWorkspaceSite(settings = {}) {
  const configured = validateWorkspaceSite(settings);
  return {
    ...configured,
    site: {
      ...configured.site,
      homeDocument: configured.site.homeDocument ?? configured.navigation[0]?.path ?? null,
    },
  };
}

module.exports = {
  MAX_NAVIGATION_ITEMS,
  MAX_COLLECTIONS,
  MAX_BLOG_GROUPS,
  MAX_AUTHORS,
  MAX_PLUGINS,
  validateWorkspaceSite,
  resolveWorkspaceSite,
  quickNotesPathFor,
  LEGACY_PLUGIN_FLAGS,
  HOME_LAYOUTS,
};
