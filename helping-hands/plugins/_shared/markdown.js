/** Walk text nodes safely, applying replacements after each parent is visited. */
function applyTextReplacements(tree, replace) {
  const visit = node => {
    if (!node?.children || ['code', 'inlineCode', 'link'].includes(node.type)) return;
    const next = [];
    for (const child of node.children) {
      if (child.type === 'text') next.push(...(replace(child) || [child]));
      else { visit(child); next.push(child); }
    }
    node.children = next;
  };
  visit(tree);
}

module.exports = {applyTextReplacements};
