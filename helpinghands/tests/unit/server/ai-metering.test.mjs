import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createAiMeter, UNPRICED_RUN_USD} = require('../../../src/server/ai-metering.js');

function fakeTenancy() {
  const recorded = [];
  return {
    recorded,
    assertAiAllowed: async () => {
      throw Object.assign(new Error('The workspace has spent its AI budget'), {name: 'TenancyError', status: 429});
    },
    recordAiUsage: async (_context, usage) => recorded.push(usage),
  };
}

describe('AI metering', () => {
  it('charges a run on RUSH\'s NanoAgent, at the cap when it was not priced', async () => {
    const tenancy = fakeTenancy();
    const meter = createAiMeter(tenancy);
    await assert.rejects(() => meter.assertAllowed({}), {status: 429});
    await meter.record({}, 'chat', {text: 'a'}, {ran: true});
    assert.equal(tenancy.recorded[0].cost, UNPRICED_RUN_USD);
    assert.equal(tenancy.recorded[0].estimated, true);
  });

  it('never refuses or charges a run on the member\'s own computer, and still records it', async () => {
    const tenancy = fakeTenancy();
    const meter = createAiMeter(tenancy);
    await meter.assertAllowed({}, {local: true});
    await meter.record({}, 'chat', {text: 'a', cost: 0.02, model: 'm'}, {ran: true, local: true});
    await meter.record({}, 'task', null, {ran: true, local: true});
    assert.deepEqual(tenancy.recorded.map(({cost, estimated, model}) => ({cost, estimated, model})), [
      {cost: 0, estimated: false, model: 'm'},
      {cost: 0, estimated: false, model: null},
    ]);
  });
});
