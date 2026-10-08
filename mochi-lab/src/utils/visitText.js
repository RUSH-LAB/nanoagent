/**
 * Shared Markdown AST text-node walker.
 *
 * Used by the markdown syntax plugins contribute (the bibliography's [@key],
 * wiki-links' [[page]]) to traverse text nodes while skipping code, inlineCode,
 * and link nodes, so none of them produces a nested link. It sits here rather
 * than in plugins/ because it is a utility two plugins happen to share, not a
 * plugin itself: it contributes nothing to the site on its own. The walker is
 * intentionally minimal; see the comment below.
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

/**
 * Collect text-node replacements across the tree, then apply them.
 *
 * Walks every visited text node with visitText, calling
 * transform(node, index, parent). When transform returns an array of
 * replacement nodes, the original text node is spliced out in its favor.
 * Replacements are gathered first and applied in reverse document order, so
 * that earlier indices stay valid while the tree is mutated.
 */
function applyTextReplacements(tree, transform) {
  const replacements = [];

  visitText(tree, (node, index, parent) => {
    const newNodes = transform(node, index, parent);
    if (newNodes) {
      replacements.push({ parent, index, newNodes });
    }
  });

  // Apply replacements in reverse order to preserve indices
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { parent, index, newNodes } = replacements[i];
    parent.children.splice(index, 1, ...newNodes);
  }
}

module.exports = { visitText, applyTextReplacements };
