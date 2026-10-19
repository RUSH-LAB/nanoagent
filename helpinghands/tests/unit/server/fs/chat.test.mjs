import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {as, migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {createFsChat} = require('../../../../src/server/fs/chat.js');

describe('chat as files', () => {
  let db;
  let fs;
  let chat;

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    fs = createPostgresFs({pool: database.pool});
    chat = createFsChat({fs});
  });
  after(() => db?.close());

  it('provisions the first channel for the owner and joins every member', async () => {
    await chat.provisionMember('lab', 'alice', {isOwner: true, name: 'general', topic: 'Everything'});
    await chat.provisionMember('lab', 'vic', {isOwner: false, name: 'general', topic: 'Everything'});
    const channels = await chat.listChannels('lab', 'vic');
    assert.deepEqual(channels.map(channel => [channel.name, channel.joined, channel.memberCount]), [['general', true, 2]]);
  });

  it('lets any member post, viewers included, in order', async () => {
    const [general] = await chat.listChannels('lab', 'alice');
    const first = await chat.postMessage('lab', 'vic', general.id, 'hello from a viewer');
    const second = await chat.postMessage('lab', 'alice', general.id, 'hi vic');
    assert.deepEqual([first.message.seq, second.message.seq], [1, 2]);
    const {messages} = await chat.listMessages('lab', 'alice', general.id);
    assert.deepEqual(messages.map(message => [message.body, message.username]), [['hello from a viewer', 'Vic'], ['hi vic', 'Alice']]);
    assert.ok(await fs.stat(as('alice'), `.chat/${general.id}/messages/000000000001-vic.json`));
  });

  it('counts unread messages until they are read', async () => {
    const [general] = await chat.listChannels('lab', 'vic');
    assert.equal(general.unread, 1);
    await chat.markRead('lab', 'vic', general.id);
    assert.equal((await chat.listChannels('lab', 'vic'))[0].unread, 0);
  });

  it('keeps a private channel to its members, and leaving hides it', async () => {
    const {channel} = await chat.createChannel('lab', 'bob', {name: 'Secret Plans', kind: 'private'});
    assert.equal(channel.name, 'secret-plans');
    assert.equal(await chat.visibleChannel('lab', 'alice', channel.id), null);
    await chat.addMember('lab', 'bob', channel.id, 'alice');
    assert.ok(await chat.visibleChannel('lab', 'alice', channel.id));
    await chat.postMessage('lab', 'alice', channel.id, 'in the room');
    assert.equal(await fs.stat(as('vic'), `.chat/${channel.id}/channel.json`), null);
    await chat.leaveChannel('lab', 'bob', channel.id);
    assert.equal(await chat.visibleChannel('lab', 'bob', channel.id), null);
    assert.ok(await chat.visibleChannel('lab', 'alice', channel.id));
  });

  it('refuses a channel name that is taken', async () => {
    assert.deepEqual(await chat.createChannel('lab', 'alice', {name: 'general'}), {error: 'name-taken'});
  });

  it('opens one direct message per pair, seen by the pair alone', async () => {
    const opened = await chat.openDm('lab', 'alice', 'bob');
    const again = await chat.openDm('lab', 'bob', 'alice');
    assert.equal(opened.created, true);
    assert.equal(again.channel.id, opened.channel.id);
    await chat.postMessage('lab', 'bob', opened.channel.id, 'just us');
    assert.equal(await chat.visibleChannel('lab', 'vic', opened.channel.id), null);
    const dm = (await chat.listChannels('lab', 'alice')).find(channel => channel.kind === 'dm');
    assert.equal(dm.peerId, 'bob');
    assert.equal(dm.unread, 1);
  });

  it('deletes a message as a tombstone its author alone may leave', async () => {
    const [general] = await chat.listChannels('lab', 'alice');
    const posted = await chat.postMessage('lab', 'alice', general.id, 'oops');
    assert.deepEqual(await chat.deleteMessage('lab', 'vic', posted.message.id), {error: 'forbidden'});
    assert.deepEqual(await chat.deleteMessage('lab', 'alice', posted.message.id), {deleted: true, channelId: general.id});
    const {messages} = await chat.listMessages('lab', 'alice', general.id);
    assert.equal(messages.at(-1).body, null);
    assert.ok(messages.at(-1).deletedAt);
  });

  it('pages back through older messages', async () => {
    const [general] = await chat.listChannels('lab', 'alice');
    const page = await chat.listMessages('lab', 'alice', general.id, {limit: 2});
    assert.equal(page.messages.length, 2);
    assert.equal(page.hasMore, true);
    const older = await chat.listMessages('lab', 'alice', general.id, {before: page.messages[0].seq, limit: 2});
    assert.ok(older.messages.every(message => message.seq < page.messages[0].seq));
  });

  it('takes a member who leaves the workspace out of every channel', async () => {
    await chat.removeMember('lab', 'alice');
    const remaining = (await chat.listChannels('lab', 'bob')).filter(channel => channel.joined);
    for (const channel of remaining) {
      const members = await chat.listMembers(channel.id, 'lab', 'bob');
      assert.ok(!members.some(member => member.id === 'alice'));
    }
  });
});
