/**
 * remark-visit-text: Shared Markdown AST text-node walker.
 *
 * Used by remark-cite and remark-wiki-links to traverse text nodes while
 * skipping code, inlineCode, and link nodes (so neither plugin produces
 * nested links). The walker is intentionally minimal; see the comment below.
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

module.exports = { visitText };
