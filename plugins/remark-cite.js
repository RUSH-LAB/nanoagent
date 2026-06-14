/**
 * remark-cite: A remark plugin for academic citations in Docusaurus.
 *
 * Syntax: [@key] or [@key1; @key2] in markdown text nodes.
 * Renders inline as "(Author et al., Year)" linking to #ref-key,
 * and appends a "References" section listing only cited works.
 *
 * Must run AFTER remark-math so math expressions are already parsed out.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { applyTextReplacements } = require('./remark-visit-text');

// Reload references.yaml on every call so the dev server picks up new entries
// without needing a restart. references.yaml is large (~250KB), so this re-reads
// and parses the whole file once per content file at build time.
const bibPath = path.resolve(__dirname, '..', 'bibliography', 'references.yaml');
function loadBibliography() {
  try {
    return yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
  } catch (err) {
    console.warn(`[remark-cite] Could not load ${bibPath}: ${err.message}`);
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
