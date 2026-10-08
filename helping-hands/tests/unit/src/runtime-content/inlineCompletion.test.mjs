import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeInlineCompletion} from '../../../../src/runtime-content/inlineCompletion.js';

describe('normalizeInlineCompletion', () => {
  it('removes a Markdown fence while preserving insertable leading space', () => {
    assert.equal(normalizeInlineCompletion('```markdown\n continues here\n```'), ' continues here');
  });

  it('adds a separating space when a model returns a bare word after a word', () => {
    assert.equal(normalizeInlineCompletion('continues here', 'd'), ' continues here');
  });

  it('rejects an empty completion', () => {
    assert.equal(normalizeInlineCompletion('   '), '');
  });
});
