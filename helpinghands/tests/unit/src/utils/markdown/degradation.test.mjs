import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown } from '../../../../../src/utils/markdown.js';

// What the parser does with the markdown it does NOT implement. The rule is
// that an unsupported construct reads as the characters the assistant typed,
// so nothing is ever silently swallowed; each case below is one such
// construct, pinned so a later grammar change is a deliberate one.
describe('parseMarkdown (degradation to text)', () => {
  it('leaves a table as its own lines of text', () => {
    assert.deepStrictEqual(parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |'), [
      { type: 'paragraph', spans: [{ type: 'text', text: '| a | b |\n| - | - |\n| 1 | 2 |' }] },
    ]);
  });

  it('leaves a fourth level heading as text, because three is the deepest', () => {
    assert.deepStrictEqual(parseMarkdown('#### deep'), [
      { type: 'paragraph', spans: [{ type: 'text', text: '#### deep' }] },
    ]);
  });

  it('leaves a hash with no space as text', () => {
    assert.deepStrictEqual(parseMarkdown('#tag'), [
      { type: 'paragraph', spans: [{ type: 'text', text: '#tag' }] },
    ]);
  });

  it('leaves a four space indent as text, because indented code is not implemented', () => {
    assert.deepStrictEqual(parseMarkdown('    const a = 1;'), [
      { type: 'paragraph', spans: [{ type: 'text', text: 'const a = 1;' }] },
    ]);
  });

  it('does not read a setext underline as a heading', () => {
    // An equals underline is simply the next line of the paragraph, and a dash
    // underline is the thematic break it also looks like. Neither promotes the
    // title above it, because only ATX headings are implemented.
    assert.deepStrictEqual(parseMarkdown('Title\n==='), [
      { type: 'paragraph', spans: [{ type: 'text', text: 'Title\n===' }] },
    ]);
    assert.deepStrictEqual(parseMarkdown('Title\n---').map((b) => b.type), ['paragraph', 'rule']);
  });

  it('leaves a strikethrough as text', () => {
    assert.deepStrictEqual(parseMarkdown('~~gone~~'), [
      { type: 'paragraph', spans: [{ type: 'text', text: '~~gone~~' }] },
    ]);
  });

  it('leaves a footnote reference as text', () => {
    assert.deepStrictEqual(parseMarkdown('a claim[^1]'), [
      { type: 'paragraph', spans: [{ type: 'text', text: 'a claim[^1]' }] },
    ]);
  });

  it('reads an image as its exclamation mark and a link to the file', () => {
    // There is nowhere in a three line window to put a picture, so an image
    // degrades to the address of one, which the reader can still open.
    assert.deepStrictEqual(parseMarkdown('![alt](https://x.dev/a.png)')[0].spans, [
      { type: 'text', text: '!' },
      { type: 'link', text: 'alt', href: 'https://x.dev/a.png' },
    ]);
  });

  it('reads a task list as a list whose box is part of the text', () => {
    assert.deepStrictEqual(parseMarkdown('- [ ] todo')[0], {
      type: 'list',
      ordered: false,
      items: [[{ type: 'text', text: '[ ] todo' }]],
    });
  });

  it('flattens a nested list into one level', () => {
    // Indentation is not depth here: an indented marker is still a marker, so
    // the child becomes a sibling. A window this narrow has no room for a
    // second level of indent anyway, and no item is lost.
    assert.deepStrictEqual(parseMarkdown('- one\n  - child')[0].items, [
      [{ type: 'text', text: 'one' }],
      [{ type: 'text', text: 'child' }],
    ]);
  });

  it('keeps an html comment as text, since nothing here interprets html', () => {
    assert.deepStrictEqual(parseMarkdown('<!-- hidden -->'), [
      { type: 'paragraph', spans: [{ type: 'text', text: '<!-- hidden -->' }] },
    ]);
  });

  it('walks a whole reply without losing a block', () => {
    const reply = [
      '## Plan',
      '',
      'Two steps, and a `flag` to set:',
      '',
      '1. install it',
      '2. run it',
      '',
      '```sh',
      'npm test',
      '```',
      '',
      '> careful with **state**',
      '',
      '---',
      '',
      'See https://x.dev for the rest.',
    ].join('\n');

    assert.deepStrictEqual(parseMarkdown(reply).map((b) => b.type), [
      'heading',
      'paragraph',
      'list',
      'code',
      'quote',
      'rule',
      'paragraph',
    ]);
  });
});
