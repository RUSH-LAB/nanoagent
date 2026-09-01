import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const routes = loadRoute('agents');
const context = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const body = {
  name: 'Researcher',
  description: 'Finds the evidence',
  instructions: 'Check claims and cite the strongest available evidence.',
  provider: 'codex',
  color: 'blue',
};

describe('workspace agents', () => {
  it('creates Mochi with no custom instructions for an empty workspace', async () => {
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx: makeCtx(), requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      provider: agent.provider,
      builtin: agent.builtin,
    })), [{id: 'mochi', name: 'Mochi', instructions: '', provider: 'codex', builtin: true}]);
  });

  it('moves the legacy Mochi default to Codex once without overriding later choices', async () => {
    const ctx = makeCtx();
    const scope = ctx.scopeFor({context});
    await ctx.collection('agents').put(scope, 'mochi', {
      id: 'mochi',
      name: 'Mochi',
      description: 'Your general-purpose assistant',
      instructions: '',
      provider: 'claude-code',
      builtin: true,
    });

    const migrated = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.equal(migrated.payload.agents[0].provider, 'codex');
    assert.equal(migrated.payload.agents[0].description, '');

    await invoke(routes, {
      method: 'PATCH',
      path: '/api/agents/mochi',
      body: {provider: 'claude-code'},
      ctx,
      requestContext: context,
    });
    const selected = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.equal(selected.payload.agents[0].provider, 'claude-code');
  });

  it('creates, lists, edits, and deletes an agent', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body, ctx, requestContext: context});
    assert.equal(created.status, 201);
    assert.equal(created.payload.agent.name, 'Researcher');
    assert.equal(created.payload.agent.color, 'blue');
    assert.equal(created.payload.agent.provider, 'codex');

    const id = created.payload.agent.id;
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => agent.id).sort(), [id, 'mochi'].sort());

    const edited = await invoke(routes, {method: 'PATCH', path: `/api/agents/${id}`, body: {name: 'Evidence scout'}, ctx, requestContext: context});
    assert.equal(edited.payload.agent.name, 'Evidence scout');
    assert.equal(edited.payload.agent.instructions, body.instructions);

    const removed = await invoke(routes, {method: 'DELETE', path: `/api/agents/${id}`, ctx, requestContext: context});
    assert.deepEqual(removed.payload, {deleted: true});
    const empty = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.deepEqual(empty.payload.agents.map(agent => agent.id), ['mochi']);
  });

  it('allows empty instructions and rejects an unknown model', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Plain', instructions: ''}, ctx, requestContext: context});
    assert.equal(created.payload.agent.instructions, '');
    assert.equal(created.payload.agent.provider, 'codex');

    const rejected = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Bad', provider: 'other'}, ctx, requestContext: context});
    assert.deepEqual([rejected.status, rejected.payload], [400, {error: 'Model must be Codex or Claude Code'}]);
  });

  it('does not delete the built-in Mochi agent', async () => {
    const r = await invoke(routes, {method: 'DELETE', path: '/api/agents/mochi', ctx: makeCtx(), requestContext: context});
    assert.deepEqual([r.status, r.payload], [400, {error: 'The default Mochi agent cannot be deleted'}]);
  });

  it('does not let a viewer change shared agents', async () => {
    const viewer = {...context, role: 'viewer'};
    await assert.rejects(
      invoke(routes, {method: 'POST', path: '/api/agents', body, ctx: makeCtx(), requestContext: viewer}),
      error => error?.status === 403,
    );
  });
});
