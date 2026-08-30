/**
 * server/chat.js: channels, direct messages, and messages.
 *
 * Run against a real scratch SQLite database rather than a mock, because most
 * of what this module does IS the SQL: the visibility join, the partial unique
 * indexes that keep one dm per pair, the cascade that removes a channel's
 * messages with it. A stub would agree with whatever the code did.
 *
 * The rows are inserted directly instead of going through Better Auth. What is
 * under test is the scoping, and the fastest way to set up two organizations
 * with overlapping membership is to write the six rows that describe them.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

let dir;
let chat;
let db;

/** Two organizations. Alice and Bob share the first; Eve is alone in the second. */
const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const EVE = 'user_eve';

function seed() {
  db.exec('DELETE FROM org_audit; DELETE FROM message; DELETE FROM channel_member; DELETE FROM channel; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";');
  const user = db.prepare('INSERT INTO "user" (id, name, email, emailVerified, username, createdAt, updatedAt) VALUES (?,?,?,0,?,0,0)');
  for (const [id, username] of [[ALICE, 'alice'], [BOB, 'bob'], [CAROL, 'carol'], [EVE, 'eve']]) {
    user.run(id, username, `${username}@test.invalid`, username);
  }
  const org = db.prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?,?,?,0)');
  org.run(ORG_A, 'A', 'a');
  org.run(ORG_B, 'B', 'b');
  const member = db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?,?,?,?,0)');
  member.run('m1', ORG_A, ALICE, 'owner');
  member.run('m2', ORG_A, BOB, 'member');
  member.run('m3', ORG_A, CAROL, 'member');
  member.run('m4', ORG_B, EVE, 'owner');
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-chat-'));
  const saved = process.env.DATABASE_FILE;
  process.env.DATABASE_FILE = path.join(dir, 'chat.db');
  for (const p of ['../../../src/server/db.js', '../../../src/server/chat.js']) {
    delete require.cache[require.resolve(p)];
  }
  try {
    ({db} = require('../../../src/server/db.js'));
    chat = require('../../../src/server/chat.js');
  } finally {
    if (saved === undefined) delete process.env.DATABASE_FILE;
    else process.env.DATABASE_FILE = saved;
  }
});

after(() => {
  try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* already gone */ }
});

beforeEach(() => seed());

describe('createChannel', () => {
  it('creates a channel and joins its author, who would not otherwise see it', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general', topic: 'Everything'});
    assert.equal(channel.name, 'general');
    assert.equal(channel.kind, 'public');
    assert.ok(chat.isChannelMember(channel.id, ALICE), 'the author is a member');
  });

  // `#General` and `#general` are the same channel to a person, so they are the
  // same channel here.
  it('normalizes the name, so case and spacing cannot fork a channel', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: '  Team   Updates '});
    assert.equal(channel.name, 'team-updates');
    assert.equal(chat.createChannel(ORG_A, ALICE, {name: 'TEAM UPDATES'}).error, 'name-taken');
  });

  it('lets the same name exist in a different organization', () => {
    chat.createChannel(ORG_A, ALICE, {name: 'general'});
    assert.ok(chat.createChannel(ORG_B, EVE, {name: 'general'}).channel, 'no collision across tenants');
  });

  const REJECTED = [
    ['an empty name', {name: '   '}, 'invalid-name'],
    ['a missing name', {}, 'invalid-name'],
    ['an over-long name', {name: 'x'.repeat(81)}, 'name-too-long'],
    ['an over-long topic', {name: 'ok', topic: 'x'.repeat(501)}, 'topic-too-long'],
    ['a dm created as if it were a channel', {name: 'ok', kind: 'dm'}, 'invalid-kind'],
    ['an unknown kind', {name: 'ok', kind: 'secret'}, 'invalid-kind'],
  ];
  for (const [name, input, error] of REJECTED) {
    it(`rejects ${name}`, () => {
      assert.equal(chat.createChannel(ORG_A, ALICE, input).error, error);
    });
  }

  it('refuses someone outside the organization', () => {
    assert.equal(chat.createChannel(ORG_A, EVE, {name: 'intrusion'}).error, 'forbidden');
  });
});

describe('visibility', () => {
  it('shows a public channel to any member of the organization', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    assert.ok(chat.visibleChannel(ORG_A, BOB, channel.id), 'bob has not joined but can see it');
  });

  it('hides a private channel from a member who is not in it', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'secret', kind: 'private'});
    assert.equal(chat.visibleChannel(ORG_A, BOB, channel.id), null);
    chat.addMember(ORG_A, ALICE, channel.id, BOB);
    assert.ok(chat.visibleChannel(ORG_A, BOB, channel.id), 'and shows it once invited');
  });

  // Wrong-organization and does-not-exist are the same answer on purpose:
  // telling them apart would confirm that a channel exists.
  it('hides everything from another organization', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    assert.equal(chat.visibleChannel(ORG_B, EVE, channel.id), null);
    assert.equal(chat.visibleChannel(ORG_A, EVE, channel.id), null, 'not even by naming the right org');
  });

  it('lists public channels plus the private ones you are in, and nothing else', () => {
    chat.createChannel(ORG_A, ALICE, {name: 'general'});
    const {channel: secret} = chat.createChannel(ORG_A, ALICE, {name: 'secret', kind: 'private'});
    chat.createChannel(ORG_B, EVE, {name: 'elsewhere'});

    assert.deepEqual(chat.listChannels(ORG_A, BOB).map(c => c.name), ['general']);
    assert.deepEqual(chat.listChannels(ORG_A, ALICE).map(c => c.name), ['general', 'secret']);
    chat.addMember(ORG_A, ALICE, secret.id, BOB);
    assert.deepEqual(chat.listChannels(ORG_A, BOB).map(c => c.name), ['general', 'secret']);
    assert.deepEqual(chat.listChannels(ORG_A, EVE), [], 'an outsider sees nothing');
  });
});

describe('messages', () => {
  let channelId;
  beforeEach(() => {
    channelId = chat.createChannel(ORG_A, ALICE, {name: 'general'}).channel.id;
  });

  it('posts and reads back, oldest first', () => {
    chat.postMessage(ORG_A, ALICE, channelId, 'first');
    chat.joinChannel(ORG_A, BOB, channelId);
    chat.postMessage(ORG_A, BOB, channelId, 'second');
    const {messages} = chat.listMessages(ORG_A, ALICE, channelId);
    assert.deepEqual(messages.map(m => [m.username, m.body]), [['alice', 'first'], ['bob', 'second']]);
  });

  // Seeing a public channel is not the same as being in it, or every message
  // would go to everyone in the organization.
  it('requires membership to post, not just visibility', () => {
    assert.ok(chat.visibleChannel(ORG_A, BOB, channelId), 'bob can see it');
    assert.equal(chat.postMessage(ORG_A, BOB, channelId, 'hi').error, 'not-a-member');
    chat.joinChannel(ORG_A, BOB, channelId);
    assert.ok(chat.postMessage(ORG_A, BOB, channelId, 'hi').message);
  });

  it('refuses an empty or whitespace-only message', () => {
    for (const body of ['', '   ', '\n\t', null, 7]) {
      assert.equal(chat.postMessage(ORG_A, ALICE, channelId, body).error, 'empty', JSON.stringify(body));
    }
  });

  it('refuses a message over the length cap, and accepts one at it', () => {
    assert.equal(chat.postMessage(ORG_A, ALICE, channelId, 'x'.repeat(chat.MAX_BODY + 1)).error, 'too-long');
    assert.ok(chat.postMessage(ORG_A, ALICE, channelId, 'x'.repeat(chat.MAX_BODY)).message);
  });

  it('trims surrounding whitespace', () => {
    const {message} = chat.postMessage(ORG_A, ALICE, channelId, '  hello  ');
    assert.equal(message.body, 'hello');
  });

  it('refuses to post into another organization\'s channel', () => {
    assert.equal(chat.postMessage(ORG_B, EVE, channelId, 'hello').error, 'not-found');
  });

  // The unread count used to be measured against a millisecond timestamp, so a
  // message posted in the same millisecond as a read was silently swallowed.
  it('counts a message posted in the same millisecond as a read', () => {
    chat.joinChannel(ORG_A, BOB, channelId);
    chat.markRead(ORG_A, BOB, channelId);
    chat.postMessage(ORG_A, ALICE, channelId, 'immediately after');
    const unread = chat.listChannels(ORG_A, BOB).find(c => c.id === channelId).unread;
    assert.equal(unread, 1);
  });

  it('gives every message in a channel a distinct, increasing position', () => {
    for (let i = 0; i < 5; i++) chat.postMessage(ORG_A, ALICE, channelId, `m${i}`);
    const seqs = chat.listMessages(ORG_A, ALICE, channelId).messages.map(m => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'increasing');
    assert.equal(new Set(seqs).size, seqs.length, 'and distinct');
  });

  it('rejects a cursor that is not a number', () => {
    assert.equal(chat.listMessages(ORG_A, ALICE, channelId, {before: 'nonsense'}).error, 'invalid-cursor');
  });

  it('pages backwards without skipping or repeating', () => {
    for (let i = 0; i < 10; i++) chat.postMessage(ORG_A, ALICE, channelId, `m${i}`);
    const first = chat.listMessages(ORG_A, ALICE, channelId, {limit: 4});
    assert.equal(first.messages.length, 4);
    assert.equal(first.hasMore, true);
    const second = chat.listMessages(ORG_A, ALICE, channelId, {
      limit: 4, before: first.messages[0].seq,
    });
    const overlap = second.messages.filter(m => first.messages.some(f => f.id === m.id));
    assert.deepEqual(overlap, [], 'the pages do not overlap');
  });

  it('caps an absurd limit rather than reading the whole channel', () => {
    for (let i = 0; i < 5; i++) chat.postMessage(ORG_A, ALICE, channelId, `m${i}`);
    const {messages} = chat.listMessages(ORG_A, ALICE, channelId, {limit: 10_000});
    assert.ok(messages.length <= chat.MAX_LIMIT);
  });

  it('blanks a deleted message but keeps its place', () => {
    const {message} = chat.postMessage(ORG_A, ALICE, channelId, 'regrettable');
    chat.postMessage(ORG_A, ALICE, channelId, 'after');
    assert.ok(chat.deleteMessage(ORG_A, ALICE, message.id).deleted);
    const {messages} = chat.listMessages(ORG_A, ALICE, channelId);
    assert.equal(messages.length, 2, 'the row stays so the thread still reads');
    assert.equal(messages[0].body, null);
    assert.ok(messages[0].deletedAt);
  });

  it('lets you delete only your own messages', () => {
    const {message} = chat.postMessage(ORG_A, ALICE, channelId, 'mine');
    chat.joinChannel(ORG_A, BOB, channelId);
    assert.equal(chat.deleteMessage(ORG_A, BOB, message.id).error, 'forbidden');
    assert.equal(chat.deleteMessage(ORG_B, EVE, message.id).error, 'not-found', 'and not across tenants');
  });
});

describe('direct messages', () => {
  it('creates one channel with both people in it', () => {
    const {channel, created} = chat.openDm(ORG_A, ALICE, BOB);
    assert.equal(created, true);
    assert.equal(channel.kind, 'dm');
    assert.equal(channel.name, null);
    assert.deepEqual(chat.listMembers(channel.id).map(m => m.username).sort(), ['alice', 'bob']);
  });

  // Whoever opens it, and in whichever order, it is the same conversation.
  it('is the same channel from either side, and on reopening', () => {
    const first = chat.openDm(ORG_A, ALICE, BOB);
    const again = chat.openDm(ORG_A, ALICE, BOB);
    const other = chat.openDm(ORG_A, BOB, ALICE);
    assert.equal(again.created, false);
    assert.equal(again.channel.id, first.channel.id);
    assert.equal(other.channel.id, first.channel.id, 'bob opening it finds alice\'s');
  });

  it('keeps separate conversations per pair', () => {
    const ab = chat.openDm(ORG_A, ALICE, BOB).channel.id;
    const ac = chat.openDm(ORG_A, ALICE, CAROL).channel.id;
    assert.notEqual(ab, ac);
  });

  it('is private to its two members', () => {
    const {channel} = chat.openDm(ORG_A, ALICE, BOB);
    assert.ok(chat.visibleChannel(ORG_A, ALICE, channel.id));
    assert.equal(chat.visibleChannel(ORG_A, CAROL, channel.id), null, 'a third party sees nothing');
    assert.equal(chat.postMessage(ORG_A, CAROL, channel.id, 'butting in').error, 'not-found');
  });

  it('refuses someone outside the organization, in either direction', () => {
    assert.equal(chat.openDm(ORG_A, ALICE, EVE).error, 'not-in-organization');
    assert.equal(chat.openDm(ORG_A, EVE, ALICE).error, 'forbidden');
  });

  it('refuses a dm with yourself', () => {
    assert.equal(chat.openDm(ORG_A, ALICE, ALICE).error, 'self-dm');
  });

  it('cannot be left or added to', () => {
    const {channel} = chat.openDm(ORG_A, ALICE, BOB);
    assert.equal(chat.leaveChannel(ORG_A, ALICE, channel.id).error, 'cannot-leave-dm');
    assert.equal(chat.addMember(ORG_A, ALICE, channel.id, CAROL).error, 'cannot-invite-to-dm');
  });
});

// What a client needs to draw a sidebar. A dm has no name, so the person on the
// other side of it has to come back with the row or the list has nothing to
// label it with. The roster of people lives in server/org.js and is tested
// there; this is the channel half.
describe('the channel list a sidebar draws', () => {
  it('names the other side of a dm, from each side', () => {
    const {channel} = chat.openDm(ORG_A, ALICE, BOB);
    const forAlice = chat.listChannels(ORG_A, ALICE).find(c => c.id === channel.id);
    const forBob = chat.listChannels(ORG_A, BOB).find(c => c.id === channel.id);
    assert.equal(forAlice.peerUsername, 'bob');
    assert.equal(forAlice.peerId, BOB);
    assert.equal(forBob.peerUsername, 'alice', 'the peer is whoever is not asking');
  });

  it('leaves the peer fields empty on a named channel', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    const row = chat.listChannels(ORG_A, ALICE).find(c => c.id === channel.id);
    assert.equal(row.peerId, null);
    assert.equal(row.peerUsername, null);
  });

  // The dm join must widen each channel row, never multiply it: a list that
  // repeated #general once per member would be a sidebar full of duplicates.
  it('returns one row per channel however many members it has', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    chat.joinChannel(ORG_A, BOB, channel.id);
    chat.joinChannel(ORG_A, CAROL, channel.id);
    const rows = chat.listChannels(ORG_A, ALICE).filter(c => c.id === channel.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].memberCount, 3);
  });

});

// Renaming, archiving, deleting, and turning people out of a channel. Who may
// do these is two rules: the caller manages the organization, which the route
// decides and passes in as `manages`, or they opened the channel themselves.
describe('administering a channel', () => {
  const AS_MANAGER = {manages: true};
  let channelId;
  beforeEach(() => {
    // Alice opens it, so she is its creator and Bob is an ordinary member.
    channelId = chat.createChannel(ORG_A, ALICE, {name: 'general', topic: 'Everything'}).channel.id;
    chat.joinChannel(ORG_A, BOB, channelId);
  });

  it('lets the creator rename it and set its topic, one without the other', () => {
    assert.equal(chat.updateChannel(ORG_A, ALICE, channelId, {name: 'Team Updates'}).channel.name, 'team-updates');
    assert.equal(
      chat.updateChannel(ORG_A, ALICE, channelId, {topic: 'Only the good news'}).channel.topic,
      'Only the good news',
    );
    const after = chat.listChannels(ORG_A, ALICE).find(c => c.id === channelId);
    assert.equal(after.name, 'team-updates', 'setting a topic did not rename it');
  });

  it('clears the topic when given an empty one, and leaves it alone when given nothing', () => {
    assert.equal(chat.updateChannel(ORG_A, ALICE, channelId, {topic: '   '}).channel.topic, null);
    chat.updateChannel(ORG_A, ALICE, channelId, {topic: 'Back'});
    assert.equal(chat.updateChannel(ORG_A, ALICE, channelId, {name: 'renamed'}).channel.topic, 'Back');
  });

  const REJECTED_EDITS = [
    ['an empty name', {name: '  '}, 'invalid-name'],
    ['an over-long name', {name: 'x'.repeat(81)}, 'name-too-long'],
    ['an over-long topic', {topic: 'x'.repeat(501)}, 'topic-too-long'],
  ];
  for (const [name, changes, error] of REJECTED_EDITS) {
    it(`rejects ${name}`, () => {
      assert.equal(chat.updateChannel(ORG_A, ALICE, channelId, changes).error, error);
    });
  }

  it('refuses a rename onto a name already in use, but not onto its own', () => {
    chat.createChannel(ORG_A, ALICE, {name: 'design'});
    assert.equal(chat.updateChannel(ORG_A, ALICE, channelId, {name: 'design'}).error, 'name-taken');
    assert.ok(chat.updateChannel(ORG_A, ALICE, channelId, {name: 'general'}).channel, 'renaming to what it is called is not a clash');
  });

  it('refuses an ordinary member, and allows one who manages the organization', () => {
    assert.equal(chat.updateChannel(ORG_A, BOB, channelId, {name: 'bobs'}).error, 'not-channel-admin');
    assert.equal(chat.setArchived(ORG_A, BOB, channelId, true).error, 'not-channel-admin');
    assert.ok(chat.updateChannel(ORG_A, BOB, channelId, {name: 'bobs'}, AS_MANAGER).channel);
  });

  it('archives, hides it from the list, and brings it back', () => {
    assert.equal(chat.setArchived(ORG_A, ALICE, channelId, true).changed, true);
    assert.equal(chat.listChannels(ORG_A, ALICE).some(c => c.id === channelId), false, 'out of the way');
    assert.equal(
      chat.listChannels(ORG_A, ALICE, {includeArchived: true}).some(c => c.id === channelId), true,
      'and still there for the view that restores it',
    );
    assert.equal(chat.setArchived(ORG_A, ALICE, channelId, true).changed, false, 'already archived');
    assert.equal(chat.setArchived(ORG_A, ALICE, channelId, false).changed, true);
    assert.equal(chat.listChannels(ORG_A, ALICE).some(c => c.id === channelId), true);
  });

  // Archiving is meant to be the safe half of removing a channel, which it is
  // only if what was said in it survives.
  it('keeps every message through an archive and back', () => {
    chat.postMessage(ORG_A, ALICE, channelId, 'before');
    chat.setArchived(ORG_A, ALICE, channelId, true);
    assert.equal(chat.listMessages(ORG_A, BOB, channelId).messages.length, 1, 'still readable while archived');
    chat.setArchived(ORG_A, ALICE, channelId, false);
    assert.equal(chat.listMessages(ORG_A, BOB, channelId).messages.length, 1);
  });

  it('is read-only while archived, for its creator as much as anyone', () => {
    chat.setArchived(ORG_A, ALICE, channelId, true);
    assert.equal(chat.postMessage(ORG_A, BOB, channelId, 'hello?').error, 'archived');
    assert.equal(chat.postMessage(ORG_A, ALICE, channelId, 'hello?').error, 'archived');
  });

  // Deleting takes other people's messages with it, so creating the channel is
  // not enough: it takes standing in the organization.
  it('is deleted only by someone who manages the organization, creator or not', () => {
    chat.postMessage(ORG_A, BOB, channelId, 'mine');
    assert.equal(chat.deleteChannel(ORG_A, ALICE, channelId).error, 'not-org-admin', 'not even its author');
    const {deleted} = chat.deleteChannel(ORG_A, ALICE, channelId, AS_MANAGER);
    assert.deepEqual([deleted.name, deleted.messages], ['general', 1], 'and it says what it took');
    assert.equal(chat.visibleChannel(ORG_A, ALICE, channelId), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message WHERE channelId = ?').get(channelId).n, 0);
  });

  it('turns someone out of a channel, but points you at leaving for yourself', () => {
    assert.equal(chat.removeChannelMember(ORG_A, ALICE, channelId, BOB).removed, true);
    assert.equal(chat.isChannelMember(channelId, BOB), false);
    assert.equal(chat.removeChannelMember(ORG_A, ALICE, channelId, BOB).removed, false, 'already out');
    assert.equal(chat.removeChannelMember(ORG_A, ALICE, channelId, ALICE).error, 'leave-instead');
  });

  // The changes that outlast the moment are written down, in the same log as
  // the membership ones. A deleted channel leaves nothing else behind.
  it('records the rename, the archive, and the deletion, but not a topic', () => {
    const events = () => db
      .prepare('SELECT action, actorLabel, targetLabel, detail FROM org_audit ORDER BY at, rowid')
      .all()
      .map(e => [e.action, e.actorLabel, e.targetLabel, e.detail && JSON.parse(e.detail)]);

    chat.updateChannel(ORG_A, ALICE, channelId, {topic: 'Nothing to see'});
    assert.deepEqual(events(), [], 'a reworded topic is not an event');

    chat.updateChannel(ORG_A, ALICE, channelId, {name: 'launch'});
    chat.setArchived(ORG_A, ALICE, channelId, true);
    chat.setArchived(ORG_A, ALICE, channelId, false);
    chat.postMessage(ORG_A, ALICE, channelId, 'one for the count');
    chat.deleteChannel(ORG_A, ALICE, channelId, AS_MANAGER);

    assert.deepEqual(events(), [
      ['channel.rename', 'alice', '#launch', {from: 'general', to: 'launch'}],
      ['channel.archive', 'alice', '#launch', null],
      ['channel.unarchive', 'alice', '#launch', null],
      ['channel.delete', 'alice', '#launch', {messages: 1, kind: 'public'}],
    ]);
  });

  it('refuses every one of these on a dm, which nobody administers', () => {
    const dm = chat.openDm(ORG_A, ALICE, BOB).channel.id;
    assert.equal(chat.updateChannel(ORG_A, ALICE, dm, {name: 'nope'}, AS_MANAGER).error, 'not-a-channel');
    assert.equal(chat.setArchived(ORG_A, ALICE, dm, true, AS_MANAGER).error, 'not-a-channel');
    assert.equal(chat.deleteChannel(ORG_A, ALICE, dm, AS_MANAGER).error, 'not-a-channel');
    assert.equal(chat.removeChannelMember(ORG_A, ALICE, dm, BOB, AS_MANAGER).error, 'not-a-channel');
  });

  it('refuses everything to another organization, which cannot see the channel at all', () => {
    for (const attempt of [
      () => chat.updateChannel(ORG_B, EVE, channelId, {name: 'ours-now'}, AS_MANAGER),
      () => chat.setArchived(ORG_B, EVE, channelId, true, AS_MANAGER),
      () => chat.deleteChannel(ORG_B, EVE, channelId, AS_MANAGER),
      () => chat.removeChannelMember(ORG_B, EVE, channelId, ALICE, AS_MANAGER),
    ]) {
      assert.equal(attempt().error, 'not-found');
    }
    assert.ok(chat.visibleChannel(ORG_A, ALICE, channelId), 'and the channel is untouched');
  });
});

describe('joining and leaving', () => {
  it('joins a public channel, idempotently', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    assert.equal(chat.joinChannel(ORG_A, BOB, channel.id).joined, true);
    assert.equal(chat.joinChannel(ORG_A, BOB, channel.id).joined, false, 'already in');
  });

  it('will not join a private channel', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'secret', kind: 'private'});
    // Invisible to a non-member, so this reads as not-found rather than
    // not-joinable: bob has no way to learn the channel is there.
    assert.equal(chat.joinChannel(ORG_A, BOB, channel.id).error, 'not-found');
  });

  it('leaves, and stops seeing a private channel afterwards', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'secret', kind: 'private'});
    chat.addMember(ORG_A, ALICE, channel.id, BOB);
    assert.equal(chat.leaveChannel(ORG_A, BOB, channel.id).left, true);
    assert.equal(chat.visibleChannel(ORG_A, BOB, channel.id), null);
  });

  it('only lets a current member invite others', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'secret', kind: 'private'});
    assert.equal(chat.addMember(ORG_A, BOB, channel.id, CAROL).error, 'not-found', 'bob is not in it');
    assert.equal(chat.addMember(ORG_A, ALICE, channel.id, EVE).error, 'not-in-organization');
    assert.equal(chat.addMember(ORG_A, ALICE, channel.id, CAROL).added, true);
  });
});

describe('unread counts', () => {
  it('counts other people\'s messages, not your own', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    chat.joinChannel(ORG_A, BOB, channel.id);
    chat.postMessage(ORG_A, ALICE, channel.id, 'one');
    chat.postMessage(ORG_A, ALICE, channel.id, 'two');

    const forBob = chat.listChannels(ORG_A, BOB).find(c => c.id === channel.id);
    assert.equal(forBob.unread, 2);
    const forAlice = chat.listChannels(ORG_A, ALICE).find(c => c.id === channel.id);
    assert.equal(forAlice.unread, 0, 'posting counts as reading');
  });

  it('clears on read, and does not count deleted messages', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    chat.joinChannel(ORG_A, BOB, channel.id);
    const {message} = chat.postMessage(ORG_A, ALICE, channel.id, 'one');
    chat.markRead(ORG_A, BOB, channel.id);
    assert.equal(chat.listChannels(ORG_A, BOB).find(c => c.id === channel.id).unread, 0);

    chat.postMessage(ORG_A, ALICE, channel.id, 'two');
    assert.equal(chat.listChannels(ORG_A, BOB).find(c => c.id === channel.id).unread, 1);
    chat.deleteMessage(ORG_A, ALICE, message.id);
    assert.equal(chat.listChannels(ORG_A, BOB).find(c => c.id === channel.id).unread, 1, 'the deleted one never counted');
  });
});

describe('cascades', () => {
  it('takes channels, membership and messages with a deleted organization', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    chat.postMessage(ORG_A, ALICE, channel.id, 'hello');
    db.prepare('DELETE FROM organization WHERE id = ?').run(ORG_A);

    const count = t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    assert.equal(count('channel'), 0);
    assert.equal(count('channel_member'), 0);
    assert.equal(count('message'), 0);
  });

  it('takes messages and membership with a deleted channel', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    chat.postMessage(ORG_A, ALICE, channel.id, 'hello');
    db.prepare('DELETE FROM channel WHERE id = ?').run(channel.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_member').get().n, 0);
  });

  // Messages restrict rather than cascade: a conversation with the replies
  // silently removed is worse than one attributed to a departed account, so
  // deleting a user who has spoken has to be a decision, not an accident.
  it('refuses to delete a user who has posted', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    chat.postMessage(ORG_A, ALICE, channel.id, 'hello');
    assert.throws(() => db.prepare('DELETE FROM "user" WHERE id = ?').run(ALICE), /FOREIGN KEY/);
  });

  // createdBy used to cascade, so this deletion quietly removed #general and
  // every message in it, including everyone else's.
  it('keeps a channel, and its messages, when its author is deleted', () => {
    const {channel} = chat.createChannel(ORG_A, ALICE, {name: 'general'});
    chat.joinChannel(ORG_A, BOB, channel.id);
    chat.postMessage(ORG_A, BOB, channel.id, 'still here');
    // Hand the channel to Carol, who has never posted, then delete her. Alice
    // could not be deleted here: she has posted, and message.userId restricts.
    db.prepare('UPDATE channel SET createdBy = ? WHERE id = ?').run(CAROL, channel.id);
    db.prepare('DELETE FROM "user" WHERE id = ?').run(CAROL);

    const row = db.prepare('SELECT createdBy FROM channel WHERE id = ?').get(channel.id);
    assert.ok(row, 'the channel survives its author');
    assert.equal(row.createdBy, null, 'and simply loses the attribution');
    assert.equal(chat.listMessages(ORG_A, BOB, channel.id).messages.length, 1, 'messages intact');
  });
});
