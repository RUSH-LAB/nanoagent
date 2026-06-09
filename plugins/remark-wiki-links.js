/**
 * remark-wiki-links: A remark plugin for wiki-style links in Docusaurus.
 *
 * Syntax: [[page]] or [[page|Display Text]] in markdown text nodes.
 * Renders as <a href="/page">page</a> or <a href="/page">Display Text</a>.
 *
 * Paths like [[path/to/page]] become href="/path/to/page".
 */

// Simple tree walker — avoids ESM/CJS issues with unist-util-visit v5
function visitText(tree, callback) {
  function walk(node, index, parent) {
    if (node.type === 'text' && parent) {
      callback(node, index, parent);
    }
    if (node.children) {
      // Skip code blocks and links to avoid producing nested <a> elements
      if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'link') return;
      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i], i, node);
      }
    }
  }
  walk(tree, null, null);
}

// Regex to match [[page]] or [[page|Display Text]]
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Process a single text node, splitting it into text + wiki link nodes.
 * Returns an array of nodes to replace the original text node, or null
 * if no wiki links were found.
 */
function processTextNode(node) {
  const text = node.value;
  if (!WIKI_LINK_RE.test(text)) return null;

  const result = [];
  let lastIndex = 0;
  WIKI_LINK_RE.lastIndex = 0;

  let match;
  while ((match = WIKI_LINK_RE.exec(text)) !== null) {
    // Add preceding text
    if (match.index > lastIndex) {
      result.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    const page = match[1].trim();
    // Default display text is the last path segment (e.g., "math/intro" → "intro")
    const defaultDisplay = page.includes('/') ? page.split('/').pop() : page;
    const displayText = match[2] ? match[2].trim() : defaultDisplay;
    const href = '/' + page;

    result.push({
      type: 'link',
      url: href,
      data: {
        hProperties: { className: ['wikilink'] },
      },
      children: [{ type: 'text', value: displayText }],
    });

    lastIndex = match.index + match[0].length;
  }

  // Add trailing text
  if (lastIndex < text.length) {
    result.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return result;
}

/**
 * The remark plugin function.
 */
function remarkWikiLinks() {
  return (tree) => {
    // Collect replacements first, then apply them (to avoid mutation during traversal).
    const replacements = [];

    visitText(tree, (node, index, parent) => {
      const newNodes = processTextNode(node);
      if (newNodes) {
        replacements.push({ parent, index, newNodes });
      }
    });

    // Apply replacements in reverse order to preserve indices
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { parent, index, newNodes } = replacements[i];
      parent.children.splice(index, 1, ...newNodes);
    }
  };
}

module.exports = remarkWikiLinks;
