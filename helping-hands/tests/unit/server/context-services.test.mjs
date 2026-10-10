import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {contextualChat, contextualOrg} = require('../../../src/server/context-services.js');

const context = Object.freeze({
  userId: 'user-a', workspaceId: 'workspace-a', membershipId: 'member-a', role: 'owner',
});

describe('request-context domain service boundary', () => {
  it('derives chat tenant and actor ids only from RequestContext', async () => {
    const calls = [];
    const chat = contextualChat({
      listChannels(...args) { calls.push(args); return []; },
      deleteChannel(...args) { calls.push(args); return {deleted: true}; },
    });
    await chat.listChannels(context, {includeArchived: true});
    await chat.deleteChannel(context, 'channel-a');
    assert.deepEqual(calls, [
      ['workspace-a', 'user-a', {includeArchived: true}],
      ['workspace-a', 'user-a', 'channel-a', {manages: true}],
    ]);
  });

  it('derives organization writes from RequestContext', async () => {
    let call;
    const org = contextualOrg({
      ROLES: ['owner', 'editor', 'viewer'], canManage: role => role === 'owner',
      invitationForLink() {}, slugForOrg() {}, allOrganizations() {},
      setMemberRole(input) { call = input; return {changed: true}; },
    });
    await org.setMemberRole(context, {headers: {cookie: 'session'}, memberId: 'member-b', role: 'viewer'});
    assert.deepEqual(call, {
      headers: {cookie: 'session'}, memberId: 'member-b', role: 'viewer',
      orgId: 'workspace-a', actorId: 'user-a',
    });
  });

  it('rejects incomplete contexts before calling an adapter', () => {
    let called = false;
    const chat = contextualChat({listChannels() { called = true; }});
    assert.throws(() => chat.listChannels({userId: 'user-a', workspaceId: 'workspace-a'}), /verified workspace context/);
    assert.equal(called, false);
  });
});
