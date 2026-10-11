import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown } from '../../../../../src/utils/markdown.js';

/** The spans of a document that is one paragraph long. */
function spansOf(source) {
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1, `expected one block from ${JSON.stringify(source)}`);
  return blocks[0].spans;
}

/** Every href the parser was willing to keep. */
function hrefsOf(source) {
  return spansOf(source).filter((s) => s.type === 'link').map((s) => s.href);
}

// Links are the whole sanitizer story of this renderer: a span only becomes an
// anchor when its href is http, https, mailto or a path inside this site, and
// anything else is emitted as the literal source text. These cases are the
// contract the renderer trusts, so each rejection is pinned by hand.
describe('parseMarkdown (links and the href allowlist)', () => {
  it('keeps an http, https and mailto link', () => {
    assert.deepStrictEqual(hrefsOf('[a](http://x.dev) [b](https://x.dev) [c](mailto:me@x.dev)'), [
      'http://x.dev',
      'https://x.dev',
      'mailto:me@x.dev',
    ]);
  });

  it('keeps a site relative path', () => {
    assert.deepStrictEqual(spansOf('[about](/about)'), [
      { type: 'link', text: 'about', href: '/about' },
    ]);
  });

  it('refuses a javascript href and keeps the source text instead', () => {
    assert.deepStrictEqual(spansOf('[click](javascript:alert(1))'), [
      { type: 'text', text: '[click](javascript:alert(1))' },
    ]);
  });

  it('refuses a data href', () => {
    assert.deepStrictEqual(spansOf('[x](data:text/html,<script>)'), [
      { type: 'text', text: '[x](data:text/html,<script>)' },
    ]);
  });

  it('refuses a protocol relative href, which is an off site link in disguise', () => {
    assert.deepStrictEqual(spansOf('[x](//evil.dev)'), [{ type: 'text', text: '[x](//evil.dev)' }]);
  });

  it('refuses a backslash path, which some browsers read as a protocol relative one', () => {
    assert.deepStrictEqual(spansOf('[x](/\\evil.dev)'), [{ type: 'text', text: '[x](/\\evil.dev)' }]);
  });

  it('refuses a relative path, which has no meaning from a window docked to any page', () => {
    assert.deepStrictEqual(spansOf('[x](about.html)'), [{ type: 'text', text: '[x](about.html)' }]);
  });

  it('refuses a bare scheme with nothing after it', () => {
    assert.deepStrictEqual(spansOf('[x](https://)'), [{ type: 'text', text: '[x](https://)' }]);
  });

  it('accepts an upper case scheme', () => {
    assert.deepStrictEqual(hrefsOf('[x](HTTPS://X.dev)'), ['HTTPS://X.dev']);
  });

  it('reads a bare url as a link, its own text', () => {
    assert.deepStrictEqual(spansOf('see https://x.dev/a now'), [
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'https://x.dev/a', href: 'https://x.dev/a' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('gives back the punctuation that ended the sentence', () => {
    assert.deepStrictEqual(spansOf('at https://x.dev.'), [
      { type: 'text', text: 'at ' },
      { type: 'link', text: 'https://x.dev', href: 'https://x.dev' },
      { type: 'text', text: '.' },
    ]);
  });

  it('keeps a closing bracket the url opened itself', () => {
    assert.deepStrictEqual(hrefsOf('https://x.dev/Foo_(bar)'), ['https://x.dev/Foo_(bar)']);
  });

  it('does not read an address out of the middle of a word', () => {
    assert.deepStrictEqual(spansOf('xhttps://x.dev'), [{ type: 'text', text: 'xhttps://x.dev' }]);
  });

  it('reads an angle autolink', () => {
    assert.deepStrictEqual(spansOf('<https://x.dev>'), [
      { type: 'link', text: 'https://x.dev', href: 'https://x.dev' },
    ]);
  });

  it('leaves other angle brackets as text, because there is no html here', () => {
    assert.deepStrictEqual(spansOf('<img src=x onerror=y> and <b>bold</b>'), [
      { type: 'text', text: '<img src=x onerror=y> and <b>bold</b>' },
    ]);
  });

  it('does not read a link label as markdown, so the label stays one string', () => {
    assert.deepStrictEqual(spansOf('[**a**](https://x.dev)'), [
      { type: 'link', text: '**a**', href: 'https://x.dev' },
    ]);
  });

  it('leaves an unclosed link literal', () => {
    assert.deepStrictEqual(spansOf('[a](https://x.dev'), [
      { type: 'text', text: '[a](' },
      { type: 'link', text: 'https://x.dev', href: 'https://x.dev' },
    ]);
  });

  it('lets a code span keep a url out of the link layer', () => {
    assert.deepStrictEqual(spansOf('`https://x.dev`'), [{ type: 'code', text: 'https://x.dev' }]);
  });
});
