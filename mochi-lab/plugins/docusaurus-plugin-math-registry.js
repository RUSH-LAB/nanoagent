/**
 * Docusaurus plugin that scans content directories for <Type id="..."> blocks,
 * assigns hierarchical per-type numbers (e.g., "2.2.1"), and exposes the
 * manifest via setGlobalData().
 *
 * Numbering scheme:
 *   - Top-level items (files and folders) get chapter numbers (1, 2, ...)
 *   - Files inside folders get section numbers (2.1, 2.2, ...)
 *   - Math blocks get counters at two granularities:
 *       - Per-chapter (chapter.N): Theorem-like environments (Theorem, Lemma,
 *         Proposition, Corollary, Definition, Remark, Example) share one counter,
 *         Figure, Table, Code, Algorithm each have their own counter
 *       - Per-file (chapter.section.N): Equation only — dense, needs section precision
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
 * Build a flat list of files with their hierarchical prefix and chapter number.
 * Returns: [{ filePath, prefix: "2.1", chapter: 2, page }]
 */
function buildHierarchy(contentDir, routeBase) {
  const topItems = []; // { name, type: 'file'|'dir', position, path }

  for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (entry.name === 'assets') continue;

    const fullPath = path.join(contentDir, entry.name);
    if (entry.isDirectory()) {
      topItems.push({
        name: entry.name,
        type: 'dir',
        position: getFolderPosition(fullPath),
        path: fullPath,
      });
    } else if (/\.(mdx?|md)$/.test(entry.name)) {
      topItems.push({
        name: entry.name,
        type: 'file',
        position: getFilePosition(fullPath),
        path: fullPath,
      });
    }
  }

  // Sort top-level items by position
  topItems.sort((a, b) => a.position - b.position);

  const result = [];
  let chapterNum = 0;

  for (const item of topItems) {
    chapterNum++;

    if (item.type === 'file') {
      const relPath = path.relative(contentDir, item.path);
      const page = toRoutePath(relPath, routeBase);
      result.push({ filePath: item.path, prefix: `${chapterNum}`, chapter: chapterNum, page });
    } else {
      // Scan files inside the directory
      const subFiles = [];
      for (const sub of fs.readdirSync(item.path, { withFileTypes: true })) {
        if (!sub.isFile() || !/\.(mdx?|md)$/.test(sub.name)) continue;
        const subPath = path.join(item.path, sub.name);
        subFiles.push({
          name: sub.name,
          position: getFilePosition(subPath),
          path: subPath,
        });
      }
      subFiles.sort((a, b) => a.position - b.position);

      let sectionNum = 0;
      for (const sub of subFiles) {
        sectionNum++;
        const relPath = path.relative(contentDir, sub.path);
        const page = toRoutePath(relPath, routeBase);
        result.push({ filePath: sub.path, prefix: `${chapterNum}.${sectionNum}`, chapter: chapterNum, page });
      }
    }
  }

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
