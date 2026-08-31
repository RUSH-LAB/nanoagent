import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown } from '../../../../../src/utils/markdown.js';

/** The spans of a document that is one paragraph long. */
function spansOf(source) {
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1, `expected one block from ${JSON.stringify(source)}`);
  return blocks[0].spans;
}

// The inline layer: code, emphasis and the precedence between them. The scan
// runs left to right and the first construct to open wins, which is the rule
// these cases exist to pin.
describe('parseMarkdown (inline)', () => {
  it('reads strong and emphasis around text', () => {
    assert.deepStrictEqual(spansOf('a **b** c *d* e'), [
      { type: 'text', text: 'a ' },
      { type: 'strong', text: 'b' },
      { type: 'text', text: ' c ' },
      { type: 'em', text: 'd' },
      { type: 'text', text: ' e' },
    ]);
  });

  it('reads inline code', () => {
    assert.deepStrictEqual(spansOf('run `npm test` first'), [
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'npm test' },
      { type: 'text', text: ' first' },
    ]);
  });

  it('lets inline code win over emphasis inside it', () => {
    assert.deepStrictEqual(spansOf('`a*b*c`'), [{ type: 'code', text: 'a*b*c' }]);
  });

  it('lets a double backtick span quote a backtick', () => {
    assert.deepStrictEqual(spansOf('``a ` b``'), [{ type: 'code', text: 'a ` b' }]);
  });

  it('strips one padding space from each side of a code span', () => {
    assert.deepStrictEqual(spansOf('`` `x` ``'), [{ type: 'code', text: '`x`' }]);
  });

  it('flattens a newline inside a code span, which is one line by definition', () => {
    assert.deepStrictEqual(spansOf('`a\nb`'), [{ type: 'code', text: 'a b' }]);
  });

  it('leaves an unterminated backtick literal', () => {
    assert.deepStrictEqual(spansOf('a ` b'), [{ type: 'text', text: 'a ` b' }]);
  });

  it('leaves unterminated emphasis markers literal', () => {
    assert.deepStrictEqual(spansOf('un**terminated'), [{ type: 'text', text: 'un**terminated' }]);
    assert.deepStrictEqual(spansOf('2 *x'), [{ type: 'text', text: '2 *x' }]);
  });

  it('does not read arithmetic as emphasis, because a marker may not flank a space', () => {
    assert.deepStrictEqual(spansOf('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }]);
  });

  it('leaves an empty emphasis marker literal', () => {
    // Alone on its line a run of four asterisks is a thematic break, so the
    // empty marker has to be tested where a break cannot start.
    assert.deepStrictEqual(spansOf('a **** b'), [{ type: 'text', text: 'a **** b' }]);
  });

  it('leaves an underscore alone, so snake_case survives', () => {
    assert.deepStrictEqual(spansOf('a _b_ snake_case_name'), [
      { type: 'text', text: 'a _b_ snake_case_name' },
    ]);
  });

  it('reads a single asterisk inside strong as part of the strong text', () => {
    assert.deepStrictEqual(spansOf('**a*b**'), [{ type: 'strong', text: 'a*b' }]);
  });

  it('carries emphasis across a soft line break', () => {
    assert.deepStrictEqual(spansOf('*a\nb*'), [{ type: 'em', text: 'a\nb' }]);
  });

  it('parses the inline layer of a heading, a quote and a list item alike', () => {
    const [heading, quote, list] = parseMarkdown('# a `b`\n\n> c **d**\n\n- e *f*');
    assert.deepStrictEqual(heading.spans, [
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'b' },
    ]);
    assert.deepStrictEqual(quote.spans, [
      { type: 'text', text: 'c ' },
      { type: 'strong', text: 'd' },
    ]);
    assert.deepStrictEqual(list.items, [
      [{ type: 'text', text: 'e ' }, { type: 'em', text: 'f' }],
    ]);
  });

  it('gives an empty heading no spans at all', () => {
    assert.deepStrictEqual(parseMarkdown('#'), [{ type: 'heading', level: 1, spans: [] }]);
  });

  it('keeps a run of plain text as one span', () => {
    assert.deepStrictEqual(spansOf('nothing to see here'), [
      { type: 'text', text: 'nothing to see here' },
    ]);
  });
});
