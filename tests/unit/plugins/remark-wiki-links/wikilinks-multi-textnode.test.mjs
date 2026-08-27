import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const remarkWikiLinks = require('../../../../plugins/remark-wiki-links');

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Build a minimal mdast root from paragraph text values. Each paragraph holds
 * a single text node, mirroring the sibling test
 * tests/plugins/remark-wiki-links.test.mjs.
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
 * Collect every link node across all paragraphs of a transformed root.
 */
function allLinks(tree) {
  return tree.children.flatMap((para) =>
    para.children.filter((n) => n.type === 'link'),
  );
}

// ===========================================================================
// Cross-text-node regex-state isolation
//
// remark-wiki-links.js keeps WIKI_LINK_RE at module scope with the global
// flag, so its lastIndex is stateful: the WIKI_LINK_RE.test(text) guard at the
// top of processTextNode advances lastIndex, and that position would otherwise
// carry over from one text node to the next. processTextNode resets
// WIKI_LINK_RE.lastIndex to 0 before its exec loop on every call, which is what
// isolates regex state across the many text nodes a single transform walks.
// These add-only characterization tests pin that correct behavior; they edit
// no source.
// ===========================================================================

describe('remarkWikiLinks cross-text-node regex-state isolation', () => {
  it('transforms two sibling paragraphs independently into text, link, text', () => {
    const tree = run(makeTree('Go to [[alpha]] now.', 'Then [[beta]] please.'));

    const first = tree.children[0];
    assert.deepEqual(
      first.children.map((n) => n.type),
      ['text', 'link', 'text'],
    );
    assert.equal(first.children[0].value, 'Go to ');
    assert.equal(first.children[1].url, '/alpha');
    assert.equal(first.children[1].children[0].value, 'alpha');
    assert.ok(first.children[1].data.hProperties.className.includes('wikilink'));
    assert.equal(first.children[2].value, ' now.');

    const second = tree.children[1];
    assert.deepEqual(
      second.children.map((n) => n.type),
      ['text', 'link', 'text'],
    );
    assert.equal(second.children[0].value, 'Then ');
    assert.equal(second.children[1].url, '/beta');
    assert.equal(second.children[1].children[0].value, 'beta');
    assert.ok(second.children[1].data.hProperties.className.includes('wikilink'));
    assert.equal(second.children[2].value, ' please.');
  });

  it('leaves a plain middle paragraph untouched while transforming its siblings', () => {
    const tree = run(
      makeTree(
        'See [[alpha]].',
        'Just plain prose here.',
        'Read [[beta]] and [[notes/gamma|Gamma Note]].',
      ),
    );

    // Node 0: one wiki link, spliced into text, link, text.
    const node0Links = tree.children[0].children.filter((n) => n.type === 'link');
    assert.equal(node0Links.length, 1);
    assert.equal(node0Links[0].url, '/alpha');
    assert.equal(node0Links[0].children[0].value, 'alpha');
    assert.ok(node0Links[0].data.hProperties.className.includes('wikilink'));

    // Node 1: no wiki link, so processTextNode returns null and the node is
    // never spliced. It keeps its single original text child verbatim.
    const middle = tree.children[1];
    assert.equal(middle.children.length, 1);
    assert.equal(middle.children[0].type, 'text');
    assert.equal(middle.children[0].value, 'Just plain prose here.');

    // Node 2: two wiki links, including a custom [[target|Display]] alias.
    // The alias keeps the full slug as its url and the alias as display text.
    const node2Links = tree.children[2].children.filter((n) => n.type === 'link');
    assert.equal(node2Links.length, 2);
    assert.equal(node2Links[0].url, '/beta');
    assert.equal(node2Links[0].children[0].value, 'beta');
    assert.equal(node2Links[1].url, '/notes/gamma');
    assert.equal(node2Links[1].children[0].value, 'Gamma Note');
  });

  it('gives every produced link a url, display text, and wikilink class across all nodes', () => {
    const tree = run(
      makeTree(
        'Go to [[alpha]] now.',
        'No links in this one.',
        'Both [[beta]] and [[notes/gamma|Gamma Note]] here.',
      ),
    );

    const links = allLinks(tree);
    assert.equal(links.length, 3);

    for (const link of links) {
      assert.equal(link.type, 'link');
      assert.equal(typeof link.url, 'string');
      assert.ok(link.url.startsWith('/'));
      assert.equal(link.children.length, 1);
      assert.equal(link.children[0].type, 'text');
      assert.equal(typeof link.children[0].value, 'string');
      assert.ok(link.children[0].value.length > 0);
      assert.ok(Array.isArray(link.data.hProperties.className));
      assert.ok(link.data.hProperties.className.includes('wikilink'));
    }
  });
});
