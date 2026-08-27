import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('APA citation formatting', () => {
  function formatAPA(authors, year, title, venue) {
    if (authors.length === 0) return `Unknown (${year}). ${title}. ${venue ? venue + '.' : ''}`;
    const formatted = authors.length === 1
      ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ')
      : authors.slice(0, -1).map(a => a.split(' ').pop() + ', ' + a.split(' ').slice(0, -1).map(n => n[0] + '.').join(' ')).join(', ') + ', & ' + authors[authors.length - 1].split(' ').pop() + ', ' + authors[authors.length - 1].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ');
    return `${formatted} (${year}). ${title}. ${venue ? venue + '.' : ''}`;
  }

  it('formats single author', () => {
    const result = formatAPA(['John Smith'], 2024, 'Test Paper', 'NeurIPS');
    assert.ok(result.includes('Smith, J.'));
    assert.ok(result.includes('(2024)'));
    assert.ok(result.includes('Test Paper'));
  });

  it('formats two authors with &', () => {
    const result = formatAPA(['Alice Johnson', 'Bob Williams'], 2023, 'Title', 'ICML');
    assert.ok(result.includes('& Williams'));
  });

  it('handles no authors', () => {
    const result = formatAPA([], 2024, 'Anonymous Paper', '');
    assert.ok(result.includes('Unknown'));
  });

  it('handles no venue', () => {
    const result = formatAPA(['Jane Doe'], 2024, 'Paper', '');
    assert.ok(!result.endsWith('..'));
  });

  it('includes year in parentheses', () => {
    const result = formatAPA(['Test Author'], 2025, 'Title', 'Venue');
    assert.ok(result.includes('(2025)'));
  });
});

describe('MLA citation formatting', () => {
  function formatMLA(authors, year, title, venue) {
    const authorStr = authors.length === 0 ? 'Unknown'
      : authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ')
      : authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') + ', et al.';
    return `${authorStr}. "${title}." ${venue ? venue + ', ' : ''}${year}.`;
  }

  it('formats single author with last name first', () => {
    const result = formatMLA(['John Smith'], 2024, 'Test', 'NeurIPS');
    assert.ok(result.startsWith('Smith, John'));
  });

  it('uses et al for multiple authors', () => {
    const result = formatMLA(['Alice Johnson', 'Bob Williams', 'Carol Davis'], 2023, 'Title', 'ICML');
    assert.ok(result.includes('et al.'));
  });

  it('puts title in quotes', () => {
    const result = formatMLA(['Author'], 2024, 'My Title', '');
    assert.ok(result.includes('"My Title."'));
  });

  it('ends with year and period', () => {
    const result = formatMLA(['Author'], 2024, 'Title', 'Venue');
    assert.ok(result.endsWith('2024.'));
  });
});

describe('content freshness classification', () => {
  function classify(ageDays) {
    if (ageDays <= 7) return 'fresh';
    if (ageDays <= 30) return 'recent';
    if (ageDays <= 90) return 'aging';
    return 'stale';
  }

  it('classifies today as fresh', () => assert.equal(classify(0), 'fresh'));
  it('classifies 5 days as fresh', () => assert.equal(classify(5), 'fresh'));
  it('classifies 7 days as fresh', () => assert.equal(classify(7), 'fresh'));
  it('classifies 8 days as recent', () => assert.equal(classify(8), 'recent'));
  it('classifies 30 days as recent', () => assert.equal(classify(30), 'recent'));
  it('classifies 31 days as aging', () => assert.equal(classify(31), 'aging'));
  it('classifies 90 days as aging', () => assert.equal(classify(90), 'aging'));
  it('classifies 91 days as stale', () => assert.equal(classify(91), 'stale'));
  it('classifies 365 days as stale', () => assert.equal(classify(365), 'stale'));
});

describe('co-author pair generation', () => {
  function generatePairs(authors) {
    const pairs = [];
    for (let i = 0; i < authors.length; i++) {
      for (let j = i + 1; j < authors.length; j++) {
        pairs.push([authors[i], authors[j]].sort().join('::'));
      }
    }
    return pairs;
  }

  it('generates 0 pairs for 1 author', () => {
    assert.equal(generatePairs(['Alice']).length, 0);
  });

  it('generates 1 pair for 2 authors', () => {
    const pairs = generatePairs(['Alice', 'Bob']);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0], 'Alice::Bob');
  });

  it('generates 3 pairs for 3 authors', () => {
    const pairs = generatePairs(['Alice', 'Bob', 'Carol']);
    assert.equal(pairs.length, 3);
  });

  it('generates 6 pairs for 4 authors', () => {
    assert.equal(generatePairs(['A', 'B', 'C', 'D']).length, 6);
  });

  it('sorts pairs alphabetically', () => {
    const pairs = generatePairs(['Zoe', 'Alice']);
    assert.equal(pairs[0], 'Alice::Zoe');
  });
});

describe('schedule status logic', () => {
  function getStatus(publishAt) {
    const now = new Date().toISOString();
    if (publishAt <= now) return 'due';
    return 'scheduled';
  }

  it('future date is scheduled', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    assert.equal(getStatus(future), 'scheduled');
  });

  it('past date is due', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    assert.equal(getStatus(past), 'due');
  });
});
