/**
 * server/org.js: the organization as a thing you administer.
 *
 * Run against a real scratch database and a real Better Auth instance, with
 * real sessions, because the point of this module is that it does NOT decide
 * who may change whom: it forwards the caller's own session and lets the plugin
 * decide. A test with a stubbed auth would prove the forwarding and nothing
 * about the rules, which are the part that matters. So every write below is
 * performed as somebody, with the bearer token they would really send.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const MODULES = [
  '../../../src/server/db.js',
  '../../../src/server/auth.js',
  '../../../src/server/chat.js',
  '../../../src/server/org.js',
];

let dir;
let db;
let auth;
let chat;
let org;

/** Accounts, keyed by username: {id, token}. */
const who = {};
let orgId;
let otherOrgId;

const headersFor = name => ({authorization: `Bearer ${who[name].token}`});

const signUp = async (username) => {
  const res = await auth.api.signUpEmail({
    body: {
      email: `${username}@test.invalid`,
      password: 'correcthorsebattery',
      name: username,
      username,
    },
  });
  return {id: res.user.id, token: res.token};
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-org-'));
  const saved = {DATABASE_FILE: process.env.DATABASE_FILE, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET};
  process.env.DATABASE_FILE = path.join(dir, 'org.db');
  process.env.BETTER_AUTH_SECRET = 'org-test-secret-'.padEnd(48, 'x');
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  try {
    ({db} = require('../../../src/server/db.js'));
    ({auth} = require('../../../src/server/auth.js'));
    chat = require('../../../src/server/chat.js');
    org = require('../../../src/server/org.js');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // Ada owns the organization, Bo administers it, Cal is an ordinary member,
  // and Dev is in a different one entirely.
  for (const name of ['ada', 'bea', 'cal', 'dev']) who[name] = await signUp(name);
  orgId = (await auth.api.createOrganization({body: {name: 'Team', slug: 'team', userId: who.ada.id}})).id;
  otherOrgId = (await auth.api.createOrganization({body: {name: 'Other', slug: 'other', userId: who.dev.id}})).id;
  await auth.api.addMember({body: {userId: who.bea.id, organizationId: orgId, role: 'admin'}});
  await auth.api.addMember({body: {userId: who.cal.id, organizationId: orgId, role: 'member'}});
});

after(() => {
  try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* already gone */ }
});

/** Roles and audit are per-test state; membership is set up once above. */
beforeEach(() => {
  db.exec('DELETE FROM org_audit');
  db.prepare('UPDATE member SET role = ? WHERE organizationId = ? AND userId = ?').run('admin', orgId, who.bea.id);
  db.prepare('UPDATE member SET role = ? WHERE organizationId = ? AND userId = ?').run('member', orgId, who.cal.id);
});

const memberIdOf = name => org.listMembers(orgId, who.ada.id).find(m => m.id === who[name].id).memberId;

describe('canManage', () => {
  for (const role of ['owner', 'admin', 'owner,member', 'member, admin']) {
    it(`lets ${JSON.stringify(role)} manage people`, () => assert.equal(org.canManage(role), true));
  }
  for (const role of ['member', 'guest', '', null, undefined]) {
    it(`does not let ${JSON.stringify(role)} manage people`, () => assert.equal(org.canManage(role), false));
  }
});

describe('the roster', () => {
  it('includes the caller, marked, because a list of who is here that leaves you out reads as a bug', () => {
    const rows = org.listMembers(orgId, who.ada.id);
    assert.deepEqual(rows.map(r => r.username), ['ada', 'bea', 'cal']);
    assert.deepEqual(rows.filter(r => r.you).map(r => r.username), ['ada']);
  });

  it('carries the role and the date each membership began', () => {
    const bea = org.listMembers(orgId, who.ada.id).find(r => r.username === 'bea');
    assert.equal(bea.role, 'admin');
    assert.ok(bea.joinedAt, 'joined at a time');
    assert.ok(bea.memberId && bea.memberId !== bea.id, 'the membership is not the account');
  });

  it('shows nothing to someone outside the organization', () => {
    assert.deepEqual(org.listMembers(orgId, who.dev.id), []);
    assert.deepEqual(org.listMembers(otherOrgId, who.ada.id), []);
  });

  it('carries the caller\'s dm with each person, and never one with themselves', () => {
    const before = org.listMembers(orgId, who.ada.id);
    assert.equal(before.every(r => r.dmChannelId === null), true, 'no conversations yet');

    const {channel} = chat.openDm(orgId, who.ada.id, who.bea.id);
    const after = org.listMembers(orgId, who.ada.id);
    assert.equal(after.find(r => r.username === 'bea').dmChannelId, channel.id);
    // The subquery matches a channel both sides of the join are in, so without
    // requiring those sides to differ, the caller's own row would claim the
    // first dm they happen to have with anyone.
    assert.equal(after.find(r => r.you).dmChannelId, null, 'not a dm with yourself');
    assert.equal(after.find(r => r.username === 'cal').dmChannelId, null);
  });

  it('does not lend one person\'s dm to another', () => {
    chat.openDm(orgId, who.ada.id, who.bea.id);
    const forCal = org.listMembers(orgId, who.cal.id);
    assert.equal(forCal.every(r => r.dmChannelId === null), true);
  });
});

describe('changing a role', () => {
  it('promotes a member, and writes down who did it', async () => {
    const result = await org.setMemberRole({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'), role: 'admin',
    });
    assert.equal(result.changed, true);
    assert.equal(result.member.role, 'admin');

    const [event] = org.listAudit(orgId);
    assert.equal(event.action, 'member.role');
    assert.equal(event.actorLabel, 'ada');
    assert.equal(event.targetLabel, 'cal');
    assert.deepEqual(event.detail, {from: 'member', to: 'admin'});
  });

  it('reports no change, and records nothing, when the role is already that', async () => {
    const result = await org.setMemberRole({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('bea'), role: 'admin',
    });
    assert.equal(result.changed, false);
    assert.equal(org.listAudit(orgId).length, 0, 'nothing happened, so nothing is recorded');
  });

  it('rejects a role that is not one of ours before asking anybody', async () => {
    const result = await org.setMemberRole({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'), role: 'superuser',
    });
    assert.equal(result.error, 'invalid-role');
  });

  it('rejects a membership that is not in this organization', async () => {
    const devMembership = db
      .prepare('SELECT id FROM member WHERE organizationId = ? AND userId = ?')
      .get(otherOrgId, who.dev.id);
    const result = await org.setMemberRole({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: devMembership.id, role: 'admin',
    });
    assert.equal(result.error, 'not-found');
  });

  // The rules below are Better Auth's, not this module's. They are asserted
  // here because forwarding the caller's session is the whole design, and a
  // refactor that forwarded the server's instead would pass every other test.
  it('refuses an ordinary member trying to promote anybody, including themselves', async () => {
    await assert.rejects(() => org.setMemberRole({
      headers: headersFor('cal'), orgId, actorId: who.cal.id, memberId: memberIdOf('cal'), role: 'admin',
    }));
    assert.equal(org.listMembers(orgId, who.ada.id).find(r => r.username === 'cal').role, 'member');
    assert.equal(org.listAudit(orgId).length, 0, 'a refused change is not an audited one');
  });

  it('refuses an admin trying to make anyone an owner', async () => {
    await assert.rejects(() => org.setMemberRole({
      headers: headersFor('bea'), orgId, actorId: who.bea.id, memberId: memberIdOf('cal'), role: 'owner',
    }));
  });

  it('refuses the last owner demoting themselves, which would leave nobody in charge', async () => {
    await assert.rejects(() => org.setMemberRole({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('ada'), role: 'member',
    }));
    assert.equal(org.listMembers(orgId, who.ada.id).find(r => r.you).role, 'owner');
  });
});

describe('removing someone', () => {
  it('takes their membership and their place in the channels, and leaves what they said', async () => {
    const {channel} = chat.createChannel(orgId, who.ada.id, {name: 'general'});
    chat.joinChannel(orgId, who.cal.id, channel.id);
    chat.postMessage(orgId, who.cal.id, channel.id, 'still here after I am gone');

    const result = await org.removeMember({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'),
    });
    assert.equal(result.removed.username, 'cal');

    assert.equal(org.listMembers(orgId, who.ada.id).some(r => r.username === 'cal'), false);
    assert.equal(chat.isChannelMember(channel.id, who.cal.id), false, 'and out of the channels');
    assert.equal(
      chat.listMessages(orgId, who.ada.id, channel.id).messages.length, 1,
      'a conversation does not lose its replies when someone leaves',
    );

    const [event] = org.listAudit(orgId);
    assert.equal(event.action, 'member.remove');
    assert.equal(event.targetLabel, 'cal');

    // Put them back for the tests that follow, membership being shared setup.
    await auth.api.addMember({body: {userId: who.cal.id, organizationId: orgId, role: 'member'}});
    db.exec('DELETE FROM message; DELETE FROM channel_member; DELETE FROM channel;');
  });

  it('does not touch their membership of another organization\'s channels', async () => {
    const mine = chat.createChannel(orgId, who.ada.id, {name: 'ours'}).channel;
    const theirs = chat.createChannel(otherOrgId, who.dev.id, {name: 'theirs'}).channel;
    chat.joinChannel(orgId, who.cal.id, mine.id);
    // Cal is in the other organization's channel without being in ours to
    // remove from: the delete must be scoped by organization, not by user.
    db.prepare('INSERT INTO channel_member (channelId, userId, joinedAt) VALUES (?, ?, ?)')
      .run(theirs.id, who.cal.id, new Date().toISOString());

    await org.removeMember({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'),
    });
    assert.equal(chat.isChannelMember(mine.id, who.cal.id), false);
    assert.equal(chat.isChannelMember(theirs.id, who.cal.id), true, 'the other organization is untouched');

    await auth.api.addMember({body: {userId: who.cal.id, organizationId: orgId, role: 'member'}});
    db.exec('DELETE FROM message; DELETE FROM channel_member; DELETE FROM channel;');
  });

  it('refuses an ordinary member removing anyone', async () => {
    await assert.rejects(() => org.removeMember({
      headers: headersFor('cal'), orgId, actorId: who.cal.id, memberId: memberIdOf('bea'),
    }));
    assert.equal(org.listMembers(orgId, who.ada.id).length, 3);
  });

  it('refuses removing the last owner', async () => {
    await assert.rejects(() => org.removeMember({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('ada'),
    }));
  });

  it('rejects a membership that is not in this organization', async () => {
    const devMembership = db
      .prepare('SELECT id FROM member WHERE organizationId = ? AND userId = ?')
      .get(otherOrgId, who.dev.id);
    const result = await org.removeMember({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: devMembership.id,
    });
    assert.equal(result.error, 'not-found');
  });
});

// Getting somebody in. Two ways, because there is no mail server: an
// invitation whose link the inviter passes on, and, for an owner on a laptop
// who wants a second account to test with, an account made outright.
describe('inviting', () => {
  const invited = 'newcomer@test.invalid';

  beforeEach(() => { db.exec('DELETE FROM invitation'); });

  it('creates an invitation an admin can see, with who sent it', async () => {
    const {invitation} = await org.invite({headers: headersFor('ada'), orgId, actorId: who.ada.id, email: invited});
    assert.equal(invitation.email, invited);
    assert.equal(invitation.organization, 'Team');
    assert.equal(invitation.invitedBy, 'ada');

    const [pending] = org.listInvitations(orgId);
    assert.deepEqual(
      [pending.email, pending.role, pending.invitedBy, pending.expired],
      [invited, 'member', 'ada', false],
    );
    const [event] = org.listAudit(orgId);
    assert.deepEqual([event.action, event.actorLabel, event.targetLabel], ['member.invite', 'ada', invited]);
  });

  it('lowercases the address, so one person is not invited twice', async () => {
    await org.invite({headers: headersFor('ada'), orgId, actorId: who.ada.id, email: '  NewComer@Test.invalid '});
    assert.deepEqual(org.listInvitations(orgId).map(i => i.email), [invited]);
  });

  it('rejects an empty address and an unknown role before asking anybody', async () => {
    assert.equal((await org.invite({headers: headersFor('ada'), orgId, actorId: who.ada.id, email: '   '})).error, 'invalid-email');
    assert.equal(
      (await org.invite({headers: headersFor('ada'), orgId, actorId: who.ada.id, email: invited, role: 'wizard'})).error,
      'invalid-role',
    );
  });

  it('refuses an ordinary member, and an admin inviting an owner', async () => {
    await assert.rejects(() => org.invite({headers: headersFor('cal'), orgId, actorId: who.cal.id, email: invited}));
    await assert.rejects(() => org.invite({
      headers: headersFor('bea'), orgId, actorId: who.bea.id, email: invited, role: 'owner',
    }));
    assert.deepEqual(org.listInvitations(orgId), []);
  });

  it('withdraws one, and stops offering it', async () => {
    const {invitation} = await org.invite({headers: headersFor('ada'), orgId, actorId: who.ada.id, email: invited});
    const result = await org.cancelInvitation({
      headers: headersFor('ada'), orgId, actorId: who.ada.id, invitationId: invitation.id,
    });
    assert.equal(result.cancelled, invited);
    assert.deepEqual(org.listInvitations(orgId), []);
    assert.notEqual(org.invitationForLink(invitation.id).status, 'pending', 'the row stays, the offer does not');
    assert.equal(org.listAudit(orgId)[0].action, 'member.invite-cancel');
  });

  it('will not withdraw an invitation belonging to another organization', async () => {
    const {invitation} = await org.invite({headers: headersFor('ada'), orgId, actorId: who.ada.id, email: invited});
    const result = await org.cancelInvitation({
      headers: headersFor('dev'), orgId: otherOrgId, actorId: who.dev.id, invitationId: invitation.id,
    });
    assert.equal(result.error, 'not-found');
    assert.equal(org.listInvitations(orgId).length, 1, 'still standing');
  });

  // The link is not a key to the organization: it is an offer to one address,
  // and Better Auth checks the accepting session against it.
  it('is accepted only by the account it was addressed to', async () => {
    const gil = await (async () => {
      const res = await auth.api.signUpEmail({
        body: {email: invited, password: 'correcthorsebattery', name: 'gil', username: 'gil'},
      });
      return {id: res.user.id, token: res.token};
    })();
    who.gil = gil;

    const {invitation} = await org.invite({headers: headersFor('ada'), orgId, actorId: who.ada.id, email: invited});

    await assert.rejects(
      () => org.acceptInvitation({headers: headersFor('cal'), actorId: who.cal.id, invitationId: invitation.id}),
      'somebody else holding the link is not the recipient',
    );
    assert.equal(org.listMembers(orgId, who.ada.id).some(m => m.username === 'gil'), false);

    const accepted = await org.acceptInvitation({
      headers: headersFor('gil'), actorId: gil.id, invitationId: invitation.id,
    });
    assert.equal(accepted.organizationId, orgId);
    assert.equal(org.listMembers(orgId, who.ada.id).some(m => m.username === 'gil'), true);
    assert.deepEqual(
      org.listAudit(orgId).map(e => e.action).slice(0, 1), ['member.join'],
      'joining is recorded as much as being removed is',
    );

    // Leave the roster as the other tests expect it.
    db.prepare('DELETE FROM member WHERE organizationId = ? AND userId = ?').run(orgId, gil.id);
  });

  it('answers nothing for an id that was never issued', () => {
    assert.equal(org.invitationForLink('no-such-invitation'), null);
  });
});

describe('creating an account outright', () => {
  it('makes a real account, puts it in the organization, and records it', async () => {
    const result = await org.createAccount({
      orgId, actorId: who.ada.id, username: 'hana', password: 'correcthorsebattery', name: 'Hana',
    });
    assert.equal(result.user.username, 'hana');
    assert.equal(result.user.email, 'hana@mochi.local', 'an address is invented when none is given');

    const row = org.listMembers(orgId, who.ada.id).find(m => m.username === 'hana');
    assert.equal(row.role, 'member');
    assert.equal(org.listAudit(orgId)[0].action, 'member.create');

    // It is an ordinary account: the password works.
    const signedIn = await auth.api.signInUsername({body: {username: 'hana', password: 'correcthorsebattery'}});
    assert.ok(signedIn.token);

    db.prepare('DELETE FROM member WHERE organizationId = ? AND userId = ?').run(orgId, result.user.id);
    db.prepare('DELETE FROM "user" WHERE id = ?').run(result.user.id);
  });

  const REJECTED = [
    ['a username of two characters', {username: 'jo', password: 'correcthorsebattery'}, 'invalid-username'],
    ['a username with a space', {username: 'jo ann', password: 'correcthorsebattery'}, 'invalid-username'],
    ['a password of seven characters', {username: 'jonas', password: 'sevench'}, 'weak-password'],
    ['an unknown role', {username: 'jonas', password: 'correcthorsebattery', role: 'wizard'}, 'invalid-role'],
  ];
  for (const [name, body, error] of REJECTED) {
    it(`rejects ${name}`, async () => {
      assert.equal((await org.createAccount({orgId, actorId: who.ada.id, ...body})).error, error);
    });
  }

  it('reports the reason when the name is taken, rather than a bare failure', async () => {
    const result = await org.createAccount({orgId, actorId: who.ada.id, username: 'cal', password: 'correcthorsebattery'});
    assert.equal(result.error, 'signup-failed');
    assert.ok(result.reason, 'and says what Better Auth said');
  });
});

describe('the audit log', () => {
  // Two changes can land in the same millisecond, and they did: ordering by the
  // id to break the tie put them in the order of two random strings.
  it('reads newest first and is scoped to one organization', async () => {
    await org.setMemberRole({headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'), role: 'admin'});
    await org.setMemberRole({headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'), role: 'member'});

    const events = org.listAudit(orgId);
    assert.deepEqual(events.map(e => e.detail.to), ['member', 'admin'], 'newest first');
    assert.deepEqual(org.listAudit(otherOrgId), [], 'another organization sees none of it');
  });

  it('caps what it returns however much is asked for', async () => {
    await org.setMemberRole({headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'), role: 'admin'});
    assert.equal(org.listAudit(orgId, 10_000).length <= org.AUDIT_LIMIT, true);
    assert.equal(org.listAudit(orgId, 'nonsense').length >= 1, true, 'a bad limit falls back to the default');
  });

  // An audit row is evidence about an account, so deleting the account must
  // neither delete the evidence nor be blocked by it.
  it('outlives the accounts it names', async () => {
    await org.setMemberRole({headers: headersFor('ada'), orgId, actorId: who.ada.id, memberId: memberIdOf('cal'), role: 'admin'});
    db.prepare('DELETE FROM "user" WHERE id = ?').run(who.cal.id);

    const [event] = org.listAudit(orgId);
    assert.equal(event.targetId, null, 'the link goes');
    assert.equal(event.targetLabel, 'cal', 'the name it happened to stays');

    who.cal = await signUp('cal');
    await auth.api.addMember({body: {userId: who.cal.id, organizationId: orgId, role: 'member'}});
  });
});
