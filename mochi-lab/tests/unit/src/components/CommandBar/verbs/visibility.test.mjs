import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {VERBS} from '../../../../../../src/components/CommandBar/verbs.js';

const offered = target => VERBS
  .filter(command => !command.when || command.when({session: {target}}))
  .map(command => command.name);

describe('agent runtime command visibility', () => {
  it('offers both commands in an open AI chat', () => {
    assert.deepEqual(
      offered({chatId: 'chat-1', agentId: 'mochi'}),
      ['harness', 'model'],
    );
  });

  it('offers no slash commands outside an open AI chat', () => {
    assert.deepEqual(offered(null), []);
    assert.deepEqual(offered({agentId: 'mochi'}), []);
    assert.deepEqual(offered({channelId: 'channel-1'}), []);
  });
});
