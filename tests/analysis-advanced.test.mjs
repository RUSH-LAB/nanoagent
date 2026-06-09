import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('vocabulary richness', () => {
  function richness(words) {
    if (words.length === 0) return 0;
    return Math.round((new Set(words.map(w => w.toLowerCase())).size / words.length) * 100) / 100;
  }

  it('is 1 for all unique words', () => {
    assert.equal(richness(['a', 'b', 'c', 'd']), 1);
  });

  it('is 0.5 for half unique', () => {
    assert.equal(richness(['a', 'a', 'b', 'b']), 0.5);
  });

  it('is 0 for empty', () => {
    assert.equal(richness([]), 0);
  });

  it('is case insensitive', () => {
    assert.equal(richness(['Hello', 'hello']), 0.5);
  });
});

describe('reference completeness scoring', () => {
  const FIELDS = ['title', 'author', 'year', 'venue', 'doi', 'url'];

  function completeness(entry) {
    const present = FIELDS.filter(f => entry[f] && (!Array.isArray(entry[f]) || entry[f].length > 0));
    return Math.round((present.length / FIELDS.length) * 100);
  }

  it('scores 100% for fully complete', () => {
    assert.equal(completeness({title: 'T', author: ['A'], year: 2024, venue: 'V', doi: '10.1234', url: 'http://x'}), 100);
  });

  it('scores lower for missing fields', () => {
    assert.ok(completeness({title: 'T', author: ['A'], year: 2024}) < 100);
  });

  it('handles empty author array', () => {
    assert.ok(completeness({title: 'T', author: [], year: 2024}) < completeness({title: 'T', author: ['A'], year: 2024}));
  });

  it('scores 0 for empty entry', () => {
    assert.equal(completeness({}), 0);
  });
});

describe('trending paper filtering', () => {
  function filterTrending(papers, currentYear, citeCounts) {
    return papers
      .filter(([key, entry]) => entry.year >= currentYear - 2 && (citeCounts[key] || 0) > 0)
      .map(([key, entry]) => ({key, title: entry.title, year: entry.year, citations: citeCounts[key]}))
      .sort((a, b) => b.citations - a.citations);
  }

  it('includes recent cited papers', () => {
    const papers = [['a', {title: 'A', year: 2024}]];
    const result = filterTrending(papers, 2025, {a: 5});
    assert.equal(result.length, 1);
  });

  it('excludes old papers', () => {
    const papers = [['a', {title: 'A', year: 2020}]];
    assert.equal(filterTrending(papers, 2025, {a: 5}).length, 0);
  });

  it('excludes uncited papers', () => {
    const papers = [['a', {title: 'A', year: 2024}]];
    assert.equal(filterTrending(papers, 2025, {}).length, 0);
  });

  it('sorts by citation count', () => {
    const papers = [['a', {title: 'A', year: 2024}], ['b', {title: 'B', year: 2024}]];
    const result = filterTrending(papers, 2025, {a: 3, b: 10});
    assert.equal(result[0].key, 'b');
  });
});

describe('content similarity scoring', () => {
  function similarity(sourceTopWords, targetWords) {
    const targetSet = new Set(targetWords);
    let overlap = 0;
    for (const w of sourceTopWords) { if (targetSet.has(w)) overlap++; }
    return sourceTopWords.size > 0 ? Math.round((overlap / sourceTopWords.size) * 100) / 100 : 0;
  }

  it('returns 1 for identical word sets', () => {
    const words = new Set(['transformer', 'attention', 'model']);
    assert.equal(similarity(words, ['transformer', 'attention', 'model']), 1);
  });

  it('returns 0 for disjoint sets', () => {
    assert.equal(similarity(new Set(['a', 'b']), ['c', 'd']), 0);
  });

  it('returns partial for overlap', () => {
    const result = similarity(new Set(['a', 'b', 'c', 'd']), ['a', 'b', 'e', 'f']);
    assert.equal(result, 0.5);
  });
});

describe('engagement score weighting', () => {
  function engagement(views, comments, bookmarks, readingLists) {
    return views * 1 + comments * 5 + bookmarks * 10 + readingLists * 3;
  }

  it('views have lowest weight', () => {
    assert.ok(engagement(10, 0, 0, 0) <= engagement(0, 0, 1, 0));
  });

  it('bookmarks have highest weight', () => {
    assert.ok(engagement(0, 0, 1, 0) > engagement(0, 1, 0, 0));
  });

  it('handles all zeros', () => {
    assert.equal(engagement(0, 0, 0, 0), 0);
  });
});

describe('week-over-week growth', () => {
  function growth(thisWeek, lastWeek) {
    if (lastWeek === 0) return thisWeek > 0 ? 100 : 0;
    return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  }

  it('calculates positive growth', () => {
    assert.equal(growth(15, 10), 50);
  });

  it('calculates negative growth', () => {
    assert.equal(growth(5, 10), -50);
  });

  it('handles zero last week', () => {
    assert.equal(growth(10, 0), 100);
  });

  it('handles both zero', () => {
    assert.equal(growth(0, 0), 0);
  });

  it('handles no change', () => {
    assert.equal(growth(10, 10), 0);
  });
});
