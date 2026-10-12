import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown, settledLength } from '../../../../../src/utils/markdown.js';

// Two things make a streamed answer affordable, and both are invisible in the
// output, so they are pinned here rather than in the four suites that pin what
// the parser reads. The first is that the search for a closer is paid once per
// block instead of once per opener: an answer may hold thousands of asterisks,
// brackets and backticks that never close, and re-walking the block at each of
// them used to take seconds. The second is settledLength, the split that lets
// a renderer parse a growing answer once instead of once per delta.
//
// The budget below is loose on purpose. What it excludes measured nine seconds
// on one paragraph, so a slow machine or a busy test runner cannot make this
// flake without also being unusable.
const BUDGET_MS = 1000;

/** Parse, and report how long it took, so a regression names its own cost. */
function timed(text) {
  const started = process.hrtime.bigint();
  const blocks = parseMarkdown(text);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, blocks };
}

function assertLiteral(text, label) {
  const { ms, blocks } = timed(text);
  assert.deepStrictEqual(blocks, [{ type: 'paragraph', spans: [{ type: 'text', text }] }]);
  assert.ok(ms < BUDGET_MS, `${label} took ${ms.toFixed(0)} ms, over the ${BUDGET_MS} ms budget`);
}

describe('parseMarkdown (a block full of openers that never close)', () => {
  it('reads 32000 unclosed asterisks as one run of text', () => {
    assertLiteral('*a '.repeat(32000).trimEnd(), '96 KB of asterisks');
  });

  it('reads runs of backticks that never meet their own width as text', () => {
    // A closing run has to be exactly as long as the one that opened it, so
    // runs of growing length never close each other and every one of them used
    // to walk the rest of the block looking anyway.
    let ticks = '';
    for (let n = 1; n <= 400; n += 1) ticks += `${'`'.repeat(n)}a `;
    assertLiteral(ticks.trimEnd(), '80 KB of growing backtick runs');
  });

  it('reads 100000 unclosed brackets as one run of text', () => {
    assertLiteral('['.repeat(100000), '100 KB of brackets');
  });

  it('reads brackets whose only closer opens no link as one run of text', () => {
    // The closing bracket exists, so the cheap "is there a ']' at all" answer
    // is no help; what makes this linear is that the tail after that bracket
    // is examined once rather than once per '['.
    assertLiteral(`${'['.repeat(120000)}](not a url)`, '120 KB of brackets with a dead tail');
  });

  it('parses every delta of an answer made of stray markers inside the budget', () => {
    const answer = '*a [b `c '.repeat(3000);
    const step = Math.ceil(answer.length / 400);
    const started = process.hrtime.bigint();
    for (let n = step; n <= answer.length; n += step) parseMarkdown(answer.slice(0, n));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < BUDGET_MS, `400 deltas took ${ms.toFixed(0)} ms, over the ${BUDGET_MS} ms budget`);
  });
});

describe('parseMarkdown (a failed search never hides a later construct)', () => {
  it('keeps emphasis after an opener the flanking rule refused', () => {
    // The heart of the memo: "* " is refused for the space behind the closer
    // it would need, which says nothing about the rest of the line, so the
    // real pair after it still reads as emphasis.
    assert.deepStrictEqual(parseMarkdown('a * b *c* d')[0].spans, [
      { type: 'text', text: 'a * b ' },
      { type: 'em', text: 'c' },
      { type: 'text', text: ' d' },
    ]);
  });

  it('keeps strong after an emphasis opener that never closes', () => {
    // The two widths are remembered apart: a line with no single closer left
    // can still hold a double one.
    assert.deepStrictEqual(parseMarkdown('a *b c **d** e')[0].spans, [
      { type: 'text', text: 'a *b c ' },
      { type: 'strong', text: 'd' },
      { type: 'text', text: ' e' },
    ]);
  });

  it('keeps a one backtick span after a two backtick run that never closes', () => {
    assert.deepStrictEqual(parseMarkdown('`` a `b` c')[0].spans, [
      { type: 'text', text: '`' },
      { type: 'code', text: 'a' },
      { type: 'text', text: 'b` c' },
    ]);
  });

  it('keeps a link after a bracket pair that opened no link', () => {
    assert.deepStrictEqual(parseMarkdown('[a] and [b](https://x.dev/p)')[0].spans, [
      { type: 'text', text: '[a] and ' },
      { type: 'link', text: 'b', href: 'https://x.dev/p' },
    ]);
  });
});

/* The reply a streaming renderer is given one delta at a time. It carries the
   awkward parts on purpose: a blank line inside a fenced block, a list, and a
   last line that is still being written. */
const REPLY = [
  '# Title',
  '',
  'A paragraph with **strong** and a [link](https://x.dev/a).',
  '',
  '```js',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '- one',
  '- two',
  '',
  '> quote',
  '',
  'trailing *em* text',
].join('\n');

describe('settledLength (what a streaming renderer may keep)', () => {
  it('settles nothing it has not been given', () => {
    assert.equal(settledLength(''), 0);
    assert.equal(settledLength(null), 0);
    assert.equal(settledLength(42), 0);
  });

  it('settles nothing until a blank line has arrived', () => {
    assert.equal(settledLength('# a'), 0);
    assert.equal(settledLength('# a\n'), 0);
    assert.equal(settledLength('# a\n\n'), 5);
  });

  it('does not settle at a blank line inside a fenced block', () => {
    // An unclosed fence swallows the blank line, so splitting there would turn
    // one code block into a code block and a paragraph.
    assert.equal(settledLength('```\n\n```\n\nx'), 10);
    assert.equal(settledLength('```\n\nstill code\n'), 0);
  });

  it('splits every prefix of a reply without changing what it parses to', () => {
    let deepest = 0;
    for (let n = 0; n <= REPLY.length; n += 1) {
      const prefix = REPLY.slice(0, n);
      const at = settledLength(prefix);
      assert.ok(at <= prefix.length, `settled past the end at ${n}`);
      // Monotone, which is what lets the renderer extend the parse it holds
      // rather than redo it.
      assert.ok(at >= deepest, `settled went backwards at ${n}`);
      deepest = at;
      assert.deepStrictEqual(
        parseMarkdown(prefix.slice(0, at)).concat(parseMarkdown(prefix.slice(at))),
        parseMarkdown(prefix),
        `split at ${at} changed the parse of the first ${n} characters`,
      );
    }
    assert.ok(deepest > 0, 'nothing settled in a reply full of blank lines');
  });
});
