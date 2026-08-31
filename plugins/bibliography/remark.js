/**
 * The bibliography's markdown syntax: academic citations.
 *
 * The third half of the plugin. `index.js` builds the pages and `server.js`
 * serves the API; this is the `[@key]` notation that lets a page cite an entry,
 * collected into the site's remark chain by plugins/loader.js. It lives here
 * rather than in a standalone remark plugin because it is not general markdown
 * syntax: it reads this plugin's references.yaml, and means nothing without it.
 *
 * Syntax: [@key] or [@key1; @key2] in markdown text nodes.
 * Renders inline as "(Author et al., Year)", each key linking to its own
 * #ref-key anchor and multiple keys joined by "; " in one set of parentheses.
 * Appends a "References" section listing only cited works.
 *
 * Must run AFTER remark-math so math expressions are already parsed out.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { applyTextReplacements } = require('#markdown');

// references.yaml is large (~250KB) and remarkCite() loads it once per content
// file, so a build with ~300 content files used to re-read and re-parse the
// whole file ~300 times. Cache the parsed object keyed on the file's mtimeMs
// and size: the first call reads and parses, later calls reuse the stored parse
// while the file is unchanged on disk. The dev server still picks up new entries
// without a restart because any edit changes the mtime (and size), which misses
// the cache and forces a fresh read and parse. Tracking size alongside mtime
// also catches a same-millisecond rewrite that mtime alone would miss. Mirrors
// loadReferencesCached (server/routes/references.js) and loadJSON
// (server/data-store.js).
//
// The stat is best effort: if statSync throws (a missing file, or a test that
// stubs an fs without it) the cache is skipped and the read below still runs,
// preserving the exact fallback for a missing or broken file (console.warn then
// return {}). remark-cite only reads bibliography[key] and never mutates it, so
// the shared cached object is returned directly with no defensive deep copy.
// Build-time, and the build renders the primary workspace's citations; see
// the note in ./index.js about the flat key namespace.
const PRIMARY_ORG = process.env.ROOT_ORG_SLUG || 'mochi';
const bibPath = path.resolve(__dirname, '..', '..', 'content', PRIMARY_ORG, 'bibliography', 'references.yaml');
let bibCache = null; // {mtimeMs, size, data} or null when uncached

function loadBibliography() {
  let stat = null;
  try {
    stat = fs.statSync(bibPath);
  } catch {
    stat = null;
  }
  if (
    stat &&
    bibCache &&
    bibCache.mtimeMs === stat.mtimeMs &&
    bibCache.size === stat.size
  ) {
    return bibCache.data;
  }
  try {
    const data = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
    bibCache = stat ? { mtimeMs: stat.mtimeMs, size: stat.size, data } : null;
    return data;
  } catch (err) {
    console.warn(`[remark-cite] Could not load ${bibPath}: ${err.message}`);
    bibCache = null;
    return {};
  }
}

// Regex to match [@key] or [@key1; @key2; ...]
const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;

// Placeholder shown when a bibliography entry has no year.
const MISSING_YEAR = '????';

/**
 * Format author name for inline citation: "Unknown" for empty/missing authors,
 * "Last1" for 1, "Last1 & Last2" for 2, "LastName et al." for 3+.
 */
function formatInlineAuthors(authors) {
  if (!authors || authors.length === 0) return 'Unknown';
  const lastNames = authors.map((a) => {
    const parts = a.trim().split(/\s+/);
    return parts[parts.length - 1];
  });
  if (lastNames.length === 1) return lastNames[0];
  if (lastNames.length === 2) return `${lastNames[0]} & ${lastNames[1]}`;
  return `${lastNames[0]} et al.`;
}

/**
 * Format a full reference entry for the references list.
 */
function formatReference(key, entry) {
  const authors = (entry.author || []).join(', ');
  const year = entry.year || MISSING_YEAR;
  const title = entry.title || key;
  const venue = entry.venue ? `. ${entry.venue}` : '';
  const vol = entry.volume ? `, ${entry.volume}` : '';
  const pages = entry.pages ? `, pp. ${entry.pages}` : '';
  return `${authors} (${year}). ${title}${venue}${vol}${pages}.`;
}

/**
 * Process a single text node, splitting it into text + citation link nodes.
 * Returns an array of nodes to replace the original text node, or null if no
 * citations were found.
 */
function processTextNode(node, citedKeys, file, bibliography) {
  const text = node.value;
  if (!CITE_RE.test(text)) return null;

  const result = [];
  let lastIndex = 0;
  CITE_RE.lastIndex = 0;

  let match;
  while ((match = CITE_RE.exec(text)) !== null) {
    // Add preceding text
    if (match.index > lastIndex) {
      result.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    // Parse keys from the match (e.g., "key1; @key2" -> ["key1", "key2"])
    const rawKeys = match[1].split(/\s*;\s*/).map((k) => k.replace(/^@/, ''));
    const citationParts = [];

    for (const key of rawKeys) {
      const entry = bibliography[key];
      if (!entry) {
        if (file) {
          file.message(`Unknown citation key: ${key}`, node);
        }
        citationParts.push({
          type: 'html',
          value: `<span class="citation-unknown">[?${key}]</span>`,
        });
        continue;
      }

      citedKeys.add(key);
      const label = `${formatInlineAuthors(entry.author)}, ${entry.year || MISSING_YEAR}`;
      citationParts.push({
        type: 'link',
        url: `#ref-${key}`,
        data: {
          hProperties: { className: ['citation-link'] },
        },
        children: [{ type: 'text', value: label }],
      });
    }

    // Wrap multiple citations in parentheses with semicolons
    result.push({ type: 'text', value: '(' });
    for (let i = 0; i < citationParts.length; i++) {
      result.push(citationParts[i]);
      if (i < citationParts.length - 1) {
        result.push({ type: 'text', value: '; ' });
      }
    }
    result.push({ type: 'text', value: ')' });

    lastIndex = match.index + match[0].length;
  }

  // Add trailing text
  if (lastIndex < text.length) {
    result.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return result;
}

/**
 * Build the "References" section as mdast nodes.
 */
function buildReferencesSection(citedKeys, bibliography) {
  if (citedKeys.size === 0) return [];

  // Sort by author last name, then year
  const sorted = [...citedKeys].sort((a, b) => {
    const ea = bibliography[a] || {};
    const eb = bibliography[b] || {};
    const authorA = ((ea.author || [])[0] || '').split(/\s+/).pop() || '';
    const authorB = ((eb.author || [])[0] || '').split(/\s+/).pop() || '';
    const cmp = authorA.localeCompare(authorB);
    if (cmp !== 0) return cmp;
    return (ea.year || 0) - (eb.year || 0);
  });

  const items = sorted.map((key) => {
    const entry = bibliography[key];
    const refText = formatReference(key, entry);
    const children = [];

    // Reference text (with optional link)
    if (entry.url) {
      children.push({
        type: 'link',
        url: entry.url,
        children: [{ type: 'text', value: refText }],
      });
    } else {
      children.push({ type: 'text', value: refText });
    }

    children.push({ type: 'text', value: ' ' });
    children.push({
      type: 'link',
      url: `/bibliography/${key}`,
      data: { hProperties: { className: ['bib-detail-link'] } },
      children: [{ type: 'text', value: '↗' }],
    });

    return {
      type: 'listItem',
      data: {
        hProperties: { id: `ref-${key}`, className: ['reference-item'] },
      },
      children: [{ type: 'paragraph', children }],
    };
  });

  return [
    {
      type: 'thematicBreak',
    },
    {
      type: 'heading',
      depth: 2,
      children: [{ type: 'text', value: 'References' }],
    },
    {
      type: 'list',
      ordered: false,
      data: {
        hProperties: { className: ['reference-list'] },
      },
      children: items,
    },
  ];
}

/**
 * The remark plugin function.
 */
function remarkCite() {
  return (tree, file) => {
    const bibliography = loadBibliography();
    const citedKeys = new Set();

    // Walk the tree and replace citation patterns in text nodes, skipping
    // code, inlineCode, and link nodes. The shared helper collects the
    // replacements first, then applies them, so the tree is not mutated
    // during traversal.
    applyTextReplacements(tree, (node) =>
      processTextNode(node, citedKeys, file, bibliography)
    );

    // Append references section if any citations were found
    const refsSection = buildReferencesSection(citedKeys, bibliography);
    if (refsSection.length > 0) {
      tree.children.push(...refsSection);
    }
  };
}

module.exports = remarkCite;
