'use strict';

const MAX_NAVIGATION_ITEMS = 24;
const MAX_COLLECTIONS = 32;
const MAX_AUTHORS = 100;
const HIDDEN_COLLECTION_PATHS = new Set(['books/builder']);

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

function titleCase(value) {
  return String(value).split(/[-_]/).filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function landingFor(prefix, documents) {
  const paths = documents.map(document => document.path).filter(path => path.startsWith(`${prefix}/`)).sort();
  return [
    `${prefix}/0-intro.md`, `${prefix}/0-intro.mdx`,
    `${prefix}/intro.md`, `${prefix}/intro.mdx`,
    `${prefix}/index.md`, `${prefix}/index.mdx`,
  ].find(path => paths.includes(path)) ?? paths[0] ?? null;
}

function inferredCollections(documents = []) {
  const found = new Map();
  for (const document of documents) {
    const [root, key] = String(document.path ?? '').split('/');
    if (!key || !['books', 'posts'].includes(root)) continue;
    // books/builder is internal authoring/reference material. It existed as a
    // routable docs plugin in the old build but was never a product section or
    // navbar destination, so automatic discovery must not publish it.
    if (root === 'books' && key === 'builder') continue;
    const id = `${root}:${key}`;
    if (!found.has(id)) {
      const pathPrefix = `${root}/${key}`;
      found.set(id, {
        key,
        type: root === 'posts' ? 'blog' : 'docs',
        pathPrefix,
        title: titleCase(key),
        landingPath: landingFor(pathPrefix, documents),
      });
    }
  }
  return [...found.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'blog' ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

function validateNavigation(value) {
  if (!Array.isArray(value)) throw new TypeError('navigation must be an array');
  if (value.length > MAX_NAVIGATION_ITEMS) throw new TypeError(`navigation may contain at most ${MAX_NAVIGATION_ITEMS} items`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`navigation[${index}] must be an object`);
    return {
      label: text(item.label, `navigation[${index}].label`, {required: true, max: 50}),
      path: contentPath(item.path, `navigation[${index}].path`),
    };
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
    return {
      key,
      type: item.type,
      pathPrefix: contentPath(item.pathPrefix, `collections[${index}].pathPrefix`),
      title: text(item.title, `collections[${index}].title`, {required: true, max: 80}),
      description: text(item.description, `collections[${index}].description`, {max: 240}),
      sidebarTitle: text(item.sidebarTitle, `collections[${index}].sidebarTitle`, {max: 80}),
      landingPath: item.landingPath ? contentPath(item.landingPath, `collections[${index}].landingPath`) : null,
      showReadingTime: item.showReadingTime === undefined ? key === 'research' : Boolean(item.showReadingTime),
    };
  });
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

function validateWorkspaceSite(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('site configuration must be an object');
  const site = value.site ?? {};
  if (!site || typeof site !== 'object' || Array.isArray(site)) throw new TypeError('site must be an object');
  const rendering = value.rendering ?? {};
  if (!rendering || typeof rendering !== 'object' || Array.isArray(rendering)) throw new TypeError('rendering must be an object');
  const flag = (name, fallback = true) => rendering[name] === undefined ? fallback : Boolean(rendering[name]);
  return {
    schemaVersion: 1,
    site: {
      title: text(site.title, 'site.title', {max: 80}),
      tagline: text(site.tagline, 'site.tagline', {max: 200}),
      logoAssetId: text(site.logoAssetId, 'site.logoAssetId', {max: 100}),
      homeDocument: site.homeDocument ? contentPath(site.homeDocument, 'site.homeDocument') : null,
    },
    navigation: value.navigation == null ? null : validateNavigation(value.navigation),
    collections: value.collections == null ? null : validateCollections(value.collections),
    authors: value.authors == null ? {} : validateAuthors(value.authors),
    rendering: {
      math: flag('math'),
      citations: flag('citations'),
      wikiLinks: flag('wikiLinks'),
      leanProofs: flag('leanProofs'),
      interactiveMath: flag('interactiveMath'),
    },
  };
}

function resolveWorkspaceSite(settings = {}, documents = []) {
  const configured = validateWorkspaceSite(settings);
  const inferred = inferredCollections(documents);
  const collections = (configured.collections ?? (configured.navigation
    ? inferred.filter(collection => configured.navigation.some(item =>
        item.path === collection.pathPrefix || item.path.startsWith(`${collection.pathPrefix}/`)))
    : inferred)).filter(collection => !HIDDEN_COLLECTION_PATHS.has(collection.pathPrefix));
  const navigation = (configured.navigation ?? collections
    .filter(collection => collection.landingPath)
    .map(collection => ({label: collection.title, path: collection.landingPath})))
    .filter(item => ![...HIDDEN_COLLECTION_PATHS].some(prefix =>
      item.path === prefix || item.path.startsWith(`${prefix}/`)));
  return {
    ...configured,
    site: {
      ...configured.site,
      homeDocument: configured.site.homeDocument ?? navigation[0]?.path ?? null,
    },
    navigation,
    collections,
  };
}

module.exports = {
  MAX_NAVIGATION_ITEMS,
  MAX_COLLECTIONS,
  MAX_AUTHORS,
  inferredCollections,
  validateWorkspaceSite,
  resolveWorkspaceSite,
};
