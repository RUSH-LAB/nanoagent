import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  entriesForTarget,
  normalizeChatTitle,
  restoreSessionState,
  targetKey,
} from '../../../../../src/components/CommandBar/useSessions.js';

describe('AI chat identity', () => {
  it('scopes a transcript by chat rather than by agent', () => {
    assert.equal(targetKey({chatId: 'chat-1', agentId: 'researcher'}), 'chat:chat-1');
    assert.deepEqual(entriesForTarget([
      {id: 1, targetKey: 'chat:chat-1'},
      {id: 2, targetKey: 'chat:chat-2'},
    ], {chatId: 'chat-1'}).map(entry => entry.id), [1]);
  });

  it('restores independent chats without merging conversations using the same agent', () => {
    const restored = restoreSessionState(JSON.stringify({
      version: 2,
      activeId: 1,
      sessions: [{id: 1, target: {chatId: 'one', agentId: 'mochi'}, entries: []}],
      chats: [
        {id: 'one', agentId: 'mochi', profileId: 'pi-fast', modelChoice: {key: 'a/b', choice: {provider: 'a', model: 'b'}}, title: 'First', entries: [
          {id: 1, kind: 'input', text: 'one'},
          {id: 2, kind: 'input', text: '/model fast', command: true},
          {id: 3, kind: 'output', text: 'answer', telemetry: {
            cost: 0.01,
            usage: {prompt_tokens: 10, completion_tokens: 2},
            metrics: {duration_s: 1.5, steps: []},
          }},
        ]},
        {id: 'two', agentId: 'mochi', title: 'Second', entries: [{id: 2, kind: 'input', text: 'two'}]},
      ],
    }));
    assert.equal(restored.chats.length, 2);
    assert.equal(restored.sessions[0].target.chatId, 'one');
    // The model a chat chose with /model is kept; the profile it once copied from its agent is not.
    assert.deepEqual(restored.chats[0].modelChoice, {key: 'a/b', choice: {provider: 'a', model: 'b'}});
    assert.equal('profileId' in restored.chats[0], false);
    assert.equal(restored.chats[0].entries[1].command, true);
    assert.deepEqual(restored.chats[0].entries[2].telemetry, {
      cost: 0.01,
      usage: {prompt_tokens: 10, completion_tokens: 2},
      metrics: {duration_s: 1.5, steps: []},
    });
    assert.equal(restored.chats[1].entries[0].targetKey, 'chat:two');
  });

  it('normalizes manageable chat titles', () => {
    assert.equal(normalizeChatTitle('  A   useful\nconversation  '), 'A useful conversation');
    assert.equal(normalizeChatTitle('x'.repeat(80)).length, 60);
    assert.equal(normalizeChatTitle('   '), '');
  });
});

describe('legacy session migration', () => {
  it('turns a saved per-agent transcript into an existing chat', () => {
    const restored = restoreSessionState(JSON.stringify({
      activeId: 7,
      sessions: [{
        id: 7,
        target: {agentId: 'mochi', label: 'Mochi'},
        entries: [
          {id: 10, kind: 'input', text: 'Explain this', targetKey: 'agent:mochi'},
          {id: 11, kind: 'output', text: 'Sure', targetKey: 'agent:mochi'},
        ],
      }],
    }));
    assert.equal(restored.chats.length, 1);
    assert.equal(restored.chats[0].title, 'Explain this');
    assert.equal(restored.sessions[0].target.chatId, restored.chats[0].id);
    assert.deepEqual(restored.chats[0].entries.map(entry => entry.targetKey), [
      `chat:${restored.chats[0].id}`,
      `chat:${restored.chats[0].id}`,
    ]);
  });

  it('preserves an explicitly opened empty legacy conversation', () => {
    const restored = restoreSessionState(JSON.stringify({
      activeId: 1,
      sessions: [{id: 1, target: {agentId: 'mochi', label: 'Mochi'}, entries: []}],
    }));
    assert.equal(restored.chats.length, 1);
    assert.equal(restored.chats[0].title, 'Mochi chat');
  });
});
