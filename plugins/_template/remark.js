/**
 * __TITLE__: the markdown syntax this plugin contributes.
 *
 * A remark plugin factory. plugins/loader.js finds this file and adds it to the
 * chain every content page is parsed with, after remark-math, so math is
 * already out of the tree by the time this runs.
 *
 * The walker below skips code, inlineCode and link nodes, and collects its
 * replacements before applying them, so the tree is never mutated mid-traversal.
 * See plugins/bibliography/remark.js ([@key]) or plugins/wiki-links/remark.js
 * ([[page]]) for the two worked examples. Delete this file if the tool adds no
 * syntax, which most tools do not.
 */
const { applyTextReplacements } = require('#markdown');

module.exports = function remark__CAMEL__() {
  return (tree, file) => {
    applyTextReplacements(tree, (node) => {
      // Return an array of mdast nodes to replace this text node, or null to
      // leave it alone. Returning null for everything is the no-op this starts
      // as, so a generated plugin changes no page until you write the syntax.
      void node;
      void file;
      return null;
    });
  };
};
