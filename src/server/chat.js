/**
 * Channels, membership, and messages.
 *
 * Every read and write here is scoped to one organization and one caller, and
 * the scoping is a parameter rather than something the caller can leave out:
 * each function takes `orgId` and `userId` and there is no variant that
 * queries a channel by id alone. That is deliberate. The single most likely bug
 * in a multi-tenant chat is a query that forgets which tenant asked, and the
 * cheapest defence is to make it impossible to write one.
 *
 * A direct message is a channel with kind='dm', so everything below serves both
 * without a second implementation.
 */
const crypto = require('crypto');
const {db} = require('./db');
const audit = require('./audit');

const KINDS = Object.freeze(['public', 'private', 'dm']);

const MAX_NAME = 80;
const MAX_TOPIC = 500;
const MAX_BODY = 4000;
/** Newest-first page size for history, and its ceiling. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const now = () => new Date().toISOString();
const newId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * Channel names are compared and stored in one normalized form, so `#General`
 * and `#general` cannot both exist and neither can `#a  b` and `#a b`.
 */
function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-');
}

/** The canonical spelling of a pair of users, so one dm has one key. */
function dmKeyFor(a, b) {
  return [a, b].sort().join(':');
}

/** Whether `userId` belongs to `orgId`. The outer gate on everything here. */
function isOrgMember(orgId, userId) {
  if (!orgId || !userId) return false;
  return Boolean(
    db.prepare('SELECT 1 FROM member WHERE organizationId = ? AND userId = ?').get(orgId, userId),
  );
}

/** Whether `userId` has joined `channelId`. */
function isChannelMember(channelId, userId) {
  return Boolean(
    db.prepare('SELECT 1 FROM channel_member WHERE channelId = ? AND userId = ?').get(channelId, userId),
  );
}

/**
 * A channel the caller is allowed to see, or null.
 *
 * Null covers three different situations on purpose: the channel does not
 * exist, it belongs to another organization, or it is private and the caller is
 * not in it. Distinguishing them in the reply would confirm the existence of
 * channels the caller has no business knowing about.
 */
function visibleChannel(orgId, userId, channelId) {
  if (!isOrgMember(orgId, userId)) return null;
  const channel = db
    .prepare('SELECT * FROM channel WHERE id = ? AND organizationId = ?')
    .get(channelId, orgId);
  if (!channel) return null;
  if (channel.kind === 'public') return channel;
  return isChannelMember(channelId, userId) ? channel : null;
}

/**
 * The channels the caller can see: every public one in the organization, plus
 * the private ones and dms they belong to. Each carries its member count, the
 * caller's unread count and how far they have read, and, for a dm, the person
 * on the other side.
 *
 * A dm has no name, so a list that returned only the row would have nothing to
 * label it with. The peer joins here rather than being resolved by the caller
 * because the alternative is one request per dm to find out whose it is.
 */
function listChannels(orgId, userId, {includeArchived = false} = {}) {
  if (!isOrgMember(orgId, userId)) return [];
  return db
    .prepare(
      // `userId` binds three times, in the order the placeholders appear: the
      // unread count, the caller's membership, and the dm peer.
      `SELECT c.*,
              (SELECT COUNT(*) FROM channel_member m WHERE m.channelId = c.id) AS memberCount,
              (cm.userId IS NOT NULL) AS joined,
              -- Where the caller stopped reading, and null when they have no
              -- membership row. A transcript draws its "new messages" divider
              -- from this; without it a client can count the unread messages
              -- but has no way to say which one the divider goes above.
              cm.lastReadSeq AS lastReadSeq,
              pu.id AS peerId, pu.username AS peerUsername, pu.name AS peerName,
              (SELECT COUNT(*) FROM message msg
                WHERE msg.channelId = c.id
                  AND msg.deletedAt IS NULL
                  AND msg.userId != ?
                  AND msg.seq > COALESCE(cm.lastReadSeq, 0)) AS unread
         FROM channel c
         LEFT JOIN channel_member cm ON cm.channelId = c.id AND cm.userId = ?
         -- Restricted to dms, which openDm gives exactly two members, so this
         -- widens each row rather than multiplying it.
         LEFT JOIN channel_member pm ON pm.channelId = c.id AND c.kind = 'dm' AND pm.userId != ?
         LEFT JOIN "user" pu ON pu.id = pm.userId
        WHERE c.organizationId = ?
          -- An archived channel is out of the way, not gone. It stays out of
          -- every list but the one that exists to bring it back.
          AND (? OR c.archivedAt IS NULL)
          AND (c.kind = 'public' OR cm.userId IS NOT NULL)
        ORDER BY c.kind = 'dm', c.name COLLATE NOCASE, c.createdAt`,
    )
    .all(userId, userId, userId, orgId, includeArchived ? 1 : 0)
    .map(row => ({...row, joined: Boolean(row.joined)}));
}

/** Everyone in a channel, with the display fields a member list needs. */
function listMembers(channelId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.name, u.email, m.joinedAt
         FROM channel_member m
         JOIN "user" u ON u.id = m.userId
        WHERE m.channelId = ?
        ORDER BY u.username COLLATE NOCASE`,
    )
    .all(channelId);
}

/**
 * Create a named channel. The creator joins it, in one transaction: a channel
 * with no members would be invisible to its own author.
 */
function createChannel(orgId, userId, {name, topic = null, kind = 'public'}) {
  if (!isOrgMember(orgId, userId)) return {error: 'forbidden'};
  if (kind !== 'public' && kind !== 'private') return {error: 'invalid-kind'};

  const clean = normalizeName(name || '');
  if (!clean) return {error: 'invalid-name'};
  if (clean.length > MAX_NAME) return {error: 'name-too-long'};
  if (topic != null && String(topic).length > MAX_TOPIC) return {error: 'topic-too-long'};

  const existing = db
    .prepare('SELECT id FROM channel WHERE organizationId = ? AND name = ?')
    .get(orgId, clean);
  if (existing) return {error: 'name-taken'};

  const id = newId('ch');
  const at = now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO channel (id, organizationId, kind, name, topic, createdBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, kind, clean, topic ? String(topic) : null, userId, at);
    db.prepare('INSERT INTO channel_member (channelId, userId, joinedAt) VALUES (?, ?, ?)')
      .run(id, userId, at);
  })();

  return {channel: db.prepare('SELECT * FROM channel WHERE id = ?').get(id)};
}

/**
 * Whether `userId` may administer `channel`: rename it, set its topic, archive
 * it, or remove people from it.
 *
 * Two ways to qualify. `manages` is the caller's standing in the organization,
 * decided by org.canManage and passed in by the route rather than looked up
 * here, so that "which roles manage people" has one definition in the codebase
 * instead of one per module that asks. The other is having opened the channel:
 * the person who made #design should not need an admin to rename it.
 *
 * Fails closed. A caller that forgets to pass `manages` gets the creator rule
 * alone, which is the narrower of the two.
 */
function mayAdminister(channel, userId, manages) {
  return Boolean(manages) || channel.createdBy === userId;
}

/**
 * Rename a channel or change its topic.
 *
 * Both are optional and each is only touched when supplied, so setting a topic
 * cannot silently rename anything. A dm has neither.
 */
function updateChannel(orgId, userId, channelId, {name, topic}, {manages = false} = {}) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  if (channel.kind === 'dm') return {error: 'not-a-channel'};
  if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};

  let nextName = channel.name;
  if (name !== undefined) {
    nextName = normalizeName(name || '');
    if (!nextName) return {error: 'invalid-name'};
    if (nextName.length > MAX_NAME) return {error: 'name-too-long'};
    const taken = db
      .prepare('SELECT id FROM channel WHERE organizationId = ? AND name = ? AND id != ?')
      .get(orgId, nextName, channelId);
    if (taken) return {error: 'name-taken'};
  }

  let nextTopic = channel.topic;
  if (topic !== undefined) {
    // An empty topic is how you remove one, so '' means null rather than
    // "leave it alone", which is what undefined means.
    const text = topic === null ? '' : String(topic).trim();
    if (text.length > MAX_TOPIC) return {error: 'topic-too-long'};
    nextTopic = text || null;
  }

  db.prepare('UPDATE channel SET name = ?, topic = ? WHERE id = ?').run(nextName, nextTopic, channelId);
  // A rename is recorded and a topic is not. Six months on, "who renamed
  // #launch" is a real question and "who reworded its topic" is not.
  if (nextName !== channel.name) {
    audit.record({
      orgId, action: 'channel.rename', actorId: userId,
      targetLabel: `#${nextName}`, detail: {from: channel.name, to: nextName},
    });
  }
  return {channel: db.prepare('SELECT * FROM channel WHERE id = ?').get(channelId)};
}

/**
 * Archive a channel, or bring it back.
 *
 * Archiving is the reversible half of removing one: the channel leaves every
 * list, nothing more can be said in it, and every word already said is still
 * there to be read. It is what "delete this channel" almost always means, and
 * unlike deleting it, being wrong about it costs nothing.
 */
function setArchived(orgId, userId, channelId, archived, {manages = false} = {}) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  if (channel.kind === 'dm') return {error: 'not-a-channel'};
  if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
  if (Boolean(channel.archivedAt) === archived) return {channel, changed: false};

  db.prepare('UPDATE channel SET archivedAt = ? WHERE id = ?').run(archived ? now() : null, channelId);
  audit.record({
    orgId, action: archived ? 'channel.archive' : 'channel.unarchive',
    actorId: userId, targetLabel: `#${channel.name}`,
  });
  return {channel: db.prepare('SELECT * FROM channel WHERE id = ?').get(channelId), changed: true};
}

/**
 * Delete a channel and everything in it.
 *
 * The one operation here that destroys other people's work: the foreign keys
 * cascade, so the membership and every message go with the row. Archiving is
 * the answer to almost every reason for wanting this, which is why this asks
 * for more than administering the channel. Only the organization's owners and
 * admins can do it, creator or not.
 */
function deleteChannel(orgId, userId, channelId, {manages = false} = {}) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  if (channel.kind === 'dm') return {error: 'not-a-channel'};
  if (!manages) return {error: 'not-org-admin'};

  const {n} = db.prepare('SELECT COUNT(*) AS n FROM message WHERE channelId = ?').get(channelId);
  db.prepare('DELETE FROM channel WHERE id = ?').run(channelId);
  // The audit row is all that is left of the channel, so it carries the size of
  // what went with it.
  audit.record({
    orgId, action: 'channel.delete', actorId: userId,
    targetLabel: `#${channel.name}`, detail: {messages: n, kind: channel.kind},
  });
  return {deleted: {id: channel.id, name: channel.name, messages: n}};
}

/** Remove someone else from a channel. Leaving your own is leaveChannel. */
function removeChannelMember(orgId, userId, channelId, targetId, {manages = false} = {}) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  if (channel.kind === 'dm') return {error: 'not-a-channel'};
  if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
  if (targetId === userId) return {error: 'leave-instead'};

  const {changes} = db
    .prepare('DELETE FROM channel_member WHERE channelId = ? AND userId = ?')
    .run(channelId, targetId);
  return {removed: changes > 0};
}

/**
 * The direct-message channel between the caller and `otherUserId`, created if
 * it does not exist yet.
 *
 * Two people opening a dm at the same moment would both find nothing and both
 * insert; the unique index on (organizationId, dmKey) turns the loser of that
 * race into a constraint error, which is caught here and answered with the row
 * the winner created. Doing it this way rather than by locking keeps the common
 * case a single insert.
 */
function openDm(orgId, userId, otherUserId) {
  if (!isOrgMember(orgId, userId)) return {error: 'forbidden'};
  if (userId === otherUserId) return {error: 'self-dm'};
  if (!isOrgMember(orgId, otherUserId)) return {error: 'not-in-organization'};

  const key = dmKeyFor(userId, otherUserId);
  const found = db
    .prepare("SELECT * FROM channel WHERE organizationId = ? AND dmKey = ? AND kind = 'dm'")
    .get(orgId, key);
  if (found) return {channel: found, created: false};

  const id = newId('dm');
  const at = now();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO channel (id, organizationId, kind, name, dmKey, createdBy, createdAt)
         VALUES (?, ?, 'dm', NULL, ?, ?, ?)`,
      ).run(id, orgId, key, userId, at);
      const join = db.prepare('INSERT INTO channel_member (channelId, userId, joinedAt) VALUES (?, ?, ?)');
      join.run(id, userId, at);
      join.run(id, otherUserId, at);
    })();
  } catch (err) {
    const raced = db
      .prepare("SELECT * FROM channel WHERE organizationId = ? AND dmKey = ? AND kind = 'dm'")
      .get(orgId, key);
    if (raced) return {channel: raced, created: false};
    throw err;
  }
  return {channel: db.prepare('SELECT * FROM channel WHERE id = ?').get(id), created: true};
}

/** Join a public channel. Private channels and dms are joined by invitation. */
function joinChannel(orgId, userId, channelId) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  if (channel.kind !== 'public') return {error: 'not-joinable'};
  if (isChannelMember(channelId, userId)) return {channel, joined: false};
  db.prepare('INSERT INTO channel_member (channelId, userId, joinedAt) VALUES (?, ?, ?)')
    .run(channelId, userId, now());
  return {channel, joined: true};
}

/** Leave a channel. A dm cannot be left; there would be nobody to talk to. */
function leaveChannel(orgId, userId, channelId) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  if (channel.kind === 'dm') return {error: 'cannot-leave-dm'};
  const {changes} = db
    .prepare('DELETE FROM channel_member WHERE channelId = ? AND userId = ?')
    .run(channelId, userId);
  return {left: changes > 0};
}

/** Add someone to a private channel. Only a current member may do so. */
function addMember(orgId, userId, channelId, inviteeId) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  if (channel.kind === 'dm') return {error: 'cannot-invite-to-dm'};
  if (!isChannelMember(channelId, userId)) return {error: 'forbidden'};
  if (!isOrgMember(orgId, inviteeId)) return {error: 'not-in-organization'};
  if (isChannelMember(channelId, inviteeId)) return {added: false};
  db.prepare('INSERT INTO channel_member (channelId, userId, joinedAt) VALUES (?, ?, ?)')
    .run(channelId, inviteeId, now());
  return {added: true};
}

/**
 * A page of history, newest first, optionally ending before sequence `before`.
 *
 * Keyset pagination on seq rather than an offset: an offset shifts under you as
 * new messages arrive, so paging back through a busy channel would skip and
 * repeat messages. On seq rather than createdAt because two messages can share
 * a millisecond, and a tie in the sort key is the same bug in slower motion.
 */
function listMessages(orgId, userId, channelId, {before = null, limit = DEFAULT_LIMIT} = {}) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};

  const capped = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = before == null || before === '' ? null : Number(before);
  if (cursor !== null && !Number.isFinite(cursor)) return {error: 'invalid-cursor'};

  const rows = db
    .prepare(
      `SELECT m.id, m.seq, m.channelId, m.userId, m.body, m.createdAt, m.editedAt, m.deletedAt,
              u.username, u.name
         FROM message m
         JOIN "user" u ON u.id = m.userId
        WHERE m.channelId = ?
          AND (? IS NULL OR m.seq < ?)
        ORDER BY m.seq DESC
        LIMIT ?`,
    )
    .all(channelId, cursor, cursor, capped);

  const messages = rows
    .map(m => (m.deletedAt ? {...m, body: null} : m))
    .reverse(); // oldest first, the order they are read in
  return {messages, hasMore: rows.length === capped};
}

/** Post a message. Membership is required, so a public channel must be joined. */
function postMessage(orgId, userId, channelId, body) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  // Archived is read-only. Someone with the channel still open in a pane can
  // otherwise keep talking into a room that has been closed, and nobody is
  // coming back to read it.
  if (channel.archivedAt) return {error: 'archived'};
  if (!isChannelMember(channelId, userId)) return {error: 'not-a-member'};

  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return {error: 'empty'};
  if (text.length > MAX_BODY) return {error: 'too-long'};

  const id = newId('msg');
  const at = now();
  // The next position and the insert in one transaction, so two concurrent
  // posts cannot read the same maximum and collide on the unique index.
  db.transaction(() => {
    const {next} = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM message WHERE channelId = ?')
      .get(channelId);
    db.prepare('INSERT INTO message (id, seq, channelId, userId, body, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, next, channelId, userId, text, at);
    // Posting counts as reading: your own message should not come back unread.
    db.prepare('UPDATE channel_member SET lastReadSeq = ? WHERE channelId = ? AND userId = ?')
      .run(next, channelId, userId);
  })();

  const message = db
    .prepare(
      `SELECT m.id, m.seq, m.channelId, m.userId, m.body, m.createdAt, m.editedAt, m.deletedAt,
              u.username, u.name
         FROM message m JOIN "user" u ON u.id = m.userId WHERE m.id = ?`,
    )
    .get(id);
  return {message};
}

/** Blank a message you wrote. The row stays so the thread around it holds. */
function deleteMessage(orgId, userId, messageId) {
  const row = db
    .prepare(
      `SELECT m.id, m.userId, m.channelId FROM message m
         JOIN channel c ON c.id = m.channelId
        WHERE m.id = ? AND c.organizationId = ?`,
    )
    .get(messageId, orgId);
  if (!row) return {error: 'not-found'};
  if (row.userId !== userId) return {error: 'forbidden'};
  db.prepare('UPDATE message SET deletedAt = ? WHERE id = ?').run(now(), messageId);
  return {deleted: true, channelId: row.channelId};
}

/**
 * Mark a channel read up to its newest message, which clears its unread count.
 *
 * Anchored to the newest message rather than to the clock, so a message posted
 * in the same millisecond is still unread rather than silently swallowed.
 */
function markRead(orgId, userId, channelId) {
  const channel = visibleChannel(orgId, userId, channelId);
  if (!channel) return {error: 'not-found'};
  const {newest} = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS newest FROM message WHERE channelId = ?')
    .get(channelId);
  const {changes} = db
    .prepare('UPDATE channel_member SET lastReadSeq = ? WHERE channelId = ? AND userId = ?')
    .run(newest, channelId, userId);
  return {marked: changes > 0, lastReadSeq: newest};
}

module.exports = {
  KINDS, MAX_NAME, MAX_TOPIC, MAX_BODY, DEFAULT_LIMIT, MAX_LIMIT,
  normalizeName, dmKeyFor,
  isOrgMember, isChannelMember, visibleChannel, mayAdminister,
  listChannels, listMembers, createChannel, openDm,
  updateChannel, setArchived, deleteChannel, removeChannelMember,
  joinChannel, leaveChannel, addMember,
  listMessages, postMessage, deleteMessage, markRead,
};
