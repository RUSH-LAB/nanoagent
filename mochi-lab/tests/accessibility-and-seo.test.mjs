import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('accessibility checks', () => {
  function checkAccessibility(content) {
    const issues = [];
    const lines = content.split('\n');
    let lastLevel = 0;
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('```')) { inCode = !inCode; continue; }
      if (inCode) continue;
      if (/!\[\]\(/.test(line)) issues.push({line: i+1, type: 'warning', message: 'Image without alt text'});
      const hm = line.match(/^(#{1,6})\s+/);
      if (hm) {
        const level = hm[1].length;
        if (lastLevel > 0 && level > lastLevel + 1) {
          issues.push({line: i+1, type: 'info', message: `Heading skip: h${lastLevel} to h${level}`});
        }
        lastLevel = level;
      }
    }
    return issues;
  }

  it('detects image without alt text', () => {
    const issues = checkAccessibility('![](image.png)');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].type, 'warning');
  });

  it('passes image with alt text', () => {
    const issues = checkAccessibility('![Alt text](image.png)');
    assert.equal(issues.length, 0);
  });

  it('detects heading level skip', () => {
    const issues = checkAccessibility('# H1\n### H3');
    assert.equal(issues.length, 1);
    assert.ok(issues[0].message.includes('skip'));
  });

  it('allows sequential headings', () => {
    const issues = checkAccessibility('# H1\n## H2\n### H3');
    assert.equal(issues.length, 0);
  });

  it('skips code blocks', () => {
    const issues = checkAccessibility('```\n# In code\n![](x)\n```');
    assert.equal(issues.length, 0);
  });
});

describe('JSON-LD generation', () => {
  function generateJsonLD(title, date, wordCount, tags, authors) {
    return {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: title,
      datePublished: date,
      wordCount,
      ...(tags.length > 0 && {keywords: tags.join(', ')}),
      ...(authors.length > 0 && {author: authors.map(a => ({'@type': 'Person', name: a}))}),
    };
  }

  it('generates valid structure', () => {
    const ld = generateJsonLD('Test', '2025-01-01', 500, ['ml'], ['Author']);
    assert.equal(ld['@context'], 'https://schema.org');
    assert.equal(ld['@type'], 'Article');
    assert.equal(ld.headline, 'Test');
  });

  it('includes keywords when tags exist', () => {
    const ld = generateJsonLD('T', '2025', 100, ['a', 'b'], []);
    assert.equal(ld.keywords, 'a, b');
  });

  it('omits keywords when no tags', () => {
    const ld = generateJsonLD('T', '2025', 100, [], []);
    assert.equal(ld.keywords, undefined);
  });

  it('includes authors when present', () => {
    const ld = generateJsonLD('T', '2025', 100, [], ['Alice', 'Bob']);
    assert.equal(ld.author.length, 2);
    assert.equal(ld.author[0].name, 'Alice');
  });
});

describe('sitemap URL generation', () => {
  function toSitemapUrl(relPath) {
    let url = '/' + relPath.replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
    if (url.endsWith('/index')) url = url.slice(0, -6);
    return url;
  }

  it('converts file path to URL', () => {
    assert.equal(toSitemapUrl('docs/intro.md'), '/docs/intro');
  });

  it('handles index files', () => {
    assert.equal(toSitemapUrl('docs/index.md'), '/docs');
  });

  it('strips .mdx extension', () => {
    assert.equal(toSitemapUrl('page.mdx'), '/page');
  });

  it('handles nested paths', () => {
    assert.equal(toSitemapUrl('books/math/calculus/intro.md'), '/books/math/calculus/intro');
  });
});

describe('engagement score calculation', () => {
  function calculateEngagement(views, comments, bookmarks, readingLists) {
    return views * 1 + comments * 5 + bookmarks * 10 + readingLists * 3;
  }

  it('weights views at 1x', () => {
    assert.equal(calculateEngagement(10, 0, 0, 0), 10);
  });

  it('weights comments at 5x', () => {
    assert.equal(calculateEngagement(0, 3, 0, 0), 15);
  });

  it('weights bookmarks at 10x', () => {
    assert.equal(calculateEngagement(0, 0, 2, 0), 20);
  });

  it('combines all signals', () => {
    assert.equal(calculateEngagement(10, 2, 1, 3), 10 + 10 + 10 + 9);
  });

  it('handles zero engagement', () => {
    assert.equal(calculateEngagement(0, 0, 0, 0), 0);
  });
});

describe('date range filtering', () => {
  function isInRange(dateStr, from, to) {
    const d = new Date(dateStr);
    return d >= new Date(from) && d <= new Date(to);
  }

  it('includes dates within range', () => {
    assert.ok(isInRange('2025-06-15', '2025-06-01', '2025-06-30'));
  });

  it('includes boundary dates', () => {
    assert.ok(isInRange('2025-06-01', '2025-06-01', '2025-06-30'));
  });

  it('excludes dates before range', () => {
    assert.ok(!isInRange('2025-05-31', '2025-06-01', '2025-06-30'));
  });

  it('excludes dates after range', () => {
    assert.ok(!isInRange('2025-07-01', '2025-06-01', '2025-06-30'));
  });
});
