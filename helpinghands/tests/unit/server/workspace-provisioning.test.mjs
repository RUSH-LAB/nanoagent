import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createWorkspaceProvisioning} = require('../../../src/server/workspace-provisioning.js');

function postgresHarness() {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({sql, params});
      if (/select id from channel/i.test(sql)) return {rows: [{id: 'general-channel'}]};
      return {rows: []};
    },
    release() {},
  };
  return {
    calls,
    postgres: {enabled: true, pool: {connect: async () => client}},
  };
}

describe('workspace provisioning', () => {
  it('initializes workspace-owned records when the owner membership is created', async () => {
    const harness = postgresHarness();
    const provisioning = createWorkspaceProvisioning({
      postgres: harness.postgres,
      now: () => '2026-08-31T00:00:00.000Z',
      newId: () => 'generated-id',
    });

    await provisioning.hooks.afterAddMember({
      member: {userId: 'owner-user', role: 'owner'},
      user: {id: 'owner-user'},
      organization: {id: 'workspace-1'},
    });

    assert.ok(harness.calls.some(call => /insert into workspace_settings/i.test(call.sql)));
    assert.ok(harness.calls.some(call => /insert into channel\(/i.test(call.sql)));
    assert.ok(harness.calls.some(call => /insert into channel_member/i.test(call.sql)));
  });

  it('does not make an invited non-owner perform owner-only workspace setup', async () => {
    const harness = postgresHarness();
    const provisioning = createWorkspaceProvisioning({
      postgres: harness.postgres,
      now: () => '2026-08-31T00:00:00.000Z',
      newId: () => 'generated-id',
    });

    await provisioning.hooks.afterAcceptInvitation({
      member: {userId: 'viewer-user', role: 'viewer'},
      user: {id: 'viewer-user'},
      organization: {id: 'workspace-1'},
    });

    assert.equal(harness.calls.some(call => /insert into workspace_settings/i.test(call.sql)), false);
    assert.equal(harness.calls.some(call => /insert into channel\(/i.test(call.sql)), false);
    assert.ok(harness.calls.some(call => /select id from channel/i.test(call.sql)));
    assert.ok(harness.calls.some(call => /insert into channel_member/i.test(call.sql)));
  });
});
