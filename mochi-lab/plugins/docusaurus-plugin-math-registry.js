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
// Per-file type: only Equation (dense content needs section-level precision).
const PER_CHAPTER_TYPES = new Set([
  'Theorem', 'Lemma', 'Proposition', 'Corollary',
  'Definition', 'Remark', 'Example',
  'Figure', 'Table', 'Code', 'Algorithm',
]);

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
    .replace(/\.(mdx?|md)$/, '')
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
 */
function getFilePosition(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { data } = matter(raw);
    if (data.sidebar_position != null) return data.sidebar_position;
  } catch { /* ignore */ }
  const basename = path.basename(filePath);
  const match = basename.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 999;
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
 * index.md is excluded — it's returned separately as the folder's own page.
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
    } else if (/\.(mdx?|md)$/.test(entry.name)) {
      // Skip index files — they represent the folder itself, not a numbered child
      if (/^index\.(mdx?|md)$/.test(entry.name)) continue;
      items.push({
        name: entry.name,
        type: 'file',
        position: getFilePosition(fullPath),
        path: fullPath,
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
 * Recurses to arbitrary depth. index.md in a folder gets the folder's own prefix.
 * Returns: [{ filePath, prefix: "2.1", chapter: 1, page }]
 *
 * "chapter" is always the top-level number (depth-1), used for per-chapter counters.
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
        result.push({ filePath: item.path, prefix, chapter: chap, page });
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

module.exports = function mathRegistryPlugin(_context, opts = {}) {
  const projectRoot = path.resolve(__dirname, '..');
  const contentDirs = opts.contentDirs || [
    { dir: opts.mathDir || path.resolve(projectRoot, 'math'), routeBase: opts.routeBase || 'math' },
  ];

  return {
    name: 'math-registry',

    async loadContent() {
      const manifest = {};
      const seenIds = new Set();
      let totalBlocks = 0;
      let totalFiles = 0;

      for (const { dir: dirSpec, routeBase } of contentDirs) {
        const absDir = path.isAbsolute(dirSpec) ? dirSpec : path.resolve(projectRoot, dirSpec);

        if (!fs.existsSync(absDir)) {
          console.warn(`[math-registry] Directory not found: ${absDir}`);
          continue;
        }

        const hierarchy = buildHierarchy(absDir, routeBase);
        totalFiles += hierarchy.length;

        // Per-chapter counters for theorem-like (shared), Figure, Table, Code, Algorithm (each own).
        // These span all files within a chapter → "chapter.N" numbering.
        const chapterCounters = {}; // { chapterNum: { _theoremLike: N, Figure: N, ... } }

        for (const { filePath, prefix, chapter, page } of hierarchy) {
          const raw = fs.readFileSync(filePath, 'utf8');

          // Per-file counter for Equation only → "prefix.N" (dense, needs section precision)
          const fileCounters = {};

          // Ensure chapter-level counters exist
          if (!chapterCounters[chapter]) chapterCounters[chapter] = {};

          let match;
          TAG_RE.lastIndex = 0;
          while ((match = TAG_RE.exec(raw)) !== null) {
            const type = match[1];
            const id = match[2];

            if (seenIds.has(id)) {
              console.warn(`[math-registry] Duplicate ID "${id}" in ${filePath}`);
            }
            seenIds.add(id);

            let displayNumber;
            if (PER_CHAPTER_TYPES.has(type)) {
              // Per-chapter: theorem-like shares '_theoremLike', others use own key
              const key = chapterCounterKey(type);
              chapterCounters[chapter][key] = (chapterCounters[chapter][key] || 0) + 1;
              displayNumber = `${chapter}.${chapterCounters[chapter][key]}`;
            } else {
              // Equation: per-file counter → chapter.section.N
              fileCounters[type] = (fileCounters[type] || 0) + 1;
              displayNumber = `${prefix}.${fileCounters[type]}`;
            }

            manifest[id] = { type, number: displayNumber, page };
            totalBlocks++;
          }
        }
      }

      if (totalBlocks > 0) {
        console.log(`[math-registry] Registered ${totalBlocks} math blocks across ${totalFiles} files`);
      }

      return manifest;
    },

    async contentLoaded({ content, actions }) {
      actions.setGlobalData(content);
    },
  };
};
