import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createAgentRuntime} = require('../../../src/server/agent-runtime.js');

describe('agent runtime', () => {
  it('keeps the provider protocol behind one runtime boundary', async () => {
    const calls = [];
    const events = [];
    const inference = {
      async complete(request) { calls.push(request); return {text: 'done'}; },
      async stream(request) {
        calls.push(request);
        request.onDelta('one');
        request.onDelta(' two');
        return {text: 'one two'};
      },
      describe: () => ({available: true, provider: 'fake'}),
    };
    const runtime = createAgentRuntime({inference});
    const deltas = [];
    const result = await runtime.stream({
      prompt: 'hello',
      provider: 'fake',
      onDelta: text => deltas.push(text),
      onEvent: event => events.push(event.type),
    });

    assert.deepEqual(result, {text: 'one two'});
    assert.deepEqual(deltas, ['one', ' two']);
    assert.deepEqual(events, ['turn.started', 'output_text.delta', 'output_text.delta', 'turn.completed']);
    assert.equal(calls[0].provider, 'fake');
    assert.deepEqual(calls[0].messages, [{role: 'user', content: 'hello'}]);
  });

  it('executes an allowed tool and continues the model loop with its result', async () => {
    const calls = [];
    const inference = {
      async complete(request) {
        calls.push(request);
        if (calls.length === 1) {
          return {text: '', toolCalls: [{id: 'call-1', name: 'lookup', arguments: {query: 'mochi'}}]};
        }
        return {text: 'Found it'};
      },
      async stream() { throw new Error('not used'); },
      describe: () => ({available: true}),
    };
    const runtime = createAgentRuntime({
      inference,
      tools: {
        lookup: {
          authorize: ({context}) => context?.canRead === true,
          execute: ({arguments: args}) => ({title: args.query}),
        },
      },
    });

    const result = await runtime.complete({
      prompt: 'find it',
      allowedTools: ['lookup'],
      runtimeContext: {canRead: true},
    });
    assert.deepEqual(result, {text: 'Found it'});
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].messages.at(-1), {
      role: 'tool',
      toolCallId: 'call-1',
      name: 'lookup',
      content: '{"title":"mochi"}',
    });
  });

  it('rejects a tool that the agent was not explicitly allowed to use', async () => {
    let executed = false;
    const inference = {
      complete: async () => ({toolCalls: [{id: '1', name: 'write', arguments: {}}]}),
      stream: async () => ({text: ''}),
      describe: () => ({available: true}),
    };
    const runtime = createAgentRuntime({
      inference,
      tools: {write: {execute: async () => { executed = true; }}},
    });
    const result = await runtime.complete({prompt: 'change it'});
    assert.equal(result.status, 403);
    assert.match(result.error, /not allowed/);
    assert.equal(executed, false);
  });

  it('bounds a provider that keeps requesting tools', async () => {
    const inference = {
      complete: async () => ({toolCalls: [{id: '1', name: 'lookup', arguments: {}}]}),
      stream: async () => ({text: ''}),
      describe: () => ({available: true}),
    };
    const runtime = createAgentRuntime({
      inference,
      maxSteps: 2,
      tools: {lookup: {execute: async () => 'again'}},
    });
    const result = await runtime.complete({prompt: 'loop', allowedTools: ['lookup']});
    assert.deepEqual(result, {error: 'Agent exceeded the 2-step limit', status: 508});
  });

  it('publishes runtime capabilities with provider diagnostics', () => {
    const runtime = createAgentRuntime({
      inference: {complete() {}, stream() {}, describe: () => ({provider: 'fake'})},
      tools: {search: {execute() {}}},
      maxSteps: 4,
    });
    assert.deepEqual(runtime.describe(), {provider: 'fake', runtime: {maxSteps: 4, tools: ['search']}});
  });
});
