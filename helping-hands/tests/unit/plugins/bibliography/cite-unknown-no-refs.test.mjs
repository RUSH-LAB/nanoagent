import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const remarkCite = require('../../../../plugins/bibliography/remark');

// ===========================================================================
// Helpers (mirror tests/plugins/remark-cite.test.mjs so this file stays
// self-contained and drives the REAL transform over a hand-built mdast tree:
// no Docusaurus build, database, or network.)
// ===========================================================================

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
 * Build a VFile-like object that collects warning messages.
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
 * Run the remarkCite transform on a tree, returning the mutated tree and file.
 */
function run(tree, file) {
  const transform = remarkCite();
  file = file || makeFile();
  transform(tree, file);
  return { tree, file };
}

// ===========================================================================
// Unknown-only citation path.
//
// These bogus keys (unk-a, unk-b, unk-c) are absent from the injected empty
// bibliography, so processTextNode never adds them to
// citedKeys (remark-cite.js line 96 runs only for known entries) and
// buildReferencesSection returns [] when citedKeys is empty (line 132 to 133).
// The result: unknown spans render inline, but NO References section appears.
// These cases pin that CURRENT, correct behavior.
// ===========================================================================

describe('remarkCite unknown-only citations', () => {
  it('appends NO References section for an all-unknown block', () => {
    const tree = makeTree('[@unk-a; @unk-b; @unk-c]');
    const { tree: result } = run(tree);

    // Only the original paragraph survives; nothing is appended.
    assert.equal(result.children.length, 1);

    // No reference scaffolding (heading, thematic break, or list) is appended.
    const refsNodes = result.children.filter(
      (n) =>
        n.type === 'heading' ||
        n.type === 'thematicBreak' ||
        n.type === 'list',
    );
    assert.equal(refsNodes.length, 0);
  });

  it('renders three unknown spans in one paren pair with "; " separators', () => {
    const tree = makeTree('[@unk-a; @unk-b; @unk-c]');
    const { tree: result } = run(tree);

    const para = result.children[0];

    // Exact node sequence: ( span ; span ; span )
    const kinds = para.children.map((n) => n.type);
    assert.deepStrictEqual(kinds, [
      'text',
      'html',
      'text',
      'html',
      'text',
      'html',
      'text',
    ]);

    // A single parenthesis pair wraps the whole group.
    assert.equal(para.children[0].value, '(');
    assert.equal(para.children[para.children.length - 1].value, ')');

    // The two interior separators are "; ".
    assert.equal(para.children[2].value, '; ');
    assert.equal(para.children[4].value, '; ');

    // Exactly three citation-unknown spans, one per key, in order.
    const htmlNodes = para.children.filter((n) => n.type === 'html');
    assert.equal(htmlNodes.length, 3);
    for (const node of htmlNodes) {
      assert.ok(node.value.includes('citation-unknown'));
    }
    assert.ok(htmlNodes[0].value.includes('[?unk-a]'));
    assert.ok(htmlNodes[1].value.includes('[?unk-b]'));
    assert.ok(htmlNodes[2].value.includes('[?unk-c]'));
  });

  it('emits exactly three file messages, one naming each unknown key', () => {
    const tree = makeTree('[@unk-a; @unk-b; @unk-c]');
    const file = makeFile();
    run(tree, file);

    assert.equal(file.messages.length, 3);
    assert.ok(file.messages[0].includes('unk-a'));
    assert.ok(file.messages[1].includes('unk-b'));
    assert.ok(file.messages[2].includes('unk-c'));
  });
});
