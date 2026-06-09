import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('relevance scoring', () => {
  function score(titleMatch, headingMatches, bodyOccurrences) {
    let s = 0;
    if (titleMatch) s += 10;
    s += headingMatches * 5;
    s += Math.min(bodyOccurrences, 20);
    return s;
  }

  it('title match gives highest boost', () => {
    assert.ok(score(true, 0, 0) > score(false, 0, 5));
  });

  it('heading match gives medium boost', () => {
    assert.equal(score(false, 2, 0), 10);
  });

  it('body occurrences capped at 20', () => {
    assert.equal(score(false, 0, 100), 20);
  });

  it('combines all signals', () => {
    assert.equal(score(true, 1, 3), 10 + 5 + 3);
  });

  it('zero for no matches', () => {
    assert.equal(score(false, 0, 0), 0);
  });
});

describe('autofill field suggestion', () => {
  function findSuggestions(targetAuthors, allEntries, field) {
    const suggestions = [];
    for (const [key, entry] of allEntries) {
      if (!entry[field]) continue;
      const entryAuthors = entry.author || [];
      if (targetAuthors.some(a => entryAuthors.some(ea => ea.toLowerCase() === a.toLowerCase()))) {
        suggestions.push({value: entry[field], source: key});
        if (suggestions.length >= 3) break;
      }
    }
    return suggestions;
  }

  it('suggests from co-author papers', () => {
    const entries = [['other', {author: ['Alice'], venue: 'NeurIPS'}]];
    const result = findSuggestions(['Alice'], entries, 'venue');
    assert.equal(result.length, 1);
    assert.equal(result[0].value, 'NeurIPS');
  });

  it('returns empty for no matching authors', () => {
    const entries = [['other', {author: ['Bob'], venue: 'ICML'}]];
    assert.equal(findSuggestions(['Alice'], entries, 'venue').length, 0);
  });

  it('limits to 3 suggestions', () => {
    const entries = [
      ['a', {author: ['X'], venue: 'A'}],
      ['b', {author: ['X'], venue: 'B'}],
      ['c', {author: ['X'], venue: 'C'}],
      ['d', {author: ['X'], venue: 'D'}],
    ];
    assert.equal(findSuggestions(['X'], entries, 'venue').length, 3);
  });

  it('skips entries without the field', () => {
    const entries = [['a', {author: ['X']}]];
    assert.equal(findSuggestions(['X'], entries, 'venue').length, 0);
  });
});

describe('search snippet extraction', () => {
  function extractSnippet(content, query, contextLen) {
    const lower = content.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx === -1) return '';
    const start = Math.max(0, idx - contextLen);
    const end = Math.min(content.length, idx + query.length + contextLen);
    return (start > 0 ? '...' : '') + content.slice(start, end).replace(/\n/g, ' ').trim() + (end < content.length ? '...' : '');
  }

  it('extracts context around match', () => {
    const snippet = extractSnippet('Before MATCH after', 'match', 5);
    assert.ok(snippet.includes('MATCH'));
  });

  it('adds ellipsis for truncation', () => {
    const snippet = extractSnippet('x'.repeat(100) + 'MATCH' + 'y'.repeat(100), 'match', 10);
    assert.ok(snippet.startsWith('...'));
    assert.ok(snippet.endsWith('...'));
  });

  it('returns empty for no match', () => {
    assert.equal(extractSnippet('no match here', 'xyz', 10), '');
  });
});

describe('topic clustering by primary keyword', () => {
  function clusterByPrimary(pages) {
    const groups = {};
    for (const page of pages) {
      const primary = page.topWords[0];
      if (!groups[primary]) groups[primary] = [];
      groups[primary].push(page);
    }
    return Object.entries(groups).filter(([, p]) => p.length >= 2).sort((a, b) => b[1].length - a[1].length);
  }

  it('groups pages by primary keyword', () => {
    const pages = [
      {title: 'A', topWords: ['model', 'train']},
      {title: 'B', topWords: ['model', 'eval']},
      {title: 'C', topWords: ['data', 'clean']},
    ];
    const clusters = clusterByPrimary(pages);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0][0], 'model');
  });

  it('filters singleton clusters', () => {
    const pages = [{title: 'A', topWords: ['unique']}];
    assert.equal(clusterByPrimary(pages).length, 0);
  });
});
