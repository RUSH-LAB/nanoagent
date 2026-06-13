import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { visitText, applyTextReplacements } = require('../plugins/remark-visit-text.js');

// ===========================================================================
// Helpers: build small mdast trees as plain objects.
// ===========================================================================

function textNode(value) {
  return { type: 'text', value };
}

function paragraph(...children) {
  return { type: 'paragraph', children };
}

function emphasis(...children) {
  return { type: 'emphasis', children };
}

function root(...children) {
  return { type: 'root', children };
}

// ===========================================================================
// Tests: pin two branches the sibling suite leaves uncovered.
//
// tests/next-remark-visit-text-skip.test.mjs already covers replacement WITH
// nodes, the falsy "leave in place" path, reverse-order multi-replace, and the
// code/inlineCode/link skip branches. The two gaps below are the empty-array
// splice-out deletion and recursion into a non-skipped container.
// ===========================================================================

describe('remark-visit-text (splice-out and nested visit)', () => {
  describe('applyTextReplacements', () => {
    it('splices the matched text node OUT when transform returns an empty array', () => {
      // An empty array is truthy, so the `if (newNodes)` guard records the
      // replacement and `splice(index, 1, ...[])` removes the matched node while
      // inserting nothing, deleting it from the tree.
      const tree = root(paragraph(textNode('a'), textNode('b'), textNode('c')));

      applyTextReplacements(tree, (node) => (node.value === 'b' ? [] : null));

      assert.deepStrictEqual(
        tree,
        root(paragraph(textNode('a'), textNode('c'))),
      );
    });
  });

  describe('visitText', () => {
    it('descends into a non-skipped container (emphasis), visiting nested text before the sibling', () => {
      // emphasis and strong are NOT in the code|inlineCode|link skip set, so the
      // walker recurses into the emphasis subtree first, then continues on to the
      // sibling text node of the paragraph.
      const tree = root(paragraph(emphasis(textNode('em')), textNode('plain')));

      const visited = [];
      visitText(tree, (node) => visited.push(node.value));

      assert.deepStrictEqual(visited, ['em', 'plain']);
    });
  });
});
