import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {invoke, makeCtx} from '../../_harness.mjs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const routes = require('../../../../src/server/routes/org.js');

describe('organization route context boundary', () => {
  it('passes the verified identity separately when accepting an invitation', async () => {
    const calls = [];
    const identity = {userId: 'invitee', orgId: null, sessionId: 'session-1'};
    const ctx = makeCtx({
      org: {
        acceptInvitation: async (...args) => {
          calls.push(args);
          return {organizationId: 'workspace-1'};
        },
      },
    });

    const result = await invoke(routes, {
      method: 'POST', path: '/api/invite/invitation-1/accept', auth: identity,
      headers: {cookie: 'better-auth.session_token=token'}, ctx,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(calls, [[identity, {
      headers: {cookie: 'better-auth.session_token=token'},
      invitationId: 'invitation-1',
    }]]);
  });
});
