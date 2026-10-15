import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const routes = loadRoute('agents');
const context = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const body = {
  name: 'Researcher',
  description: 'Finds the evidence',
  instructions: 'Check claims and cite the strongest available evidence.',
  color: 'blue',
};

describe('workspace agents', () => {
  it('creates RUSH with no custom instructions for an empty workspace', async () => {
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx: makeCtx(), requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      builtin: agent.builtin,
    })), [{id: 'rush', name: 'RUSH', instructions: '', builtin: true}]);
    assert.equal('profileId' in listed.payload.agents[0], false);
  });

  it('removes the model stored agents once chose', async () => {
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
    assert.equal('profileId' in migrated.payload.agents[0], false);
    assert.equal('model' in migrated.payload.agents[0], false);
    assert.equal(migrated.payload.agents[0].description, '');
  });

  it('removes the profile a stored agent chose', async () => {
    const ctx = makeCtx();
    const scope = ctx.scopeFor({context});
    await ctx.collection('agents').put(scope, 'mochi', {
      id: 'mochi',
      name: 'Mochi',
      description: '',
      instructions: '',
      profileId: 'removed-profile',
      builtin: true,
      defaultsVersion: 5,
    });

    const migrated = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.equal('profileId' in migrated.payload.agents[0], false);
    assert.equal((await ctx.collection('agents').get(scope, 'rush')).profileId, undefined);
  });

  it('renames the default agent Mochi to RUSH, keeping a name its workspace chose', async () => {
    for (const [stored, renamed] of [['Mochi', 'RUSH'], ['Scout', 'Scout']]) {
      const ctx = makeCtx();
      const scope = ctx.scopeFor({context});
      await ctx.collection('agents').put(scope, 'mochi', {
        id: 'mochi', name: stored, description: '', instructions: '', builtin: true, defaultsVersion: 6,
      });
      const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
      assert.equal(listed.payload.agents[0].name, renamed);
      assert.equal((await ctx.collection('agents').get(scope, 'rush')).name, renamed);
    }
  });

  it('moves the default agent from mochi to rush, keeping what its workspace chose', async () => {
    const ctx = makeCtx();
    const scope = ctx.scopeFor({context});
    await ctx.collection('agents').put(scope, 'mochi', {
      id: 'mochi', name: 'Scout', description: '', instructions: 'Be brief.', builtin: true, defaultsVersion: 7,
    });
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => [agent.id, agent.name, agent.instructions, agent.defaultsVersion]),
      [['rush', 'Scout', 'Be brief.', 8]]);
    assert.equal(await ctx.collection('agents').get(scope, 'mochi'), undefined);
  });

  it('creates, lists, edits, and deletes an agent', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body, ctx, requestContext: context});
    assert.equal(created.status, 201);
    assert.equal(created.payload.agent.name, 'Researcher');
    assert.equal(created.payload.agent.color, 'blue');
    assert.equal('profileId' in created.payload.agent, false);
    assert.equal('provider' in created.payload.agent, false);

    const id = created.payload.agent.id;
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => agent.id).sort(), [id, 'rush'].sort());

    const edited = await invoke(routes, {method: 'PATCH', path: `/api/agents/${id}`, body: {name: 'Evidence scout'}, ctx, requestContext: context});
    assert.equal(edited.payload.agent.name, 'Evidence scout');
    assert.equal(edited.payload.agent.instructions, body.instructions);

    const removed = await invoke(routes, {method: 'DELETE', path: `/api/agents/${id}`, ctx, requestContext: context});
    assert.deepEqual(removed.payload, {deleted: true});
    const empty = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.deepEqual(empty.payload.agents.map(agent => agent.id), ['rush']);
  });

  it('refuses an agent that chooses a model: each member chooses their own', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Plain', instructions: ''}, ctx, requestContext: context});
    assert.equal(created.payload.agent.instructions, '');
    const refusal = {error: 'An agent chooses no model: each member chooses theirs in Settings → Usage'};
    for (const choice of [{profileId: 'native-test'}, {provider: 'codex'}, {model: 'm'}]) {
      const refused = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Bad', ...choice}, ctx, requestContext: context});
      assert.deepEqual([refused.status, refused.payload], [400, refusal]);
    }
  });

  it('does not delete the built-in agent', async () => {
    const r = await invoke(routes, {method: 'DELETE', path: '/api/agents/rush', ctx: makeCtx(), requestContext: context});
    assert.deepEqual([r.status, r.payload], [400, {error: 'The default agent cannot be deleted'}]);
  });

  it('does not let a viewer change shared agents', async () => {
    const viewer = {...context, role: 'viewer'};
    await assert.rejects(
      invoke(routes, {method: 'POST', path: '/api/agents', body, ctx: makeCtx(), requestContext: viewer}),
      error => error?.status === 403,
    );
  });
});
