import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {followCompletion, normalizeInlineCompletion} from '../../../../src/runtime-content/inlineCompletion.js';

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

describe('followCompletion', () => {
  const state = EditorState.create({doc: 'Hello wor', selection: {anchor: 9}});
  const offered = {request: 'r1', anchor: 9, text: 'ld again', typed: ''};
  const typing = state.update({changes: {from: 9, insert: 'ld'}, selection: {anchor: 11}});

  it('trims the suggestion as the user types it', () => {
    const typed = followCompletion(offered, typing);
    assert.deepEqual(typed, {...offered, typed: 'ld'});
    const next = typing.state.update({changes: {from: 11, insert: ' a'}, selection: {anchor: 13}});
    assert.deepEqual(followCompletion(typed, next), {...offered, typed: 'ld a'});
  });

  it('drops the suggestion once it is fully typed or the typing departs from it', () => {
    assert.equal(followCompletion(offered, state.update({changes: {from: 9, insert: 'ld again'}, selection: {anchor: 17}})), null);
    assert.equal(followCompletion(offered, state.update({changes: {from: 9, insert: 'x'}, selection: {anchor: 10}})), null);
  });

  it('drops the suggestion when the cursor moves', () => {
    assert.equal(followCompletion(offered, state.update({selection: {anchor: 3}})), null);
  });

  it('maps the anchor through an edit elsewhere and drops it when the edit reaches the suggestion', () => {
    assert.deepEqual(followCompletion(offered, state.update({changes: {from: 0, insert: 'Oh. '}})), {...offered, anchor: 13});
    const typed = {...offered, typed: 'ld'};
    assert.equal(followCompletion(typed, typing.state.update({changes: {from: 10, insert: 'X'}})), null);
  });
});
