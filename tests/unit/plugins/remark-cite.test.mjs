import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const remarkCite = require('../../../plugins/remark-cite');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mdast tree from an array of paragraph text values.
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
 * Build a VFile-like object that collects messages.
 */
function makeFile() {
  const messages = [];
  return {
    messages,
    message(msg) {
      messages.push(msg);
    },
  };
}

/**
 * Run the remarkCite transform on a tree and return both the mutated tree and
 * the file messages.
 */
function run(tree, file) {
  const transform = remarkCite();
  file = file || makeFile();
  transform(tree, file);
  return { tree, file };
}

// ---------------------------------------------------------------------------
// Discover a few real keys from the bibliography loaded by the plugin.
// This avoids hardcoding entries that might be removed.
// ---------------------------------------------------------------------------
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const bibPath = path.resolve(
  path.dirname(require.resolve('../../../plugins/remark-cite')),
  '..',
  'content',
  'bibliography',
  'references.yaml',
);
const bibliography = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
const allKeys = Object.keys(bibliography);

// Pick keys with known characteristics
const keyWith1Author = allKeys.find(
  (k) => bibliography[k].author && bibliography[k].author.length === 1,
);
const keyWith2Authors = allKeys.find(
  (k) => bibliography[k].author && bibliography[k].author.length === 2,
);
const keyWith3PlusAuthors = allKeys.find(
  (k) => bibliography[k].author && bibliography[k].author.length >= 3,
);
const keyWithUrl = allKeys.find((k) => bibliography[k].url);
const keyWithoutUrl = allKeys.find((k) => !bibliography[k].url);

// For tests that need two distinct keys, pick the first two with authors
const twoKeys = allKeys
  .filter((k) => bibliography[k].author && bibliography[k].author.length > 0)
  .slice(0, 2);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('remarkCite', () => {
  // ---- Single citation ----

  describe('single citation', () => {
    it('replaces [@key] with a parenthesized link for a 1-author entry', () => {
      if (!keyWith1Author) return; // skip if no suitable entry
      const tree = makeTree(`See [@${keyWith1Author}] here.`);
      const { tree: result } = run(tree);

      const para = result.children[0];
      assert.ok(para.children.length >= 3, 'should have at least 3 nodes');

      // Find the opening paren, link, and closing paren
      const texts = para.children.filter((n) => n.type === 'text');
      const links = para.children.filter((n) => n.type === 'link');
      assert.equal(links.length, 1);
      assert.equal(links[0].url, `#ref-${keyWith1Author}`);

      // The link text should be "LastName, Year"
      const entry = bibliography[keyWith1Author];
      const lastName = entry.author[0].split(/\s+/).pop();
      const expectedLabel = `${lastName}, ${entry.year}`;
      assert.equal(links[0].children[0].value, expectedLabel);

      // Parentheses should wrap the link
      const linkIdx = para.children.indexOf(links[0]);
      assert.equal(para.children[linkIdx - 1].value, '(');
      assert.equal(para.children[linkIdx + 1].value, ')');
    });

    it('replaces [@key] for a 2-author entry with "Last1 & Last2"', () => {
      if (!keyWith2Authors) return;
      const tree = makeTree(`See [@${keyWith2Authors}].`);
      run(tree);

      const links = tree.children[0].children.filter((n) => n.type === 'link');
      assert.equal(links.length, 1);

      const entry = bibliography[keyWith2Authors];
      const last1 = entry.author[0].split(/\s+/).pop();
      const last2 = entry.author[1].split(/\s+/).pop();
      const label = links[0].children[0].value;
      assert.ok(label.includes(`${last1} & ${last2}`));
    });

    it('replaces [@key] for a 3+ author entry with "First et al."', () => {
      if (!keyWith3PlusAuthors) return;
      const tree = makeTree(`See [@${keyWith3PlusAuthors}].`);
      run(tree);

      const links = tree.children[0].children.filter((n) => n.type === 'link');
      assert.equal(links.length, 1);

      const entry = bibliography[keyWith3PlusAuthors];
      const firstLast = entry.author[0].split(/\s+/).pop();
      const label = links[0].children[0].value;
      assert.ok(
        label.startsWith(`${firstLast} et al.`),
        `Expected "${label}" to start with "${firstLast} et al."`,
      );
    });
  });

  // ---- Multiple citations ----

  describe('multiple citations', () => {
    it('handles [@key1; @key2] with semicolons between links', () => {
      if (twoKeys.length < 2) return;
      const tree = makeTree(`See [@${twoKeys[0]}; @${twoKeys[1]}].`);
      run(tree);

      const para = tree.children[0];
      const links = para.children.filter((n) => n.type === 'link');
      assert.equal(links.length, 2, 'should produce 2 citation links');
      assert.equal(links[0].url, `#ref-${twoKeys[0]}`);
      assert.equal(links[1].url, `#ref-${twoKeys[1]}`);

      // Should have a semicolon separator between the two links
      const link1Idx = para.children.indexOf(links[0]);
      const link2Idx = para.children.indexOf(links[1]);
      const between = para.children.slice(link1Idx + 1, link2Idx);
      const semicolonNode = between.find(
        (n) => n.type === 'text' && n.value.includes(';'),
      );
      assert.ok(semicolonNode, 'should have a semicolon separator');
    });

    it('wraps multiple citations in a single pair of parentheses', () => {
      if (twoKeys.length < 2) return;
      const tree = makeTree(`[@${twoKeys[0]}; @${twoKeys[1]}]`);
      run(tree);

      const para = tree.children[0];
      // First text node should be "("
      assert.equal(para.children[0].type, 'text');
      assert.equal(para.children[0].value, '(');
      // Last text node should be ")"
      assert.equal(para.children[para.children.length - 1].type, 'text');
      assert.equal(para.children[para.children.length - 1].value, ')');
    });
  });

  // ---- Unknown citations ----

  describe('unknown citation', () => {
    it('produces an html span with class citation-unknown for unknown keys', () => {
      const tree = makeTree('See [@nonexistent-key-xyz] here.');
      const file = makeFile();
      run(tree, file);

      const para = tree.children[0];
      const htmlNodes = para.children.filter((n) => n.type === 'html');
      assert.equal(htmlNodes.length, 1);
      assert.ok(htmlNodes[0].value.includes('citation-unknown'));
      assert.ok(htmlNodes[0].value.includes('nonexistent-key-xyz'));
    });

    it('reports a warning message on the file for unknown keys', () => {
      const tree = makeTree('[@unknown-key-abc]');
      const file = makeFile();
      run(tree, file);

      assert.equal(file.messages.length, 1);
      assert.ok(file.messages[0].includes('unknown-key-abc'));
    });

    it('handles mix of valid and unknown keys in multi-citation', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}; @bogus-ref-xyz]`);
      const file = makeFile();
      run(tree, file);

      const para = tree.children[0];
      const links = para.children.filter((n) => n.type === 'link');
      const htmlNodes = para.children.filter((n) => n.type === 'html');
      assert.equal(links.length, 1, 'one valid link');
      assert.equal(htmlNodes.length, 1, 'one unknown span');
      assert.equal(file.messages.length, 1);
    });
  });

  // ---- No citations ----

  describe('no citations', () => {
    it('leaves the tree unchanged when there are no citations', () => {
      const tree = makeTree('Just a normal paragraph with no citations.');
      const original = JSON.parse(JSON.stringify(tree));
      run(tree);

      assert.deepStrictEqual(tree, original);
    });

    it('does not add a References section when no citations exist', () => {
      const tree = makeTree('No citations here.');
      run(tree);

      const headings = tree.children.filter((n) => n.type === 'heading');
      assert.equal(headings.length, 0);
    });
  });

  // ---- References section ----

  describe('references section', () => {
    it('appends a References heading when citations exist', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const headings = tree.children.filter((n) => n.type === 'heading');
      assert.equal(headings.length, 1);
      assert.equal(headings[0].depth, 2);
      assert.equal(headings[0].children[0].value, 'References');
    });

    it('includes a thematic break before the References heading', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const breakIdx = tree.children.findIndex(
        (n) => n.type === 'thematicBreak',
      );
      const headingIdx = tree.children.findIndex(
        (n) => n.type === 'heading',
      );
      assert.ok(breakIdx >= 0, 'should have a thematic break');
      assert.ok(
        breakIdx < headingIdx,
        'break should come before heading',
      );
    });

    it('appends a list with cited references', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      assert.ok(list, 'should have a reference list');
      assert.equal(list.ordered, false);
      assert.equal(list.children.length, 1);
      assert.equal(list.children[0].type, 'listItem');
    });

    it('each list item has id="ref-KEY"', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      const item = list.children[0];
      assert.equal(item.data.hProperties.id, `ref-${twoKeys[0]}`);
    });

    it('references are sorted by author last name', () => {
      if (twoKeys.length < 2) return;
      const tree = makeTree(`[@${twoKeys[0]}; @${twoKeys[1]}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      assert.equal(list.children.length, 2);

      // Verify sort order by comparing the ids
      const ids = list.children.map((li) => li.data.hProperties.id);

      // Get the expected sort order
      const e0 = bibliography[twoKeys[0]];
      const e1 = bibliography[twoKeys[1]];
      const last0 = (e0.author || [''])[0].split(/\s+/).pop() || '';
      const last1 = (e1.author || [''])[0].split(/\s+/).pop() || '';
      const cmp = last0.localeCompare(last1);
      if (cmp < 0) {
        assert.equal(ids[0], `ref-${twoKeys[0]}`);
        assert.equal(ids[1], `ref-${twoKeys[1]}`);
      } else if (cmp > 0) {
        assert.equal(ids[0], `ref-${twoKeys[1]}`);
        assert.equal(ids[1], `ref-${twoKeys[0]}`);
      }
      // If cmp === 0 (same last name), order by year; just check both are present
      assert.ok(ids.includes(`ref-${twoKeys[0]}`));
      assert.ok(ids.includes(`ref-${twoKeys[1]}`));
    });

    it('entry with URL wraps reference text in a link', () => {
      if (!keyWithUrl) return;
      const tree = makeTree(`[@${keyWithUrl}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      const item = list.children[0];
      const para = item.children[0];

      // First child of the paragraph should be a link (the reference text)
      const refLink = para.children[0];
      assert.equal(refLink.type, 'link');
      assert.equal(refLink.url, bibliography[keyWithUrl].url);
    });

    it('entry without URL uses plain text for reference', () => {
      if (!keyWithoutUrl) return;
      const tree = makeTree(`[@${keyWithoutUrl}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      const item = list.children[0];
      const para = item.children[0];

      // First child should be a text node, not a link
      assert.equal(para.children[0].type, 'text');
    });

    it('each reference item has a detail link to /bibliography/KEY', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      const para = list.children[0].children[0]; // paragraph inside listItem
      const detailLink = para.children.find(
        (n) => n.type === 'link' && n.url === `/bibliography/${twoKeys[0]}`,
      );
      assert.ok(detailLink, 'should have a detail link');
      assert.equal(detailLink.children[0].value, '↗'); // ↗
    });

    it('only cited keys appear in the references section (not all bibliography)', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      assert.equal(
        list.children.length,
        1,
        'only the single cited key should appear',
      );
    });
  });

  // ---- Code blocks ----

  describe('code blocks', () => {
    it('does not transform citations inside code blocks', () => {
      if (!twoKeys[0]) return;
      const tree = {
        type: 'root',
        children: [
          {
            type: 'code',
            value: `See [@${twoKeys[0]}]`,
          },
        ],
      };
      run(tree);

      // No references section should be appended
      assert.equal(tree.children.length, 1);
      assert.equal(tree.children[0].type, 'code');
    });

    it('does not transform citations inside inline code', () => {
      if (!twoKeys[0]) return;
      const tree = {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'inlineCode',
                value: `[@${twoKeys[0]}]`,
              },
            ],
          },
        ],
      };
      run(tree);

      assert.equal(tree.children.length, 1);
      const para = tree.children[0];
      assert.equal(para.children.length, 1);
      assert.equal(para.children[0].type, 'inlineCode');
    });
  });

  // ---- Multiple paragraphs ----

  describe('multiple paragraphs', () => {
    it('processes citations in multiple paragraphs', () => {
      if (twoKeys.length < 2) return;
      const tree = makeTree(
        `First para [@${twoKeys[0]}].`,
        `Second para [@${twoKeys[1]}].`,
      );
      run(tree);

      // Both paragraphs should have links
      for (let i = 0; i < 2; i++) {
        const links = tree.children[i].children.filter(
          (n) => n.type === 'link',
        );
        assert.ok(links.length >= 1, `paragraph ${i} should have a link`);
      }

      // References section should have both
      const list = tree.children.find((n) => n.type === 'list');
      assert.equal(list.children.length, 2);
    });

    it('deduplicates citations across paragraphs in references', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(
        `First [@${twoKeys[0]}].`,
        `Second [@${twoKeys[0]}].`,
      );
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      assert.equal(
        list.children.length,
        1,
        'same key cited twice should appear once in references',
      );
    });
  });

  // ---- Citation text positioning ----

  describe('text positioning', () => {
    it('preserves text before and after a citation', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`Before [@${twoKeys[0]}] after.`);
      run(tree);

      const para = tree.children[0];
      // First node should be "Before " (text before citation)
      assert.equal(para.children[0].type, 'text');
      assert.equal(para.children[0].value, 'Before ');
      // Last node should be " after." (text after citation)
      const lastChild = para.children[para.children.length - 1];
      assert.equal(lastChild.type, 'text');
      assert.equal(lastChild.value, ' after.');
    });

    it('handles citation at the very start of text', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}] is important.`);
      run(tree);

      const para = tree.children[0];
      // First node should be the opening paren
      assert.equal(para.children[0].type, 'text');
      assert.equal(para.children[0].value, '(');
    });

    it('handles citation at the very end of text', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`Important work [@${twoKeys[0]}]`);
      run(tree);

      const para = tree.children[0];
      // Last node should be the closing paren
      const last = para.children[para.children.length - 1];
      assert.equal(last.type, 'text');
      assert.equal(last.value, ')');
    });

    it('handles multiple citations in separate brackets in one text node', () => {
      if (twoKeys.length < 2) return;
      const tree = makeTree(
        `A [@${twoKeys[0]}] and B [@${twoKeys[1]}].`,
      );
      run(tree);

      const para = tree.children[0];
      const links = para.children.filter((n) => n.type === 'link');
      // Should have 2 citation links (plus detail links in references)
      assert.equal(links.length, 2);
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('citation key with hyphens works', () => {
      // All keys in our bibliography use hyphens, just verify they work
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const para = tree.children[0];
      const links = para.children.filter((n) => n.type === 'link');
      assert.equal(links.length, 1);
    });

    it('non-citation brackets are not transformed', () => {
      const tree = makeTree('Regular [text] and [more text].');
      const original = JSON.parse(JSON.stringify(tree));
      run(tree);

      assert.deepStrictEqual(tree, original);
    });

    it('empty tree produces no changes', () => {
      const tree = { type: 'root', children: [] };
      run(tree);
      assert.equal(tree.children.length, 0);
    });

    it('reference list has class reference-list', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      assert.ok(list.data.hProperties.className.includes('reference-list'));
    });

    it('reference items have class reference-item', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const list = tree.children.find((n) => n.type === 'list');
      assert.ok(
        list.children[0].data.hProperties.className.includes('reference-item'),
      );
    });

    it('citation links have class citation-link', () => {
      if (!twoKeys[0]) return;
      const tree = makeTree(`[@${twoKeys[0]}]`);
      run(tree);

      const para = tree.children[0];
      const link = para.children.find((n) => n.type === 'link');
      assert.ok(link.data.hProperties.className.includes('citation-link'));
    });
  });
});
