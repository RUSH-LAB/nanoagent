import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { visitText, applyTextReplacements } = require('../../../../src/utils/visitText.js');

// ===========================================================================
// Helpers: build small mdast trees as plain objects.
// ===========================================================================

function textNode(value) {
  return { type: 'text', value };
}

function paragraph(...children) {
  return { type: 'paragraph', children };
}

function root(...children) {
  return { type: 'root', children };
}

function linkNode(...children) {
  return { type: 'link', url: '/page', children };
}

function clone(tree) {
  return JSON.parse(JSON.stringify(tree));
}

// ===========================================================================
// Tests: pin the CURRENT, correct behavior of the shared text-node walker.
// ===========================================================================

describe('remark-visit-text', () => {
  describe('visitText', () => {
    it('invokes the callback for text nodes under the root and under a paragraph in document order', () => {
      const tree = root(
        textNode('A'),
        paragraph(textNode('B')),
        textNode('C'),
      );

      const visits = [];
      visitText(tree, (node, index, parent) => {
        visits.push({ value: node.value, index, parentType: parent.type });
      });

      assert.deepStrictEqual(visits, [
        { value: 'A', index: 0, parentType: 'root' },
        { value: 'B', index: 0, parentType: 'paragraph' },
        { value: 'C', index: 2, parentType: 'root' },
      ]);
    });

    it('does not invoke the callback for a text child of a link node (skip branch)', () => {
      const tree = root(linkNode(textNode('inside link')));

      const visited = [];
      visitText(tree, (node) => visited.push(node.value));

      assert.deepStrictEqual(visited, []);
    });

    it('does not invoke the callback for text children of code or inlineCode nodes', () => {
      // Real mdast code and inlineCode are leaf nodes carrying a string value and
      // no children. We attach children here so the walker's skip guard (the early
      // return for code, inlineCode, and link) is the only reason the inner text
      // stays unvisited, which keeps this case from being vacuous.
      const tree = root(
        { type: 'code', children: [textNode('inside code')] },
        paragraph({ type: 'inlineCode', children: [textNode('inside inline code')] }),
      );

      const visited = [];
      visitText(tree, (node) => visited.push(node.value));

      assert.deepStrictEqual(visited, []);
    });

    it('skips only the link subtree while still visiting its sibling text nodes', () => {
      const tree = root(
        paragraph(
          textNode('before'),
          linkNode(textNode('inside link')),
          textNode('after'),
        ),
      );

      const visited = [];
      visitText(tree, (node) => visited.push(node.value));

      assert.deepStrictEqual(visited, ['before', 'after']);
    });
  });

  describe('applyTextReplacements', () => {
    it('splices in the replacement nodes when transform returns an array', () => {
      const tree = root(paragraph(textNode('replace me')));

      applyTextReplacements(tree, (node) => {
        if (node.value === 'replace me') {
          return [linkNode(textNode('X'))];
        }
        return null;
      });

      const para = tree.children[0];
      assert.equal(para.children.length, 1);
      assert.equal(para.children[0].type, 'link');
      assert.equal(para.children[0].children[0].value, 'X');
    });

    it('leaves the node in place when transform returns a falsy value', () => {
      const tree = root(paragraph(textNode('keep me')));
      const before = clone(tree);

      applyTextReplacements(tree, () => null);

      assert.deepStrictEqual(tree, before);
    });

    it('applies multiple replacements in a parent in reverse order so earlier indices stay valid', () => {
      const tree = root(
        paragraph(textNode('one'), textNode('two'), textNode('three')),
      );

      applyTextReplacements(tree, (node) => {
        if (node.value === 'one') {
          return [textNode('1a'), textNode('1b')];
        }
        if (node.value === 'three') {
          return [textNode('3a'), textNode('3b')];
        }
        return null;
      });

      const values = tree.children[0].children.map((n) => n.value);
      assert.deepStrictEqual(values, ['1a', '1b', 'two', '3a', '3b']);
    });

    it('leaves text inside a link (a skipped parent) untouched', () => {
      const tree = root(linkNode(textNode('inside link')));
      const before = clone(tree);

      applyTextReplacements(tree, () => [textNode('should not appear')]);

      assert.deepStrictEqual(tree, before);
    });
  });
});
