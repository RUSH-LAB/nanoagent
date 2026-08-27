import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('writing style metrics', () => {
  function sentenceVariance(lengths) {
    if (lengths.length <= 1) return 0;
    const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length;
    return Math.round(Math.sqrt(lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length) * 10) / 10;
  }

  it('returns 0 for uniform sentences', () => {
    assert.equal(sentenceVariance([10, 10, 10]), 0);
  });

  it('returns positive for varied sentences', () => {
    assert.ok(sentenceVariance([5, 15, 25]) > 0);
  });

  it('returns 0 for single sentence', () => {
    assert.equal(sentenceVariance([10]), 0);
  });

  it('returns 0 for empty', () => {
    assert.equal(sentenceVariance([]), 0);
  });
});

describe('passive voice detection', () => {
  function countPassive(text) {
    return (text.match(/\b(is|are|was|were|been|being)\s+(being\s+)?\w+ed\b/gi) || []).length;
  }

  it('detects simple passive', () => {
    assert.equal(countPassive('The ball was kicked'), 1);
  });

  it('detects multiple passives', () => {
    assert.equal(countPassive('It was created. It was destroyed.'), 2);
  });

  it('returns 0 for active voice', () => {
    assert.equal(countPassive('She wrote the paper'), 0);
  });
});

describe('update suggestion priority', () => {
  function calculatePriority(words, hasFrontmatter, hasTitle, hasTags, headings) {
    let p = 0;
    if (words < 100) p += 3;
    if (!hasFrontmatter) p += 2;
    else if (!hasTitle) p += 2;
    if (!hasTags) p += 1;
    if (words > 500 && headings < 2) p += 2;
    return p;
  }

  it('high priority for short content without frontmatter', () => {
    assert.equal(calculatePriority(50, false, false, false, 0), 6);
  });

  it('low priority for well-structured content', () => {
    assert.equal(calculatePriority(500, true, true, true, 5), 0);
  });

  it('medium for long content with few headings', () => {
    assert.ok(calculatePriority(1000, true, true, true, 1) >= 2);
  });
});

describe('audience level classification', () => {
  function classifyAudience(grade) {
    if (grade <= 8) return 'beginner';
    if (grade <= 12) return 'intermediate';
    if (grade <= 16) return 'advanced';
    return 'expert';
  }

  it('classifies grade 6 as beginner', () => assert.equal(classifyAudience(6), 'beginner'));
  it('classifies grade 10 as intermediate', () => assert.equal(classifyAudience(10), 'intermediate'));
  it('classifies grade 14 as advanced', () => assert.equal(classifyAudience(14), 'advanced'));
  it('classifies grade 20 as expert', () => assert.equal(classifyAudience(20), 'expert'));
  it('classifies grade 8 boundary as beginner', () => assert.equal(classifyAudience(8), 'beginner'));
  it('classifies grade 12 boundary as intermediate', () => assert.equal(classifyAudience(12), 'intermediate'));
});

describe('word leaderboard sorting', () => {
  function rankByWords(pages) {
    return [...pages].sort((a, b) => b.wordCount - a.wordCount);
  }

  it('ranks longest first', () => {
    const ranked = rankByWords([{wordCount: 100}, {wordCount: 500}, {wordCount: 200}]);
    assert.equal(ranked[0].wordCount, 500);
    assert.equal(ranked[2].wordCount, 100);
  });

  it('handles ties', () => {
    const ranked = rankByWords([{wordCount: 100}, {wordCount: 100}]);
    assert.equal(ranked.length, 2);
  });
});
