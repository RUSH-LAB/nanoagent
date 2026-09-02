import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const routes = loadRoute('agents');
const MODEL = routes.DEFAULT_MODEL;
const context = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const body = {
  name: 'Researcher',
  description: 'Finds the evidence',
  instructions: 'Check claims and cite the strongest available evidence.',
  model: MODEL,
  color: 'blue',
};

describe('workspace agents', () => {
  it('creates Mochi with no custom instructions for an empty workspace', async () => {
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx: makeCtx(), requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      model: agent.model,
      builtin: agent.builtin,
    })), [{id: 'mochi', name: 'Mochi', instructions: '', model: MODEL, builtin: true}]);
  });

  it('removes legacy provider selection from stored agents', async () => {
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
    assert.equal('provider' in migrated.payload.agents[0], false);
    assert.equal(migrated.payload.agents[0].model, MODEL);
    assert.equal(migrated.payload.agents[0].description, '');
  });

  it('creates, lists, edits, and deletes an agent', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body, ctx, requestContext: context});
    assert.equal(created.status, 201);
    assert.equal(created.payload.agent.name, 'Researcher');
    assert.equal(created.payload.agent.color, 'blue');
    assert.equal(created.payload.agent.model, MODEL);
    assert.equal('provider' in created.payload.agent, false);

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

  it('allows the catalog model and rejects unsupported models or legacy providers', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Plain', instructions: ''}, ctx, requestContext: context});
    assert.equal(created.payload.agent.instructions, '');
    assert.equal(created.payload.agent.model, MODEL);
    assert.equal('provider' in created.payload.agent, false);

    const unsupported = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Bad', model: 'other'}, ctx, requestContext: context});
    assert.deepEqual([unsupported.status, unsupported.payload], [400, {error: 'Unsupported AI model'}]);

    const legacy = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Old', provider: 'codex'}, ctx, requestContext: context});
    assert.deepEqual([legacy.status, legacy.payload], [400, {error: 'Model selection is managed by NanoAgent'}]);
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
