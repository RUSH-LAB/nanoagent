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
  it('creates, lists, edits, and deletes an agent', async () => {
    const ctx = makeCtx();
    const created = await invoke(routes, {method: 'POST', path: '/api/agents', body, ctx, requestContext: context});
    assert.equal(created.status, 201);
    assert.equal(created.payload.agent.name, 'Researcher');
    assert.equal(created.payload.agent.color, 'blue');

    const id = created.payload.agent.id;
    const listed = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.deepEqual(listed.payload.agents.map(agent => agent.id), [id]);

    const edited = await invoke(routes, {method: 'PATCH', path: `/api/agents/${id}`, body: {name: 'Evidence scout'}, ctx, requestContext: context});
    assert.equal(edited.payload.agent.name, 'Evidence scout');
    assert.equal(edited.payload.agent.instructions, body.instructions);

    const removed = await invoke(routes, {method: 'DELETE', path: `/api/agents/${id}`, ctx, requestContext: context});
    assert.deepEqual(removed.payload, {deleted: true});
    const empty = await invoke(routes, {method: 'GET', path: '/api/agents', ctx, requestContext: context});
    assert.deepEqual(empty.payload, {agents: []});
  });

  it('requires a name and instructions', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/agents', body: {name: 'Empty'}, ctx: makeCtx(), requestContext: context});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Agent instructions are required'}]);
  });

  it('does not let a viewer change shared agents', async () => {
    const viewer = {...context, role: 'viewer'};
    await assert.rejects(
      invoke(routes, {method: 'POST', path: '/api/agents', body, ctx: makeCtx(), requestContext: viewer}),
      error => error?.status === 403,
    );
  });
});
