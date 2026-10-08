/**
 * Docusaurus plugin that scans content directories for <Type id="..."> blocks,
 * assigns hierarchical per-type numbers (e.g., "2.2.1"), and exposes the
 * manifest via setGlobalData().
 *
 * Numbering scheme:
 *   - The directory tree is walked recursively to arbitrary depth.
 *   - Each folder/file at depth N gets a positional number appended to its
 *     parent's prefix (e.g., top-level "2", child "2.1", grandchild "2.1.3").
 *   - index.md in a folder gets the folder's own prefix (not a sub-section
 *     number) and is scanned for math blocks.
 *   - Math blocks get counters at two granularities:
 *       - Per-chapter (chapter.N): Theorem-like environments (Theorem, Lemma,
 *         Proposition, Corollary, Definition, Remark, Example) share one counter,
 *         Figure, Table, Code, Algorithm each have their own counter
 *       - Per-file (prefix.N): Equation only — dense, needs section precision
 *
 * Chapter/section order is determined by:
 *   1. _category_.json "position" for folders
 *   2. frontmatter "sidebar_position" for files
 *   3. Numeric prefix in filename as fallback
 *
 * Consumers: <Ref id="thm-foo" /> in Math.js reads usePluginData('math-registry').
 *
 * A build-only plugin: no pages, no endpoints, no markdown syntax. Which
 * directories it scans is the `options` block of its plugin.json, handed to
 * this factory by plugins/loader.js.
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const KNOWN_TYPES = [
  'Theorem', 'Lemma', 'Proposition', 'Corollary',
  'Definition', 'Remark', 'Example',
  'Equation', 'Figure', 'Table', 'Code', 'Algorithm',
];

// Per-chapter types: shared counter for theorem-like, separate counters for Figure/Table/Code/Algorithm.
// Per-file type: only Equation (dense content needs section-level precision), so it is the sole
// exclusion. Derived from KNOWN_TYPES so the two lists cannot drift apart.
const PER_CHAPTER_TYPES = new Set(KNOWN_TYPES.filter(type => type !== 'Equation'));

const THEOREM_LIKE = new Set([
  'Theorem', 'Lemma', 'Proposition', 'Corollary',
  'Definition', 'Remark', 'Example',
]);

function chapterCounterKey(type) {
  return THEOREM_LIKE.has(type) ? '_theoremLike' : type;
}

// Matches <Theorem id="thm-foo">, <Equation id="eq-bar">, etc.
const TAG_RE = new RegExp(
  `<(${KNOWN_TYPES.join('|')})\\s[^>]*?id=["']([^"']+)["'][^>]*>`,
  'g',
);

/**
 * Compute Docusaurus route path from a relative file path.
 */
function toRoutePath(relPath, routeBase) {
  let route = relPath
    .replace(/\.mdx?$/, '')
    .split(path.sep)
    .map(seg => seg.replace(/^\d+-/, ''))
    .join('/');
  if (route.endsWith('/index') || route === 'index') {
    route = route.replace(/\/?index$/, '');
  }
  return `/${routeBase}${route ? '/' + route : ''}`;
}

/**
 * Get the sort position for a file from its frontmatter sidebar_position
 * or numeric prefix in the filename.
 *
 * Returns { position, raw } where `raw` is the file text read once here, so the
 * tag-scan phase in loadContent can reuse it instead of reading the same file a
 * second time. `raw` is null when the read failed; loadContent then reads as before.
 */
function getFilePosition(filePath) {
  let raw = null;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    const { data } = matter(raw);
    if (data.sidebar_position != null) return { position: data.sidebar_position, raw };
  } catch { /* ignore */ }
  const basename = path.basename(filePath);
  const match = basename.match(/^(\d+)/);
  return { position: match ? parseInt(match[1], 10) : 999, raw };
}

/**
 * Get the sort position for a folder from its _category_.json "position" field
 * or numeric prefix in the folder name.
 */
function getFolderPosition(folderPath) {
  const catFile = path.join(folderPath, '_category_.json');
  if (fs.existsSync(catFile)) {
    try {
      const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
      if (cat.position != null) return cat.position;
    } catch { /* ignore */ }
  }
  const basename = path.basename(folderPath);
  const match = basename.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 999;
}

/**
 * Read a directory and return sorted items (files and subdirectories).
 * index.md/index.mdx is excluded — it's returned separately as the folder's own page.
 * Skips hidden files, _-prefixed entries, and 'assets' directories.
 */
function readSortedItems(dir) {
  const items = []; // { name, type: 'file'|'dir', position, path }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (entry.name === 'assets') continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        type: 'dir',
        position: getFolderPosition(fullPath),
        path: fullPath,
      });
    } else if (/\.mdx?$/.test(entry.name)) {
      // Skip index files — they represent the folder itself, not a numbered child
      if (/^index\.mdx?$/.test(entry.name)) continue;
      // getFilePosition reads the file once; carry its raw text so loadContent's
      // tag scan can reuse it instead of reading the same file again.
      const { position, raw } = getFilePosition(fullPath);
      items.push({
        name: entry.name,
        type: 'file',
        position,
        path: fullPath,
        raw,
      });
    }
  }

  items.sort((a, b) => a.position - b.position);
  return items;
}

/**
 * Find index.md/index.mdx in a directory, or null if none exists.
 */
function findIndexFile(dir) {
  for (const ext of ['md', 'mdx']) {
    const p = path.join(dir, `index.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Build a flat list of files with their hierarchical prefix and chapter number.
 * Recurses to arbitrary depth. index.md/index.mdx in a folder gets the folder's own prefix.
 * Returns: [{ filePath, prefix: "2.1", chapter: 1, page, raw }]
 *
 * "chapter" is always the top-level number (depth-1), used for per-chapter counters.
 * "raw" is the text getFilePosition already read for non-index files (null if that
 * read failed, absent for folder index files, which loadContent reads itself).
 */
function buildHierarchy(contentDir, routeBase) {
  const result = [];

  function walk(dir, parentPrefix, chapter) {
    const items = readSortedItems(dir);
    let counter = 0;

    for (const item of items) {
      counter++;
      const prefix = parentPrefix ? `${parentPrefix}.${counter}` : `${counter}`;
      // Chapter is the top-level number; once set at depth 1, it carries through
      const chap = chapter ?? counter;

      if (item.type === 'file') {
        const relPath = path.relative(contentDir, item.path);
        const page = toRoutePath(relPath, routeBase);
        // Carry the raw text already read by getFilePosition (null only if that read
        // failed); the folder index files below carry no raw and are read in loadContent.
        result.push({ filePath: item.path, prefix, chapter: chap, page, raw: item.raw });
      } else {
        // Folder: first register its index.md (if any) with the folder's prefix
        const indexFile = findIndexFile(item.path);
        if (indexFile) {
          const relPath = path.relative(contentDir, indexFile);
          const page = toRoutePath(relPath, routeBase);
          result.push({ filePath: indexFile, prefix, chapter: chap, page });
        }
        // Then recurse into children
        walk(item.path, prefix, chap);
      }
    }
  }

  walk(contentDir, '', null);
  return result;
}

function scanDirectories(contentDirs, projectRoot) {
  const manifest = {};
  const seenIds = new Set();
  let totalBlocks = 0;
  let totalFiles = 0;

  for (const {dir: dirSpec, routeBase} of contentDirs) {
    const absDir = path.isAbsolute(dirSpec) ? dirSpec : path.resolve(projectRoot, dirSpec);
    if (!fs.existsSync(absDir)) {
      console.warn(`[math-registry] Directory not found: ${absDir}`);
      continue;
    }

    const hierarchy = buildHierarchy(absDir, routeBase);
    totalFiles += hierarchy.length;
    const chapterCounters = {};

    for (const {filePath, prefix, chapter, page, raw: carriedRaw} of hierarchy) {
      const raw = typeof carriedRaw === 'string' ? carriedRaw : fs.readFileSync(filePath, 'utf8');
      const fileCounters = {};
      if (!chapterCounters[chapter]) chapterCounters[chapter] = {};

      let match;
      TAG_RE.lastIndex = 0;
      while ((match = TAG_RE.exec(raw)) !== null) {
        const type = match[1];
        const id = match[2];
        if (seenIds.has(id)) console.warn(`[math-registry] Duplicate ID "${id}" in ${filePath}`);
        seenIds.add(id);

        let displayNumber;
        if (PER_CHAPTER_TYPES.has(type)) {
          const key = chapterCounterKey(type);
          chapterCounters[chapter][key] = (chapterCounters[chapter][key] || 0) + 1;
          displayNumber = `${chapter}.${chapterCounters[chapter][key]}`;
        } else {
          fileCounters[type] = (fileCounters[type] || 0) + 1;
          displayNumber = `${prefix}.${fileCounters[type]}`;
        }
        manifest[id] = {type, number: displayNumber, page};
        totalBlocks++;
      }
    }
  }
  return {manifest, totalBlocks, totalFiles};
}

module.exports = function mathRegistryPlugin(context = {}, opts = {}) {
  const projectRoot = context.siteDir || path.resolve(__dirname, '..', '..');
  const explicitContentDirs = Array.isArray(opts.contentDirs) ? opts.contentDirs : null;

  return {
    name: 'math-registry',

    async loadContent() {
      if (explicitContentDirs) {
        const result = scanDirectories(explicitContentDirs, projectRoot);
        if (result.totalBlocks) console.log(`[math-registry] Registered ${result.totalBlocks} math blocks across ${result.totalFiles} files`);
        return result.manifest;
      }

      // Runtime documents are database rows and cannot be enumerated safely at
      // build time. Explicit directories remain available for fixture/tooling
      // use, but the application build deliberately has no workspace scan.
      return {primary: {}, scopes: []};
    },

    async contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },
  };
};
