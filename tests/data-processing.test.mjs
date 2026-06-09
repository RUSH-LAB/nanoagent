import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('study plan scheduling', () => {
  function scheduleItems(items, minutesPerWeek) {
    const weeks = [];
    let current = {week: 1, items: [], totalMinutes: 0};
    for (const item of items) {
      if (current.totalMinutes + item.readingTimeMin > minutesPerWeek && current.items.length > 0) {
        weeks.push(current);
        current = {week: weeks.length + 1, items: [], totalMinutes: 0};
      }
      current.items.push(item);
      current.totalMinutes += item.readingTimeMin;
    }
    if (current.items.length > 0) weeks.push(current);
    return weeks;
  }

  it('creates single week for small content', () => {
    const items = [{readingTimeMin: 30}, {readingTimeMin: 20}];
    const weeks = scheduleItems(items, 600);
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].items.length, 2);
  });

  it('splits across weeks when exceeding limit', () => {
    const items = [{readingTimeMin: 400}, {readingTimeMin: 300}, {readingTimeMin: 200}];
    const weeks = scheduleItems(items, 600);
    assert.ok(weeks.length >= 2);
  });

  it('handles empty items', () => {
    assert.equal(scheduleItems([], 600).length, 0);
  });

  it('handles single item larger than week', () => {
    const weeks = scheduleItems([{readingTimeMin: 1000}], 600);
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].items.length, 1);
  });
});

describe('glossary term deduplication', () => {
  function isDuplicate(terms, newTerm) {
    return terms.some(t => t.term.toLowerCase() === newTerm.toLowerCase());
  }

  it('detects exact duplicate', () => {
    assert.ok(isDuplicate([{term: 'Transformer'}], 'Transformer'));
  });

  it('detects case-insensitive duplicate', () => {
    assert.ok(isDuplicate([{term: 'transformer'}], 'TRANSFORMER'));
  });

  it('allows unique term', () => {
    assert.ok(!isDuplicate([{term: 'Transformer'}], 'Attention'));
  });

  it('handles empty terms list', () => {
    assert.ok(!isDuplicate([], 'New Term'));
  });
});

describe('paper comparison logic', () => {
  function compareAuthors(authors1, authors2) {
    const set1 = new Set(authors1.map(a => a.toLowerCase()));
    const set2 = new Set(authors2.map(a => a.toLowerCase()));
    return [...set1].filter(a => set2.has(a));
  }

  it('finds shared authors', () => {
    const shared = compareAuthors(['Alice Smith', 'Bob Jones'], ['Bob Jones', 'Carol Davis']);
    assert.equal(shared.length, 1);
    assert.equal(shared[0], 'bob jones');
  });

  it('returns empty for no overlap', () => {
    assert.equal(compareAuthors(['Alice'], ['Bob']).length, 0);
  });

  it('handles case differences', () => {
    assert.equal(compareAuthors(['alice smith'], ['Alice Smith']).length, 1);
  });
});

describe('link suggestion matching', () => {
  function shouldSuggestLink(pageName, contentWords) {
    return contentWords.has(pageName) || pageName.split('-').some(w => w.length > 4 && contentWords.has(w));
  }

  it('matches exact page name in content', () => {
    const words = new Set(['transformer', 'attention', 'model']);
    assert.ok(shouldSuggestLink('transformer', words));
  });

  it('matches hyphenated part', () => {
    const words = new Set(['transformer', 'attention', 'model']);
    assert.ok(shouldSuggestLink('attention-mechanism', words));
  });

  it('does not match when only short segments overlap', () => {
    const words = new Set(['the', 'a', 'is']);
    assert.ok(!shouldSuggestLink('the-a-is', words));
  });

  it('does not match unrelated', () => {
    const words = new Set(['transformer']);
    assert.ok(!shouldSuggestLink('convolution', words));
  });
});

describe('summary extraction', () => {
  function extractSummary(content) {
    let body = content;
    const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fmMatch) body = body.slice(fmMatch[0].length);
    body = body.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
    const paragraphs = body.split(/\n\n+/).map(p => p.replace(/^#+\s*/gm, '').trim()).filter(p => p.length > 20);
    return paragraphs.slice(0, 2).join(' ').slice(0, 300);
  }

  it('extracts first paragraph', () => {
    const summary = extractSummary('---\ntitle: Test\n---\n\nThis is a long paragraph that should be extracted as the summary of this document.');
    assert.ok(summary.includes('long paragraph'));
  });

  it('strips frontmatter', () => {
    const summary = extractSummary('---\ntitle: Hidden\n---\n\nVisible paragraph is the only one here.');
    assert.ok(!summary.includes('Hidden'));
    assert.ok(summary.includes('Visible'));
  });

  it('strips code blocks', () => {
    const summary = extractSummary('```\ncode here\n```\n\nActual content paragraph that is long enough to pass.');
    assert.ok(!summary.includes('code here'));
  });

  it('limits length to 300', () => {
    const long = 'x'.repeat(500);
    const summary = extractSummary(`This is the paragraph. ${long}`);
    assert.ok(summary.length <= 300);
  });

  it('handles empty content', () => {
    assert.equal(extractSummary(''), '');
  });
});

describe('topic clustering', () => {
  function groupByTags(pages) {
    const tagGroups = {};
    for (const page of pages) {
      for (const tag of page.tags) {
        if (!tagGroups[tag]) tagGroups[tag] = [];
        tagGroups[tag].push(page);
      }
    }
    return Object.entries(tagGroups)
      .filter(([, pages]) => pages.length >= 2)
      .sort((a, b) => b[1].length - a[1].length);
  }

  it('groups pages by shared tags', () => {
    const pages = [
      {title: 'A', tags: ['ml', 'nlp']},
      {title: 'B', tags: ['ml']},
      {title: 'C', tags: ['cv']},
    ];
    const groups = groupByTags(pages);
    assert.equal(groups.length, 1);
    assert.equal(groups[0][0], 'ml');
    assert.equal(groups[0][1].length, 2);
  });

  it('returns empty for no shared tags', () => {
    const pages = [{title: 'A', tags: ['a']}, {title: 'B', tags: ['b']}];
    assert.equal(groupByTags(pages).length, 0);
  });

  it('handles pages with no tags', () => {
    assert.equal(groupByTags([{title: 'A', tags: []}]).length, 0);
  });
});
