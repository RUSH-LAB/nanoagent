import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const routes = loadRoute('agents');
const PROFILE = 'native-test';
const context = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const body = {
  name: 'Researcher',
  description: 'Finds the evidence',
  instructions: 'Check claims and cite the strongest available evidence.',
  profileId: PROFILE,
  color: 'blue',
};

describe('workspace agents', () => {
  it('creates Mochi with no custom instructions for an empty workspace', async () => {
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx: makeCtx(), requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      profileId: agent.profileId,
      builtin: agent.builtin,
    })), [{id: 'mochi', name: 'Mochi', instructions: '', profileId: 'native-test', builtin: true}]);
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
      model: 'test-model',
      builtin: true,
    });

    const migrated = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.equal('provider' in migrated.payload.agents[0], false);
    assert.equal(migrated.payload.agents[0].profileId, 'native-test');
    assert.equal('model' in migrated.payload.agents[0], false);
    assert.equal(migrated.payload.agents[0].description, '');
  });

  it('creates, lists, edits, and deletes an agent', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body, ctx, requestContext: context});
    assert.equal(created.status, 201);
    assert.equal(created.payload.agent.name, 'Researcher');
    assert.equal(created.payload.agent.color, 'blue');
    assert.equal(created.payload.agent.profileId, PROFILE);
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

  it('allows configured profiles and rejects arbitrary or legacy selection fields', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Plain', instructions: ''}, ctx, requestContext: context});
    assert.equal(created.payload.agent.instructions, '');
    assert.equal(created.payload.agent.profileId, 'native-test');
    assert.equal('provider' in created.payload.agent, false);

    const unsupported = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Bad', profileId: 'other'}, ctx, requestContext: context});
    assert.deepEqual([unsupported.status, unsupported.payload], [400, {error: 'Unsupported NanoAgent profile'}]);

    const legacy = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Old', provider: 'codex'}, ctx, requestContext: context});
    assert.deepEqual([legacy.status, legacy.payload], [400, {error: 'Harness and model selection use a NanoAgent profileId'}]);
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
