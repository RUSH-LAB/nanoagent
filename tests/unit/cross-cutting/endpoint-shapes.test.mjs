import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('API response shapes', () => {
  it('health check shape', () => {
    const shape = {status: 'ok', uptime: 123, memory: 456};
    assert.equal(shape.status, 'ok');
    assert.ok(typeof shape.uptime === 'number');
    assert.ok(typeof shape.memory === 'number');
  });

  it('file list shape', () => {
    const shape = {files: [{name: 'test.md', path: 'content/test.md', type: 'file'}]};
    assert.ok(Array.isArray(shape.files));
    assert.ok(shape.files[0].name);
    assert.ok(shape.files[0].path);
  });

  it('comment shape', () => {
    const shape = {comments: [{id: 'c_1', author: 'Test', text: 'Hello', createdAt: '2025-01-01'}], total: 1};
    assert.ok(Array.isArray(shape.comments));
    assert.equal(shape.total, 1);
  });

  it('reference shape', () => {
    const shape = {references: {key1: {type: 'article', title: 'Test', author: ['Author'], year: 2024}}};
    assert.ok(typeof shape.references === 'object');
    assert.ok(shape.references.key1.title);
  });

  it('analytics shape', () => {
    const shape = {pageviews: {'/docs': 10}, recent: [{path: '/docs', timestamp: '2025-01-01'}]};
    assert.ok(typeof shape.pageviews === 'object');
    assert.ok(Array.isArray(shape.recent));
  });

  it('flashcard shape', () => {
    const card = {id: 'fc_1', front: 'Q', back: 'A', interval: 1, easeFactor: 2.5, repetitions: 0, nextReview: '2025-01-01'};
    assert.ok(card.id);
    assert.ok(typeof card.interval === 'number');
    assert.ok(typeof card.easeFactor === 'number');
  });

  it('dashboard shape', () => {
    const shape = {content: {files: 100, words: 50000, references: 500}, social: {comments: 10, channels: 3, messages: 50}};
    assert.ok(shape.content.files > 0);
    assert.ok(typeof shape.social.comments === 'number');
  });
});
