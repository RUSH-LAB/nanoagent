import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const remarkWikiLinks = require('../../../../plugins/wiki-links/remark');

// ===========================================================================
// remark-wiki-links two-pipe display characterization
//
// Add-only goldens that pin how the REAL plugin (plugins/remark-wiki-links.js)
// splits a wiki link carrying TWO pipes, e.g. [[a/b|Disp|extra]]. The match
// regex is /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g: group 1 (the page) stops at the
// FIRST pipe because its class excludes the pipe, while group 2 (the display)
// is [^\]]+, which greedily absorbs everything up to ]] INCLUDING any later
// pipes. So [[a/b|Disp|extra]] yields a link with url /a/b and display text
// "Disp|extra".
//
// These tests load the real remarkWikiLinks transform (no reimplementation of
// WIKI_LINK_RE or processTextNode) and edit no source. The goldens were
// captured by running the real transform, not hand-guessed. They mirror the
// sibling harness in tests/next-wikilinks-degenerate-inputs.test.mjs.
// ===========================================================================

/**
 * Build a minimal mdast root whose every paragraph holds a single text node,
 * mirroring the sibling tests/next-wikilinks-degenerate-inputs.test.mjs helper.
 */
function makeTree(...paragraphTexts) {
  return {
    type: 'root',
    children: paragraphTexts.map((t) => ({
      type: 'paragraph',
      children: [{ type: 'text', value: t }],
    })),
  };
}

/**
 * Run the real remarkWikiLinks transform over a tree and return it mutated.
 */
function run(tree) {
  const transform = remarkWikiLinks();
  transform(tree);
  return tree;
}

/**
 * The exact link node remark-wiki-links emits: a link carrying the wikilink
 * class with a single text child holding the resolved display value.
 */
function wikiLink(url, value) {
  return {
    type: 'link',
    url,
    data: { hProperties: { className: ['wikilink'] } },
    children: [{ type: 'text', value }],
  };
}

/**
 * A plain mdast text node.
 */
function text(value) {
  return { type: 'text', value };
}

describe('remark-wiki-links two-pipe display', () => {
  it('splits [[a/b|Disp|extra]] into page "a/b" and display "Disp|extra" (the second pipe is absorbed)', () => {
    const tree = run(makeTree('[[a/b|Disp|extra]]'));

    assert.deepStrictEqual(tree, {
      type: 'root',
      children: [{ type: 'paragraph', children: [wikiLink('/a/b', 'Disp|extra')] }],
    });

    const link = tree.children[0].children[0];
    assert.equal(link.url, '/a/b');
    assert.equal(link.children[0].value, 'Disp|extra');
    assert.deepStrictEqual(link.data.hProperties.className, ['wikilink']);
  });

  it('trims [[ a/b | Disp|extra ]] to page "a/b" and display "Disp|extra"', () => {
    const tree = run(makeTree('[[ a/b | Disp|extra ]]'));

    assert.deepStrictEqual(tree, {
      type: 'root',
      children: [{ type: 'paragraph', children: [wikiLink('/a/b', 'Disp|extra')] }],
    });

    // Both capture groups apply .trim(): the page group ' a/b ' becomes 'a/b'
    // and the display group ' Disp|extra ' becomes 'Disp|extra'. The inner
    // second pipe survives because only leading and trailing whitespace is cut.
    const link = tree.children[0].children[0];
    assert.equal(link.url, '/a/b');
    assert.equal(link.children[0].value, 'Disp|extra');
  });

  it('absorbs every later pipe: [[page|a|b|c]] keeps the full display "a|b|c"', () => {
    const tree = run(makeTree('[[page|a|b|c]]'));

    assert.deepStrictEqual(tree, {
      type: 'root',
      children: [{ type: 'paragraph', children: [wikiLink('/page', 'a|b|c')] }],
    });
  });

  it('splices an embedded two-pipe link into text, link, text', () => {
    const tree = run(makeTree('Go to [[a/b|Disp|extra]] now.'));

    assert.deepStrictEqual(tree, {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [text('Go to '), wikiLink('/a/b', 'Disp|extra'), text(' now.')],
        },
      ],
    });
  });
});
