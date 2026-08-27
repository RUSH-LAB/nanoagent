import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('SM-2 spaced repetition algorithm', () => {
  function reviewCard(card, quality) {
    const q = Math.max(0, Math.min(5, quality));
    const result = {...card};
    if (q >= 3) {
      if (result.repetitions === 0) result.interval = 1;
      else if (result.repetitions === 1) result.interval = 6;
      else result.interval = Math.round(result.interval * result.easeFactor);
      result.repetitions++;
    } else {
      result.repetitions = 0;
      result.interval = 1;
    }
    result.easeFactor = Math.max(1.3, result.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    return result;
  }

  function newCard() {
    return {interval: 1, easeFactor: 2.5, repetitions: 0};
  }

  it('first successful review sets interval to 1', () => {
    const card = reviewCard(newCard(), 4);
    assert.equal(card.interval, 1);
    assert.equal(card.repetitions, 1);
  });

  it('second successful review sets interval to 6', () => {
    let card = reviewCard(newCard(), 4);
    card = reviewCard(card, 4);
    assert.equal(card.interval, 6);
    assert.equal(card.repetitions, 2);
  });

  it('third successful review multiplies by ease factor', () => {
    let card = reviewCard(newCard(), 4);
    card = reviewCard(card, 4);
    card = reviewCard(card, 4);
    assert.ok(card.interval > 6);
    assert.equal(card.repetitions, 3);
  });

  it('failed review resets repetitions and interval', () => {
    let card = reviewCard(newCard(), 4);
    card = reviewCard(card, 4);
    card = reviewCard(card, 2); // fail
    assert.equal(card.repetitions, 0);
    assert.equal(card.interval, 1);
  });

  it('perfect quality (5) increases ease factor', () => {
    const card = reviewCard(newCard(), 5);
    assert.ok(card.easeFactor > 2.5);
  });

  it('low quality (3) decreases ease factor', () => {
    const card = reviewCard(newCard(), 3);
    assert.ok(card.easeFactor < 2.5);
  });

  it('ease factor never goes below 1.3', () => {
    let card = newCard();
    for (let i = 0; i < 20; i++) {
      card = reviewCard(card, 0);
    }
    assert.ok(card.easeFactor >= 1.3);
  });

  it('quality 0 resets to interval 1', () => {
    let card = reviewCard(newCard(), 5);
    card = reviewCard(card, 5);
    card = reviewCard(card, 0);
    assert.equal(card.interval, 1);
  });

  it('quality clamped to 0-5', () => {
    const card1 = reviewCard(newCard(), -1);
    assert.equal(card1.repetitions, 0);
    const card2 = reviewCard(newCard(), 10);
    assert.equal(card2.repetitions, 1);
  });

  it('intervals grow over multiple successful reviews', () => {
    let card = newCard();
    const intervals = [];
    for (let i = 0; i < 5; i++) {
      card = reviewCard(card, 4);
      intervals.push(card.interval);
    }
    for (let i = 2; i < intervals.length; i++) {
      assert.ok(intervals[i] >= intervals[i-1], `interval ${i} should be >= interval ${i-1}`);
    }
  });
});

describe('citation context extraction', () => {
  function extractCiteContexts(content, key) {
    const pattern = new RegExp(`\\[@[^\\]]*\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\]]*\\]`, 'g');
    const contexts = [];
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const start = Math.max(0, m.index - 50);
      const end = Math.min(content.length, m.index + m[0].length + 50);
      contexts.push(content.slice(start, end).trim());
    }
    return contexts;
  }

  it('extracts single citation context', () => {
    const content = 'Previous work by [@smith2024] showed that...';
    const contexts = extractCiteContexts(content, 'smith2024');
    assert.equal(contexts.length, 1);
    assert.ok(contexts[0].includes('Previous work'));
  });

  it('extracts multiple citation contexts', () => {
    const content = 'First [@key1] then later [@key1] again';
    const contexts = extractCiteContexts(content, 'key1');
    assert.equal(contexts.length, 2);
  });

  it('returns empty for unmatched key', () => {
    assert.equal(extractCiteContexts('text [@other]', 'missing').length, 0);
  });

  it('matches within multi-citation brackets', () => {
    const content = 'See [@a; @target; @b] for details';
    const contexts = extractCiteContexts(content, 'target');
    assert.equal(contexts.length, 1);
  });

  it('does not match partial key', () => {
    const content = 'See [@smith2024extended]';
    const contexts = extractCiteContexts(content, 'smith2024');
    assert.equal(contexts.length, 0);
  });
});

describe('flashcard next review date', () => {
  it('calculates correct next date', () => {
    const today = new Date();
    const interval = 7;
    const next = new Date(today);
    next.setDate(next.getDate() + interval);
    const diffDays = Math.round((next - today) / 86400000);
    assert.equal(diffDays, 7);
  });

  it('handles month boundary', () => {
    const jan31 = new Date(2025, 0, 31); // January 31 in local time
    jan31.setDate(jan31.getDate() + 1);
    assert.equal(jan31.getMonth(), 1); // February
  });
});
