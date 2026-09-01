const crypto = require('crypto');
const {withRequestContext} = require('./client');

const KINDS = Object.freeze(['public', 'private', 'dm']);
const MAX_NAME = 80;
const MAX_TOPIC = 500;
const MAX_BODY = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const normalizeName = name => String(name).trim().toLowerCase().replace(/\s+/g, '-');
const dmKeyFor = (a, b) => [a, b].sort().join(':');

function createPostgresChat({pool, now = () => new Date().toISOString(), newId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`}) {
  const run = (workspaceId, userId, operation) => withRequestContext(pool, {workspaceId, userId}, operation);
  const member = async (client, workspaceId, userId) => (await client.query(
    'select 1 from workspace_member where workspace_id = $1 and user_id = $2', [workspaceId, userId],
  )).rowCount > 0;
  const joined = async (client, channelId, userId) => (await client.query(
    'select 1 from channel_member where channel_id = $1 and user_id = $2', [channelId, userId],
  )).rowCount > 0;
  const visible = async (client, workspaceId, userId, channelId) => {
    if (!await member(client, workspaceId, userId)) return null;
    const channel = (await client.query(
      `select id, workspace_id as "organizationId", kind, name, topic, dm_key as "dmKey",
              created_by as "createdBy", created_at as "createdAt", archived_at as "archivedAt"
         from channel where id = $1 and workspace_id = $2`, [channelId, workspaceId],
    )).rows[0];
    if (!channel) return null;
    return channel.kind === 'public' || await joined(client, channelId, userId) ? channel : null;
  };
  const mayAdminister = (channel, userId, manages) => Boolean(manages) || channel.createdBy === userId;
  const audit = async (client, {workspaceId, action, actorId, targetLabel, detail = null}) => {
    const label = (await client.query('select coalesce(display_name, email) as label from app_user where id = $1', [actorId])).rows[0]?.label || 'someone';
    await client.query(
      `insert into workspace_audit(id, workspace_id, action, actor_id, actor_label, target_label, detail, at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [newId('audit'), workspaceId, action, actorId, label, targetLabel, detail ? JSON.stringify(detail) : null, now()],
    );
  };

  return Object.freeze({
    KINDS, MAX_NAME, MAX_TOPIC, MAX_BODY, DEFAULT_LIMIT, MAX_LIMIT, normalizeName, dmKeyFor, mayAdminister,
    async isOrgMember(workspaceId, userId) { return run(workspaceId, userId, client => member(client, workspaceId, userId)); },
    async isChannelMember(channelId, userId, workspaceId) { return run(workspaceId, userId, client => joined(client, channelId, userId)); },
    async visibleChannel(workspaceId, userId, channelId) { return run(workspaceId, userId, client => visible(client, workspaceId, userId, channelId)); },
    async listChannels(workspaceId, userId, {includeArchived = false} = {}) {
      return run(workspaceId, userId, async client => {
        if (!await member(client, workspaceId, userId)) return [];
        const rows = (await client.query(
          `select c.id, c.workspace_id as "organizationId", c.kind, c.name, c.topic, c.dm_key as "dmKey",
                  c.created_by as "createdBy", c.created_at as "createdAt", c.archived_at as "archivedAt",
                  (select count(*)::int from channel_member m where m.channel_id = c.id) as "memberCount",
                  (cm.user_id is not null) as joined, cm.last_read_seq as "lastReadSeq",
                  pu.id as "peerId", coalesce(pu.display_name, pu.email) as "peerUsername", pu.display_name as "peerName",
                  (select count(*)::int from message msg where msg.channel_id = c.id and msg.deleted_at is null
                    and msg.user_id <> $1 and msg.seq > coalesce(cm.last_read_seq, 0)) as unread
             from channel c
             left join channel_member cm on cm.channel_id = c.id and cm.user_id = $1
             left join channel_member pm on pm.channel_id = c.id and c.kind = 'dm' and pm.user_id <> $1
             left join app_user pu on pu.id = pm.user_id
            where c.workspace_id = $2 and ($3::boolean or c.archived_at is null)
              and (c.kind = 'public' or cm.user_id is not null)
            order by (c.kind = 'dm'), c.name, c.created_at`, [userId, workspaceId, includeArchived],
        )).rows;
        return rows.map(row => ({
          ...row,
          lastReadSeq: row.lastReadSeq == null ? null : Number(row.lastReadSeq),
        }));
      });
    },
    async listMembers(channelId, workspaceId, userId) {
      return run(workspaceId, userId, async client => (await client.query(
        `select u.id, coalesce(u.display_name, u.email) as username, u.display_name as name, u.email,
                m.joined_at as "joinedAt"
           from channel_member m join app_user u on u.id = m.user_id
          where m.channel_id = $1 order by coalesce(u.display_name, u.email)`, [channelId],
      )).rows);
    },
    async createChannel(workspaceId, userId, {name, topic = null, kind = 'public'}) {
      return run(workspaceId, userId, async client => {
        if (!await member(client, workspaceId, userId)) return {error: 'forbidden'};
        if (!['public', 'private'].includes(kind)) return {error: 'invalid-kind'};
        const clean = normalizeName(name || '');
        if (!clean) return {error: 'invalid-name'};
        if (clean.length > MAX_NAME) return {error: 'name-too-long'};
        if (topic != null && String(topic).length > MAX_TOPIC) return {error: 'topic-too-long'};
        if ((await client.query('select 1 from channel where workspace_id = $1 and name = $2', [workspaceId, clean])).rowCount) return {error: 'name-taken'};
        const id = newId('ch');
        const at = now();
        await client.query(
          `insert into channel(id, workspace_id, kind, name, topic, created_by, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`, [id, workspaceId, kind, clean, topic ? String(topic) : null, userId, at],
        );
        await client.query('insert into channel_member(workspace_id, channel_id, user_id, joined_at) values ($1, $2, $3, $4)', [workspaceId, id, userId, at]);
        return {channel: await visible(client, workspaceId, userId, id)};
      });
    },
    async updateChannel(workspaceId, userId, channelId, {name, topic}, {manages = false} = {}) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
        let nextName = channel.name;
        if (name !== undefined) {
          nextName = normalizeName(name || '');
          if (!nextName) return {error: 'invalid-name'};
          if (nextName.length > MAX_NAME) return {error: 'name-too-long'};
          if ((await client.query('select 1 from channel where workspace_id = $1 and name = $2 and id <> $3', [workspaceId, nextName, channelId])).rowCount) return {error: 'name-taken'};
        }
        let nextTopic = channel.topic;
        if (topic !== undefined) {
          const text = topic === null ? '' : String(topic).trim();
          if (text.length > MAX_TOPIC) return {error: 'topic-too-long'};
          nextTopic = text || null;
        }
        await client.query('update channel set name = $1, topic = $2 where id = $3', [nextName, nextTopic, channelId]);
        if (nextName !== channel.name) await audit(client, {workspaceId, action: 'channel.rename', actorId: userId, targetLabel: `#${nextName}`, detail: {from: channel.name, to: nextName}});
        return {channel: {...channel, name: nextName, topic: nextTopic}};
      });
    },
    async setArchived(workspaceId, userId, channelId, archived, {manages = false} = {}) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
        if (Boolean(channel.archivedAt) === archived) return {channel, changed: false};
        const archivedAt = archived ? now() : null;
        await client.query('update channel set archived_at = $1 where id = $2', [archivedAt, channelId]);
        await audit(client, {workspaceId, action: archived ? 'channel.archive' : 'channel.unarchive', actorId: userId, targetLabel: `#${channel.name}`});
        return {channel: {...channel, archivedAt}, changed: true};
      });
    },
    async deleteChannel(workspaceId, userId, channelId, {manages = false} = {}) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!manages) return {error: 'not-org-admin'};
        const count = Number((await client.query('select count(*) from message where channel_id = $1', [channelId])).rows[0].count);
        await client.query('delete from channel where id = $1', [channelId]);
        await audit(client, {workspaceId, action: 'channel.delete', actorId: userId, targetLabel: `#${channel.name}`, detail: {messages: count, kind: channel.kind}});
        return {deleted: {id: channel.id, name: channel.name, messages: count}};
      });
    },
    async removeChannelMember(workspaceId, userId, channelId, targetId, {manages = false} = {}) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
        if (targetId === userId) return {error: 'leave-instead'};
        return {removed: (await client.query('delete from channel_member where channel_id = $1 and user_id = $2', [channelId, targetId])).rowCount > 0};
      });
    },
    async openDm(workspaceId, userId, otherUserId) {
      return run(workspaceId, userId, async client => {
        if (!await member(client, workspaceId, userId)) return {error: 'forbidden'};
        if (userId === otherUserId) return {error: 'self-dm'};
        if (!await member(client, workspaceId, otherUserId)) return {error: 'not-in-organization'};
        const key = dmKeyFor(userId, otherUserId);
        const found = (await client.query("select * from channel where workspace_id = $1 and dm_key = $2 and kind = 'dm'", [workspaceId, key])).rows[0];
        if (found) return {channel: found, created: false};
        const id = newId('dm');
        const at = now();
        const inserted = await client.query(
          `insert into channel(id, workspace_id, kind, dm_key, created_by, created_at)
           values ($1, $2, 'dm', $3, $4, $5) on conflict do nothing returning id`,
          [id, workspaceId, key, userId, at],
        );
        if (!inserted.rowCount) {
          const raced = (await client.query("select id from channel where workspace_id = $1 and dm_key = $2 and kind = 'dm'", [workspaceId, key])).rows[0];
          return {channel: await visible(client, workspaceId, userId, raced.id), created: false};
        }
        await client.query(
          'insert into channel_member(workspace_id, channel_id, user_id, joined_at) values ($1, $2, $3, $4), ($1, $2, $5, $4)',
          [workspaceId, id, userId, at, otherUserId],
        );
        return {channel: await visible(client, workspaceId, userId, id), created: true};
      });
    },
    async joinChannel(workspaceId, userId, channelId) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind !== 'public') return {error: 'not-joinable'};
        if (await joined(client, channelId, userId)) return {channel, joined: false};
        await client.query('insert into channel_member(workspace_id, channel_id, user_id, joined_at) values ($1, $2, $3, $4)', [workspaceId, channelId, userId, now()]);
        return {channel, joined: true};
      });
    },
    async leaveChannel(workspaceId, userId, channelId) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'cannot-leave-dm'};
        return {left: (await client.query('delete from channel_member where channel_id = $1 and user_id = $2', [channelId, userId])).rowCount > 0};
      });
    },
    async addMember(workspaceId, userId, channelId, inviteeId) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'cannot-invite-to-dm'};
        if (!await joined(client, channelId, userId)) return {error: 'forbidden'};
        if (!await member(client, workspaceId, inviteeId)) return {error: 'not-in-organization'};
        if (await joined(client, channelId, inviteeId)) return {added: false};
        await client.query('insert into channel_member(workspace_id, channel_id, user_id, joined_at) values ($1, $2, $3, $4)', [workspaceId, channelId, inviteeId, now()]);
        return {added: true};
      });
    },
    async listMessages(workspaceId, userId, channelId, {before = null, limit = DEFAULT_LIMIT} = {}) {
      return run(workspaceId, userId, async client => {
        if (!await visible(client, workspaceId, userId, channelId)) return {error: 'not-found'};
        const capped = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const cursor = before == null || before === '' ? null : Number(before);
        if (cursor !== null && !Number.isFinite(cursor)) return {error: 'invalid-cursor'};
        const rows = (await client.query(
          `select m.id, m.seq, m.channel_id as "channelId", m.user_id as "userId", m.body,
                  m.created_at as "createdAt", m.edited_at as "editedAt", m.deleted_at as "deletedAt",
                  coalesce(u.display_name, u.email) as username, u.display_name as name
             from message m join app_user u on u.id = m.user_id
            where m.channel_id = $1 and ($2::bigint is null or m.seq < $2)
            order by m.seq desc limit $3`, [channelId, cursor, capped],
        )).rows;
        const messages = rows.map(message => ({
          ...message,
          seq: Number(message.seq),
          ...(message.deletedAt ? {body: null} : {}),
        })).reverse();
        return {messages, hasMore: rows.length === capped};
      });
    },
    async postMessage(workspaceId, userId, channelId, body) {
      return run(workspaceId, userId, async client => {
        const channel = await visible(client, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.archivedAt) return {error: 'archived'};
        if (!await joined(client, channelId, userId)) return {error: 'not-a-member'};
        const text = typeof body === 'string' ? body.trim() : '';
        if (!text) return {error: 'empty'};
        if (text.length > MAX_BODY) return {error: 'too-long'};
        await client.query('select id from channel where id = $1 for update', [channelId]);
        const seq = Number((await client.query('select coalesce(max(seq), 0) + 1 as next from message where channel_id = $1', [channelId])).rows[0].next);
        const id = newId('msg');
        const at = now();
        await client.query(
          'insert into message(id, workspace_id, seq, channel_id, user_id, body, created_at) values ($1, $2, $3, $4, $5, $6, $7)',
          [id, workspaceId, seq, channelId, userId, text, at],
        );
        await client.query('update channel_member set last_read_seq = $1 where channel_id = $2 and user_id = $3', [seq, channelId, userId]);
        const user = (await client.query('select coalesce(display_name, email) as username, display_name as name from app_user where id = $1', [userId])).rows[0];
        return {message: {id, seq, channelId, userId, body: text, createdAt: at, editedAt: null, deletedAt: null, ...user}};
      });
    },
    async deleteMessage(workspaceId, userId, messageId) {
      return run(workspaceId, userId, async client => {
        const row = (await client.query(
          `select m.id, m.user_id as "userId", m.channel_id as "channelId" from message m
            join channel c on c.id = m.channel_id where m.id = $1 and c.workspace_id = $2`, [messageId, workspaceId],
        )).rows[0];
        if (!row) return {error: 'not-found'};
        if (row.userId !== userId) return {error: 'forbidden'};
        await client.query('update message set deleted_at = $1 where id = $2', [now(), messageId]);
        return {deleted: true, channelId: row.channelId};
      });
    },
    async markRead(workspaceId, userId, channelId) {
      return run(workspaceId, userId, async client => {
        if (!await visible(client, workspaceId, userId, channelId)) return {error: 'not-found'};
        const newest = Number((await client.query('select coalesce(max(seq), 0) as newest from message where channel_id = $1', [channelId])).rows[0].newest);
        const changed = (await client.query('update channel_member set last_read_seq = $1 where channel_id = $2 and user_id = $3', [newest, channelId, userId])).rowCount;
        return {marked: changed > 0, lastReadSeq: newest};
      });
    },
  });
}

module.exports = {createPostgresChat, KINDS, MAX_NAME, MAX_TOPIC, MAX_BODY, DEFAULT_LIMIT, MAX_LIMIT, normalizeName, dmKeyFor};
