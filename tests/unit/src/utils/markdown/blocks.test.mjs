import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// parseMarkdown is authored as an ES module under src/utils (consumed by the
// Docusaurus build) and renders the assistant's replies in the CLI. Node's
// module-syntax detection lets this .mjs test import the .js source directly
// and read the named export, mirroring the fuzzyMatch suites.
import { parseMarkdown } from '../../../../../src/utils/markdown.js';

// The block layer: which lines become which block, and where one block ends.
// These cases pin the shape of the tree the renderer walks, so a change to the
// grammar cannot silently drop or merge a block.
describe('parseMarkdown (blocks)', () => {
  it('returns nothing for a non-string', () => {
    assert.deepStrictEqual(parseMarkdown(null), []);
    assert.deepStrictEqual(parseMarkdown(undefined), []);
    assert.deepStrictEqual(parseMarkdown(42), []);
  });

  it('returns nothing for an empty or blank document', () => {
    assert.deepStrictEqual(parseMarkdown(''), []);
    assert.deepStrictEqual(parseMarkdown('   \n\n\t'), []);
  });

  it('reads a paragraph, keeping its soft line breaks', () => {
    assert.deepStrictEqual(parseMarkdown('one\ntwo'), [
      { type: 'paragraph', spans: [{ type: 'text', text: 'one\ntwo' }] },
    ]);
  });

  it('splits paragraphs on a blank line', () => {
    assert.deepStrictEqual(parseMarkdown('one\n\ntwo'), [
      { type: 'paragraph', spans: [{ type: 'text', text: 'one' }] },
      { type: 'paragraph', spans: [{ type: 'text', text: 'two' }] },
    ]);
  });

  it('reads ATX headings up to three hashes', () => {
    assert.deepStrictEqual(parseMarkdown('# a\n## b\n### c'), [
      { type: 'heading', level: 1, spans: [{ type: 'text', text: 'a' }] },
      { type: 'heading', level: 2, spans: [{ type: 'text', text: 'b' }] },
      { type: 'heading', level: 3, spans: [{ type: 'text', text: 'c' }] },
    ]);
  });

  it('drops a heading’s closing hashes', () => {
    assert.deepStrictEqual(parseMarkdown('## middle ##'), [
      { type: 'heading', level: 2, spans: [{ type: 'text', text: 'middle' }] },
    ]);
  });

  it('reads a bullet list, either marker', () => {
    assert.deepStrictEqual(parseMarkdown('- one\n* two'), [
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
      },
    ]);
  });

  it('reads an ordered list, either delimiter', () => {
    assert.deepStrictEqual(parseMarkdown('1. one\n2) two'), [
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
      },
    ]);
  });

  it('starts a new list when the markers change kind', () => {
    const blocks = parseMarkdown('- one\n1. two');
    assert.deepStrictEqual(blocks.map((b) => [b.type, b.ordered]), [
      ['list', false],
      ['list', true],
    ]);
  });

  it('folds a continuation line into the item above it', () => {
    assert.deepStrictEqual(parseMarkdown('- one\n  still one\n- two'), [
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', text: 'one\nstill one' }], [{ type: 'text', text: 'two' }]],
      },
    ]);
  });

  it('reads consecutive quote lines as one quote', () => {
    assert.deepStrictEqual(parseMarkdown('> one\n> two'), [
      { type: 'quote', spans: [{ type: 'text', text: 'one\ntwo' }] },
    ]);
  });

  it('separates two quotes across a blank line', () => {
    assert.deepStrictEqual(parseMarkdown('> one\n\n> two').map((b) => b.type), ['quote', 'quote']);
  });

  it('reads a thematic break from any of the three markers', () => {
    assert.deepStrictEqual(parseMarkdown('---\n\n***\n\n___'), [
      { type: 'rule' },
      { type: 'rule' },
      { type: 'rule' },
    ]);
  });

  it('prefers a thematic break over a bullet list for "* * *"', () => {
    assert.deepStrictEqual(parseMarkdown('* * *'), [{ type: 'rule' }]);
  });

  it('reads a fenced block with its language, lowercased', () => {
    assert.deepStrictEqual(parseMarkdown('```JS\nconst a = 1;\n```'), [
      { type: 'code', lang: 'js', code: 'const a = 1;' },
    ]);
  });

  it('reads a fenced block with no language as lang null', () => {
    assert.deepStrictEqual(parseMarkdown('```\nplain\n```'), [
      { type: 'code', lang: null, code: 'plain' },
    ]);
  });

  it('accepts a tilde fence and ignores a backtick fence inside it', () => {
    assert.deepStrictEqual(parseMarkdown('~~~\n```\n~~~'), [
      { type: 'code', lang: null, code: '```' },
    ]);
  });

  it('keeps markdown inside a fence literal', () => {
    assert.deepStrictEqual(parseMarkdown('```\n# not a heading\n- not a list\n```'), [
      { type: 'code', lang: null, code: '# not a heading\n- not a list' },
    ]);
  });

  it('runs an unclosed fence to the end rather than losing the answer', () => {
    assert.deepStrictEqual(parseMarkdown('```py\nhalf a reply'), [
      { type: 'code', lang: 'py', code: 'half a reply' },
    ]);
  });

  it('ends a paragraph where the next block starts, with no blank line', () => {
    assert.deepStrictEqual(parseMarkdown('text\n# head\ntext\n- item').map((b) => b.type), [
      'paragraph',
      'heading',
      'paragraph',
      'list',
    ]);
  });

  it('normalises CRLF and a lone CR', () => {
    assert.deepStrictEqual(parseMarkdown('one\r\n\r\ntwo\rthree'), [
      { type: 'paragraph', spans: [{ type: 'text', text: 'one' }] },
      { type: 'paragraph', spans: [{ type: 'text', text: 'two\nthree' }] },
    ]);
  });
});
