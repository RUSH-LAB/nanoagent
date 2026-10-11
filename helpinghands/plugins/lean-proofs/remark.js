/** Wrap runnable Lean fences in the plugin-owned <LeanCode> component. */
module.exports = function remarkLeanProofs() {
  return tree => {
    const visit = node => {
      if (!node?.children) return;
      node.children = node.children.map(child => {
        if (child.type === 'code'
          && ['lean', 'lean4'].includes(String(child.lang || '').toLowerCase())
          && !String(child.meta || '').split(/\s+/).includes('noRun')) {
          return {
            type: 'mdxJsxFlowElement',
            name: 'LeanCode',
            attributes: [
              {type: 'mdxJsxAttribute', name: 'source', value: String(child.value || '')},
              {type: 'mdxJsxAttribute', name: 'language', value: String(child.lang || 'lean4')},
            ],
            children: [],
          };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
};
