import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('wiki link extraction', () => {
  const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  function extractWikiLinks(content) {
    const links = [];
    let m;
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(content)) !== null) {
      links.push(m[1].trim());
    }
    return links;
  }

  it('extracts simple wiki link', () => {
    assert.deepEqual(extractWikiLinks('See [[page]]'), ['page']);
  });

  it('extracts wiki link with alias', () => {
    assert.deepEqual(extractWikiLinks('See [[page|Display]]'), ['page']);
  });

  it('extracts multiple wiki links', () => {
    assert.deepEqual(extractWikiLinks('[[a]] and [[b]]'), ['a', 'b']);
  });

  it('extracts path-based wiki link', () => {
    assert.deepEqual(extractWikiLinks('[[math/intro]]'), ['math/intro']);
  });

  it('returns empty for no links', () => {
    assert.deepEqual(extractWikiLinks('No links here'), []);
  });
});

describe('citation key extraction', () => {
  const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;

  function extractCitations(content) {
    const keys = [];
    let m;
    CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(content)) !== null) {
      const parts = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
      keys.push(...parts);
    }
    return keys;
  }

  it('extracts single citation', () => {
    assert.deepEqual(extractCitations('See [@smith2024]'), ['smith2024']);
  });

  it('extracts multiple citations in one bracket', () => {
    assert.deepEqual(extractCitations('[@a; @b; @c]'), ['a', 'b', 'c']);
  });

  it('extracts citations from different locations', () => {
    assert.deepEqual(extractCitations('[@a] text [@b]'), ['a', 'b']);
  });

  it('returns empty for no citations', () => {
    assert.deepEqual(extractCitations('No citations'), []);
  });

  it('handles hyphenated keys', () => {
    assert.deepEqual(extractCitations('[@vaswani-2017]'), ['vaswani-2017']);
  });
});

describe('markdown link extraction', () => {
  const MD_LINK_RE = /\[([^\]]*)\]\(\/([^)#?]+)\)/g;

  function extractMarkdownLinks(content) {
    const links = [];
    let m;
    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(content)) !== null) {
      links.push({text: m[1], target: m[2].trim()});
    }
    return links;
  }

  it('extracts internal link', () => {
    const links = extractMarkdownLinks('[Click](/docs/intro)');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'docs/intro');
  });

  it('skips external links', () => {
    const links = extractMarkdownLinks('[Click](https://example.com)');
    assert.equal(links.length, 0);
  });

  it('extracts multiple links', () => {
    const links = extractMarkdownLinks('[A](/a) and [B](/b)');
    assert.equal(links.length, 2);
  });

  it('ignores anchor-only links', () => {
    const links = extractMarkdownLinks('[Jump](#section)');
    assert.equal(links.length, 0);
  });
});

describe('word frequency counting', () => {
  const STOP = new Set(['the', 'a', 'is', 'and', 'of', 'to', 'in', 'for', 'it']);

  function countFrequency(text) {
    const freq = {};
    const words = text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3 && !STOP.has(w));
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    return freq;
  }

  it('counts word frequencies', () => {
    const freq = countFrequency('hello world hello');
    assert.equal(freq.hello, 2);
    assert.equal(freq.world, 1);
  });

  it('filters short words', () => {
    const freq = countFrequency('a is the cat');
    assert.ok(!('cat' in freq)); // 'cat' is only 3 chars, filtered by length > 3
  });

  it('filters stop words', () => {
    const freq = countFrequency('this and that');
    assert.ok(!('and' in freq));
  });

  it('lowercases all words', () => {
    const freq = countFrequency('Machine Learning machine learning');
    assert.equal(freq.machine, 2);
    assert.equal(freq.learning, 2);
  });

  it('handles empty input', () => {
    const freq = countFrequency('');
    assert.deepEqual(freq, {});
  });
});

describe('search filtering', () => {
  function matchesQuery(searchable, query) {
    return searchable.toLowerCase().includes(query.toLowerCase());
  }

  it('matches exact string', () => {
    assert.ok(matchesQuery('Hello World', 'hello'));
  });

  it('matches case insensitive', () => {
    assert.ok(matchesQuery('ATTENTION', 'attention'));
  });

  it('does not match unrelated', () => {
    assert.ok(!matchesQuery('transformer', 'attention'));
  });

  it('matches partial word', () => {
    assert.ok(matchesQuery('transformers', 'transform'));
  });
});

describe('impact score calculation', () => {
  const TOP_VENUES = new Set(['NeurIPS', 'ICML', 'ICLR']);

  function calculateScore(citations, venue, year) {
    const venueBonus = TOP_VENUES.has(venue) ? 2 : 0;
    const recencyBonus = year >= 2022 ? 1 : year >= 2020 ? 0.5 : 0;
    return Math.round((citations * 3 + venueBonus + recencyBonus) * 10) / 10;
  }

  it('scores based on citations', () => {
    assert.equal(calculateScore(10, '', 2019), 30);
  });

  it('adds venue bonus', () => {
    assert.equal(calculateScore(0, 'NeurIPS', 2019), 2);
  });

  it('adds recency bonus for recent papers', () => {
    assert.equal(calculateScore(0, '', 2023), 1);
  });

  it('combines all bonuses', () => {
    assert.equal(calculateScore(5, 'ICML', 2024), 18);
  });

  it('no bonus for old papers at unknown venue', () => {
    assert.equal(calculateScore(3, 'Workshop', 2015), 9);
  });
});
