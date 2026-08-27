import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('quality score calculation', () => {
  function calculateQualityScore(content) {
    let score = 0;
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      if (/^title:/m.test(fm)) score += 5;
      if (/^date:/m.test(fm)) score += 3;
      if (/^tags:/m.test(fm)) score += 3;
    }
    score += Math.min(20, Math.round(content.split(/\s+/).filter(Boolean).length / 50));
    score += Math.min(15, (content.match(/^#{1,6}\s+.+$/gm) || []).length * 3);
    score += Math.min(15, (content.match(/\[@[\w-]+/g) || []).length * 3);
    score += Math.min(10, ((content.match(/\[\[/g) || []).length + (content.match(/\]\(/g) || []).length) * 2);
    return Math.min(100, score);
  }

  it('scores minimal content low', () => {
    assert.ok(calculateQualityScore('Hello') < 20);
  });

  it('gives points for frontmatter title', () => {
    const withTitle = calculateQualityScore('---\ntitle: Test\n---\nContent');
    const without = calculateQualityScore('Content');
    assert.ok(withTitle > without);
  });

  it('gives points for headings', () => {
    const with2Headings = calculateQualityScore('# H1\n## H2\nContent text here to add words');
    const without = calculateQualityScore('Content text here to add words');
    assert.ok(with2Headings > without);
  });

  it('gives points for citations', () => {
    const withCite = calculateQualityScore('See [@smith2024] and [@jones2023]');
    const without = calculateQualityScore('See the paper and another');
    assert.ok(withCite > without);
  });

  it('caps at 100', () => {
    const maxContent = '---\ntitle: T\ndate: 2025-01-01\ntags: [a]\ndescription: d\n---\n' +
      '# H1\n## H2\n## H3\n## H4\n## H5\n' +
      '[@a] [@b] [@c] [@d] [@e]\n' +
      '[[p1]] [[p2]] [[p3]] [[p4]] [[p5]]\n' +
      'word '.repeat(2000);
    assert.ok(calculateQualityScore(maxContent) <= 100);
  });

  it('gives points for word count', () => {
    const short = calculateQualityScore('Few words');
    const long = calculateQualityScore('word '.repeat(500));
    assert.ok(long > short);
  });
});

describe('knowledge gap detection', () => {
  function detectGaps(refTopics, contentTopics) {
    const gaps = [];
    for (const [topic, refCount] of Object.entries(refTopics)) {
      if (refCount >= 5) {
        const contentCount = contentTopics[topic] || 0;
        const ratio = contentCount / refCount;
        if (ratio < 2) {
          gaps.push({topic, refCount, contentCount, gap: Math.round((1 - ratio / 2) * 100)});
        }
      }
    }
    return gaps.sort((a, b) => b.gap - a.gap);
  }

  it('identifies topic with no content coverage', () => {
    const gaps = detectGaps({transformer: 10}, {});
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].gap, 100);
  });

  it('identifies topic with low content coverage', () => {
    const gaps = detectGaps({attention: 10}, {attention: 5});
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0].gap > 0);
  });

  it('skips topics with fewer than 5 references', () => {
    const gaps = detectGaps({rare: 3}, {});
    assert.equal(gaps.length, 0);
  });

  it('skips well-covered topics', () => {
    const gaps = detectGaps({covered: 5}, {covered: 100});
    assert.equal(gaps.length, 0);
  });

  it('sorts by gap percentage', () => {
    const gaps = detectGaps(
      {topicA: 10, topicB: 10},
      {topicA: 5, topicB: 0},
    );
    assert.ok(gaps[0].gap > gaps[1].gap);
    assert.equal(gaps[0].topic, 'topicB');
  });
});

describe('quality level classification', () => {
  function classify(score) {
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'adequate';
    if (score >= 20) return 'needs-improvement';
    return 'minimal';
  }

  it('classifies scores correctly', () => {
    assert.equal(classify(90), 'excellent');
    assert.equal(classify(80), 'excellent');
    assert.equal(classify(70), 'good');
    assert.equal(classify(50), 'adequate');
    assert.equal(classify(30), 'needs-improvement');
    assert.equal(classify(10), 'minimal');
    assert.equal(classify(0), 'minimal');
  });
});

describe('author recommendation scoring', () => {
  function scoreRecommendation(paperAuthors, coauthors, paperVenue, preferredVenues) {
    let score = 0;
    for (const a of paperAuthors) {
      if (coauthors.has(a.toLowerCase())) score += 2;
    }
    if (preferredVenues.has(paperVenue)) score += 1;
    return score;
  }

  it('scores papers by known coauthors', () => {
    const coauthors = new Set(['alice', 'bob']);
    assert.equal(scoreRecommendation(['Alice', 'Carol'], coauthors, '', new Set()), 2);
  });

  it('scores papers by preferred venue', () => {
    const venues = new Set(['NeurIPS']);
    assert.equal(scoreRecommendation([], new Set(), 'NeurIPS', venues), 1);
  });

  it('combines coauthor and venue scores', () => {
    const coauthors = new Set(['alice']);
    const venues = new Set(['ICML']);
    assert.equal(scoreRecommendation(['Alice'], coauthors, 'ICML', venues), 3);
  });

  it('returns 0 for no matches', () => {
    assert.equal(scoreRecommendation(['Unknown'], new Set(), 'Workshop', new Set()), 0);
  });
});
