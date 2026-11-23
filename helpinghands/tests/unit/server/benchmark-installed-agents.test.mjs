import {it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {capabilitiesOf, DEFAULT_LIMITS} = require('../../../src/server/benchmark/limits.js');
const {createBenchmarkService} = require('../../../src/server/benchmark/service.js');

it('advertises installed agents and permits only one advertised by the benchmark worker', async () => {
  const capabilities = capabilitiesOf({...DEFAULT_LIMITS, models: ['model'], installed_agents: ['aider', 'aider']});
  assert.deepEqual(capabilities.installed_agents, ['aider']);
  assert.throws(() => capabilitiesOf({...DEFAULT_LIMITS, models: ['model'], installed_agents: ['aider --flag']}), /installed_agents/);
  const benchmark = {benchmark_id: 'b', endpoint_profile: 'local', limits: DEFAULT_LIMITS, model: 'model', cases: []};
  const repository = {
    runByKey: async () => null, benchmark: async () => benchmark,
    capabilities: async () => capabilities, createRun: async (_context, request) => ({run_id: request.harness}),
  };
  const service = createBenchmarkService({repository});
  const context = {userId: 'u'};
  assert.equal((await service.submit(context, {benchmark_id: 'b', harness: 'rush aider'})).run_id, 'rush aider');
  // Its headless arguments are no part of the agent installed: `aider` is.
  assert.equal((await service.submit(context, {benchmark_id: 'b', harness: 'rush aider --yes --message'})).run_id, 'rush aider --yes --message');
  await assert.rejects(service.submit(context, {benchmark_id: 'b', harness: 'rush missing'}), {code: 'agent_not_installed'});
});
