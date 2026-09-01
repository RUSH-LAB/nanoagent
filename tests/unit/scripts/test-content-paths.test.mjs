import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {isKnownTestDocumentPath} from '../../../scripts/maintenance/test-content-paths.mjs';

describe('integration-test document paths', () => {
  it('recognizes generated stress and workflow documents', () => {
    assert.equal(isKnownTestDocumentPath('posts/blog/2026-08-31-resilience-1788196666608-stress-ratelimit.md'), true);
    assert.equal(isKnownTestDocumentPath('posts/blog/2026-08-31-resilience-1788196666608-stress-ratelimit_04ee2befa841.md'), true);
    assert.equal(isKnownTestDocumentPath('posts/blog/2026-08-31-test-1788189206841-rate-limit.md'), true);
    assert.equal(isKnownTestDocumentPath('posts/wftest-1788196666444_research_post.md'), true);
  });

  it('does not classify real Mochi documents as test data', () => {
    assert.equal(isKnownTestDocumentPath('posts/blog/how-to-research.md'), false);
    assert.equal(isKnownTestDocumentPath('posts/research/compress-or-not-zeyu-2025/index.mdx'), false);
    assert.equal(isKnownTestDocumentPath('books/programming/0-intro.md'), false);
  });
});
