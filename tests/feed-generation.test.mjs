import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('RSS feed XML generation', () => {
  function generateRSSItem(title, link, date) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<item>\n<title>${esc(title)}</title>\n<link>${link}</link>\n<pubDate>${new Date(date).toUTCString()}</pubDate>\n</item>`;
  }

  it('escapes special characters in title', () => {
    const xml = generateRSSItem('AT&T <Corp>', '/test', '2025-01-01');
    assert.ok(xml.includes('AT&amp;T &lt;Corp&gt;'));
    assert.ok(!xml.includes('<Corp>'));
  });

  it('formats date as UTC string', () => {
    const xml = generateRSSItem('Test', '/test', '2025-06-15T12:00:00Z');
    assert.ok(xml.includes('Sun, 15 Jun 2025'));
  });

  it('includes link element', () => {
    const xml = generateRSSItem('Title', '/docs/intro', '2025-01-01');
    assert.ok(xml.includes('<link>/docs/intro</link>'));
  });
});

describe('Atom feed XML generation', () => {
  function generateAtomEntry(title, href, updated, id) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<entry>\n<title>${esc(title)}</title>\n<link href="${href}"/>\n<updated>${updated}</updated>\n<id>${esc(id)}</id>\n</entry>`;
  }

  it('generates valid entry', () => {
    const xml = generateAtomEntry('Test', '/docs/intro', '2025-01-01T00:00:00Z', 'urn:test');
    assert.ok(xml.includes('<title>Test</title>'));
    assert.ok(xml.includes('href="/docs/intro"'));
    assert.ok(xml.includes('<updated>2025-01-01'));
  });

  it('escapes title', () => {
    const xml = generateAtomEntry('A & B', '/test', '2025-01-01T00:00:00Z', 'urn:test');
    assert.ok(xml.includes('A &amp; B'));
  });
});

describe('content path conversion', () => {
  function contentPathToURL(filePath) {
    return '/' + filePath.replace(/^content\//, '').replace(/\.(md|mdx)$/, '');
  }

  it('strips content/ prefix', () => {
    assert.equal(contentPathToURL('content/docs/intro.md'), '/docs/intro');
  });

  it('strips .md extension', () => {
    assert.equal(contentPathToURL('content/books/math/intro.md'), '/books/math/intro');
  });

  it('strips .mdx extension', () => {
    assert.equal(contentPathToURL('content/docs/page.mdx'), '/docs/page');
  });

  it('handles nested paths', () => {
    assert.equal(contentPathToURL('content/books/math/1-calculus/intro.md'), '/books/math/1-calculus/intro');
  });
});

describe('session duration calculation', () => {
  it('calculates duration in minutes', () => {
    const start = '2025-01-01T10:00:00Z';
    const end = '2025-01-01T11:30:00Z';
    const duration = Math.round((new Date(end) - new Date(start)) / 60000);
    assert.equal(duration, 90);
  });

  it('handles zero duration', () => {
    const start = '2025-01-01T10:00:00Z';
    const duration = Math.round((new Date(start) - new Date(start)) / 60000);
    assert.equal(duration, 0);
  });

  it('handles short sessions', () => {
    const start = '2025-01-01T10:00:00Z';
    const end = '2025-01-01T10:05:00Z';
    const duration = Math.round((new Date(end) - new Date(start)) / 60000);
    assert.equal(duration, 5);
  });
});
