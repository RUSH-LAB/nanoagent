import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const remarkWikiLinks = require('../plugins/remark-wiki-links');

// ===========================================================================
// remark-wiki-links degenerate-input characterization
//
// Add-only goldens that pin how the REAL plugin (plugins/remark-wiki-links.js)
// already handles four degenerate inputs. They load the real remarkWikiLinks
// transform (no reimplementation of WIKI_LINK_RE or processTextNode) and edit
// no source. Each case asserts the transformed mdast tree with deepStrictEqual
// against a hand-built golden, mirroring the sibling helper style in
// tests/next-wikilinks-multi-textnode.test.mjs.
// ===========================================================================

/**
 * Build a minimal mdast root whose every paragraph holds a single text node,
 * mirroring the sibling tests/next-wikilinks-multi-textnode.test.mjs helper.
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

describe('remarkWikiLinks degenerate inputs (characterization)', () => {
  it('matches [[ ]] (whitespace-only target) into a link with url "/" and empty display', () => {
    // A space is a non-] non-| char, so [[ ]] DOES match; page trims to '',
    // giving href '/' and an empty display text.
    const tree = run(makeTree('[[ ]]'));

    assert.deepStrictEqual(tree, {
      type: 'root',
      children: [{ type: 'paragraph', children: [wikiLink('/', '')] }],
    });

    const link = tree.children[0].children[0];
    assert.equal(link.url, '/');
    assert.equal(link.children[0].value, '');
  });

  it('leaves [[mypage|]] (empty display after the pipe) verbatim because it never matches', () => {
    // The optional display group ([^\]]+) requires at least one non-] char, so
    // the whole pattern fails and processTextNode returns null. The paragraph
    // keeps its single original text node untouched.
    const tree = makeTree('[[mypage|]]');
    const original = JSON.parse(JSON.stringify(tree));
    run(tree);

    assert.deepStrictEqual(tree, original);
    assert.deepStrictEqual(tree.children[0], {
      type: 'paragraph',
      children: [{ type: 'text', value: '[[mypage|]]' }],
    });
  });

  it('renders [[alpha]][[beta]] (adjacent, no separator) as two links with no text between', () => {
    const tree = run(makeTree('[[alpha]][[beta]]'));

    assert.deepStrictEqual(tree, {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [wikiLink('/alpha', 'alpha'), wikiLink('/beta', 'beta')],
        },
      ],
    });

    // match.index === lastIndex for the second link, so the preceding-text push
    // is skipped: exactly two link nodes with nothing interleaved.
    const para = tree.children[0];
    assert.deepStrictEqual(
      para.children.map((n) => n.type),
      ['link', 'link'],
    );
    assert.equal(para.children[0].url, '/alpha');
    assert.equal(para.children[1].url, '/beta');
  });

  it('matches [[docs/]] (trailing slash) into url "/docs/" with an empty last-segment display', () => {
    // page is 'docs/', so href is '/docs/' and the last path segment after the
    // slash is the empty string, which becomes the display text.
    const tree = run(makeTree('[[docs/]]'));

    assert.deepStrictEqual(tree, {
      type: 'root',
      children: [{ type: 'paragraph', children: [wikiLink('/docs/', '')] }],
    });

    const link = tree.children[0].children[0];
    assert.equal(link.url, '/docs/');
    assert.equal(link.children[0].value, '');
  });
});
