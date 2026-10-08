'use strict';

/**
 * Chat kept in the workspace file system, behind the same interface as
 * postgres/chat.js, so the chat routes and the page are unchanged. A channel
 * is a folder:
 *
 *   chat/<channel id>/channel.json                       kind, name, topic, created, archived
 *   chat/<channel id>/members/<user>.json                joined, last read message
 *   chat/<channel id>/messages/<seq>-<user>[-deleted].json   one message per file
 *
 * A public channel is the workspace's to see; a private channel or a direct
 * message is shared, without an owner, with exactly its members, so leaving
 * one takes it out of sight. Two small registries keep channel names and
 * direct-message pairs unique: chat/.names/<name>.json for the workspace, and
 * chat/.dms/<pair>.json shared with the pair.
 */
const crypto = require('crypto');
const {
  KINDS, MAX_NAME, MAX_TOPIC, MAX_BODY, DEFAULT_LIMIT, MAX_LIMIT, normalizeName, dmKeyFor,
} = require('../postgres/chat');

const SEQ_DIGITS = 12;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const seqName = seq => String(seq).padStart(SEQ_DIGITS, '0');
const MESSAGE = /^(\d+)-(.+?)(-deleted)?\.json$/;
const channelFolder = id => `chat/${id}`;

function createFsChat({fs, now = () => new Date().toISOString(), newId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`}) {
  const scopeOf = (workspaceId, userId) => ({workspaceId, userId});
  const run = (workspaceId, userId, operation) => fs.transaction(scopeOf(workspaceId, userId), operation);
  const read = async (tree, path) => {
    const node = await tree.nodeAt(path);
    return node ? JSON.parse((await tree.bodyOf(node.contentHash)).toString('utf8')) : null;
  };
  const member = async (tree, workspaceId, userId) => (await tree.query(
    'select 1 from workspace_member where workspace_id = $1 and user_id = $2', [workspaceId, userId],
  )).rows.length > 0;
  const joined = async (tree, channelId, userId) => Boolean(await tree.nodeAt(`${channelFolder(channelId)}/members/${userId}.json`));
  const users = async (tree, ids) => new Map((await tree.query(
    'select id, coalesce(display_name, email) as username, display_name as name, email from app_user where id = any($1::text[])',
    [[...new Set(ids)]],
  )).rows.map(row => [row.id, row]));

  /** The channel if this member may see it; channel.json is visible exactly when its folder is. */
  async function visible(tree, workspaceId, userId, channelId) {
    if (!/^[\w-]+$/.test(String(channelId)) || !await member(tree, workspaceId, userId)) return null;
    const channel = await read(tree, `${channelFolder(channelId)}/channel.json`);
    if (!channel) return null;
    const value = {...channel, organizationId: workspaceId};
    return channel.kind === 'public' || await joined(tree, channelId, userId) ? value : null;
  }

  /** Message files of a channel, oldest first, from their names alone. */
  async function messageNodes(tree, channelId) {
    return (await tree.list({prefix: `${channelFolder(channelId)}/messages`}))
      .filter(node => node.kind === 'file')
      .map(node => {
        const match = MESSAGE.exec(node.path.split('/').pop());
        return match ? {node, seq: Number(match[1]), userId: decodeURIComponent(match[2]), deleted: Boolean(match[3])} : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.seq - b.seq);
  }

  async function addMemberFile(tree, channelId, userId, at = now()) {
    await tree.write(`${channelFolder(channelId)}/members/${userId}.json`, json({userId, joinedAt: at, lastReadSeq: 0}), {baseRev: 0});
  }

  async function audit(tree, {workspaceId, userId, action, targetLabel, detail = null}) {
    const label = (await users(tree, [userId])).get(userId)?.username || 'someone';
    await tree.query(
      `insert into workspace_audit(id, workspace_id, action, actor_id, actor_label, target_label, detail, at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [newId('audit'), workspaceId, action, userId, label, targetLabel, detail ? JSON.stringify(detail) : null, now()],
    );
  }

  const mayAdminister = (channel, userId, manages) => Boolean(manages) || channel.createdBy === userId;

  async function shareMembers(tree, channelId, members) {
    await tree.shareWith(channelFolder(channelId), members);
  }

  return Object.freeze({
    KINDS, MAX_NAME, MAX_TOPIC, MAX_BODY, DEFAULT_LIMIT, MAX_LIMIT, normalizeName, dmKeyFor, mayAdminister,

    isOrgMember: (workspaceId, userId) => run(workspaceId, userId, tree => member(tree, workspaceId, userId)),
    isChannelMember: (channelId, userId, workspaceId) => run(workspaceId, userId, tree => joined(tree, channelId, userId)),
    visibleChannel: (workspaceId, userId, channelId) => run(workspaceId, userId, tree => visible(tree, workspaceId, userId, channelId)),

    async listChannels(workspaceId, userId, {includeArchived = false} = {}) {
      return run(workspaceId, userId, async tree => {
        if (!await member(tree, workspaceId, userId)) return [];
        const nodes = await tree.list({prefix: 'chat'});
        const ids = nodes.map(node => /^chat\/([\w-]+)\/channel\.json$/.exec(node.path)?.[1]).filter(Boolean);
        const channels = [];
        for (const id of ids) {
          const channel = await read(tree, `${channelFolder(id)}/channel.json`);
          if (!channel || (!includeArchived && channel.archivedAt)) continue;
          const members = nodes
            .filter(node => node.path.startsWith(`${channelFolder(id)}/members/`) && node.kind === 'file')
            .map(node => decodeURIComponent(node.path.split('/').pop().replace(/\.json$/, '')));
          const isMember = members.includes(userId);
          if (channel.kind !== 'public' && !isMember) continue;
          const mine = isMember ? await read(tree, `${channelFolder(id)}/members/${userId}.json`) : null;
          const lastReadSeq = mine ? Number(mine.lastReadSeq) : null;
          const unread = nodes.filter(node => {
            if (!node.path.startsWith(`${channelFolder(id)}/messages/`)) return false;
            const match = MESSAGE.exec(node.path.split('/').pop());
            return match && !match[3] && decodeURIComponent(match[2]) !== userId && Number(match[1]) > (lastReadSeq ?? 0);
          }).length;
          const peerId = channel.kind === 'dm' ? members.find(other => other !== userId) ?? null : null;
          channels.push({...channel, organizationId: workspaceId, memberCount: members.length, joined: isMember, lastReadSeq, peerId, unread});
        }
        const peers = await users(tree, channels.map(channel => channel.peerId).filter(Boolean));
        return channels
          .map(channel => {
            const selfDm = channel.kind === 'dm' && channel.dmKey === dmKeyFor(userId, userId);
            const peer = peers.get(channel.peerId);
            return {
              ...channel,
              peerUsername: peer?.username ?? null,
              peerName: peer?.name ?? null,
              selfDm,
              ...(selfDm ? {peerId: userId, peerUsername: 'You', peerName: 'You'} : {}),
            };
          })
          .sort((a, b) => Number(a.kind === 'dm') - Number(b.kind === 'dm')
            || String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.createdAt).localeCompare(String(b.createdAt)));
      });
    },

    async listMembers(channelId, workspaceId, userId) {
      return run(workspaceId, userId, async tree => {
        const files = (await tree.list({prefix: `${channelFolder(channelId)}/members`})).filter(node => node.kind === 'file');
        const entries = [];
        for (const file of files) entries.push(await read(tree, file.path));
        const people = await users(tree, entries.map(entry => entry.userId));
        return entries
          .map(entry => ({...people.get(entry.userId), joinedAt: entry.joinedAt}))
          .filter(entry => entry.id)
          .sort((a, b) => String(a.username).localeCompare(String(b.username)));
      });
    },

    async createChannel(workspaceId, userId, {name, topic = null, kind = 'public'}) {
      return run(workspaceId, userId, async tree => {
        if (!await member(tree, workspaceId, userId)) return {error: 'forbidden'};
        if (!['public', 'private'].includes(kind)) return {error: 'invalid-kind'};
        const clean = normalizeName(name || '');
        if (!clean) return {error: 'invalid-name'};
        if (clean.length > MAX_NAME) return {error: 'name-too-long'};
        if (topic != null && String(topic).length > MAX_TOPIC) return {error: 'topic-too-long'};
        const id = newId('ch');
        const at = now();
        try {
          await tree.write(`chat/.names/${encodeURIComponent(clean)}.json`, json({channelId: id}), {baseRev: 0});
        } catch (error) {
          if (error.code === 'exists') return {error: 'name-taken'};
          throw error;
        }
        const channel = {id, kind, name: clean, topic: topic ? String(topic) : null, dmKey: null, createdBy: userId, createdAt: at, archivedAt: null};
        await tree.mkdir(channelFolder(id));
        if (kind === 'private') await tree.setAccess(channelFolder(id), 'shared', {members: [userId], unowned: true});
        await tree.write(`${channelFolder(id)}/channel.json`, json(channel), {baseRev: 0});
        await addMemberFile(tree, id, userId, at);
        return {channel: {...channel, organizationId: workspaceId}};
      });
    },

    async updateChannel(workspaceId, userId, channelId, {name, topic}, {manages = false} = {}) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
        let nextName = channel.name;
        if (name !== undefined) {
          nextName = normalizeName(name || '');
          if (!nextName) return {error: 'invalid-name'};
          if (nextName.length > MAX_NAME) return {error: 'name-too-long'};
          if (nextName !== channel.name) {
            try {
              await tree.write(`chat/.names/${encodeURIComponent(nextName)}.json`, json({channelId}), {baseRev: 0});
            } catch (error) {
              if (error.code === 'exists') return {error: 'name-taken'};
              throw error;
            }
            await tree.remove(`chat/.names/${encodeURIComponent(channel.name)}.json`);
          }
        }
        let nextTopic = channel.topic;
        if (topic !== undefined) {
          const text = topic === null ? '' : String(topic).trim();
          if (text.length > MAX_TOPIC) return {error: 'topic-too-long'};
          nextTopic = text || null;
        }
        const {organizationId, ...stored} = channel;
        await tree.write(`${channelFolder(channelId)}/channel.json`, json({...stored, name: nextName, topic: nextTopic}));
        if (nextName !== channel.name) {
          await audit(tree, {workspaceId, userId, action: 'channel.rename', targetLabel: `#${nextName}`, detail: {from: channel.name, to: nextName}});
        }
        return {channel: {...channel, organizationId, name: nextName, topic: nextTopic}};
      });
    },

    async setArchived(workspaceId, userId, channelId, archived, {manages = false} = {}) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
        if (Boolean(channel.archivedAt) === archived) return {channel, changed: false};
        const archivedAt = archived ? now() : null;
        const {organizationId, ...stored} = channel;
        await tree.write(`${channelFolder(channelId)}/channel.json`, json({...stored, archivedAt}));
        await audit(tree, {workspaceId, userId, action: archived ? 'channel.archive' : 'channel.unarchive', targetLabel: `#${channel.name}`});
        return {channel: {...channel, organizationId, archivedAt}, changed: true};
      });
    },

    async deleteChannel(workspaceId, userId, channelId, {manages = false} = {}) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!manages) return {error: 'not-org-admin'};
        const count = (await messageNodes(tree, channelId)).length;
        await tree.remove(channelFolder(channelId));
        await tree.remove(`chat/.names/${encodeURIComponent(channel.name)}.json`);
        await audit(tree, {workspaceId, userId, action: 'channel.delete', targetLabel: `#${channel.name}`, detail: {messages: count, kind: channel.kind}});
        return {deleted: {id: channel.id, name: channel.name, messages: count}};
      });
    },

    async removeChannelMember(workspaceId, userId, channelId, targetId, {manages = false} = {}) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'not-a-channel'};
        if (!mayAdminister(channel, userId, manages)) return {error: 'not-channel-admin'};
        if (targetId === userId) return {error: 'leave-instead'};
        const file = `${channelFolder(channelId)}/members/${targetId}.json`;
        if (!await tree.nodeAt(file)) return {removed: false};
        await tree.remove(file);
        if (channel.kind === 'private') {
          const remaining = await tree.sharedWith(channelFolder(channelId));
          await shareMembers(tree, channelId, remaining.filter(other => other !== targetId));
        }
        return {removed: true};
      });
    },

    async openDm(workspaceId, userId, otherUserId) {
      return run(workspaceId, userId, async tree => {
        if (!await member(tree, workspaceId, userId)) return {error: 'forbidden'};
        if (!await member(tree, workspaceId, otherUserId)) return {error: 'not-in-organization'};
        const key = dmKeyFor(userId, otherUserId);
        const registry = `chat/.dms/${encodeURIComponent(key)}.json`;
        const known = await read(tree, registry);
        if (known) return {channel: await visible(tree, workspaceId, userId, known.channelId), created: false};
        const id = newId('dm');
        const at = now();
        const people = [...new Set([userId, otherUserId])];
        await tree.mkdir('chat/.dms');
        await tree.write(registry, json({channelId: id}), {baseRev: 0});
        await tree.setAccess(registry, 'shared', {members: people, unowned: true});
        await tree.mkdir(channelFolder(id));
        await tree.setAccess(channelFolder(id), 'shared', {members: people, unowned: true});
        const channel = {id, kind: 'dm', name: null, topic: null, dmKey: key, createdBy: userId, createdAt: at, archivedAt: null};
        await tree.write(`${channelFolder(id)}/channel.json`, json(channel), {baseRev: 0});
        for (const person of people) await addMemberFile(tree, id, person, at);
        return {channel: {...channel, organizationId: workspaceId}, created: true};
      });
    },

    async joinChannel(workspaceId, userId, channelId) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind !== 'public') return {error: 'not-joinable'};
        if (await joined(tree, channelId, userId)) return {channel, joined: false};
        await addMemberFile(tree, channelId, userId);
        return {channel, joined: true};
      });
    },

    async leaveChannel(workspaceId, userId, channelId) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'cannot-leave-dm'};
        const file = `${channelFolder(channelId)}/members/${userId}.json`;
        if (!await tree.nodeAt(file)) return {left: false};
        await tree.remove(file);
        if (channel.kind === 'private') {
          const remaining = await tree.sharedWith(channelFolder(channelId));
          await shareMembers(tree, channelId, remaining.filter(other => other !== userId));
        }
        return {left: true};
      });
    },

    async addMember(workspaceId, userId, channelId, inviteeId) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.kind === 'dm') return {error: 'cannot-invite-to-dm'};
        if (!await joined(tree, channelId, userId)) return {error: 'forbidden'};
        if (!await member(tree, workspaceId, inviteeId)) return {error: 'not-in-organization'};
        if (await joined(tree, channelId, inviteeId)) return {added: false};
        if (channel.kind === 'private') {
          await shareMembers(tree, channelId, [...await tree.sharedWith(channelFolder(channelId)), inviteeId]);
        }
        await addMemberFile(tree, channelId, inviteeId);
        return {added: true};
      });
    },

    async listMessages(workspaceId, userId, channelId, {before = null, limit = DEFAULT_LIMIT} = {}) {
      return run(workspaceId, userId, async tree => {
        if (!await visible(tree, workspaceId, userId, channelId)) return {error: 'not-found'};
        const capped = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const cursor = before == null || before === '' ? null : Number(before);
        if (cursor !== null && !Number.isFinite(cursor)) return {error: 'invalid-cursor'};
        const all = (await messageNodes(tree, channelId)).filter(entry => cursor === null || entry.seq < cursor);
        const page = all.slice(-capped);
        const people = await users(tree, page.map(entry => entry.userId));
        const messages = [];
        for (const entry of page) {
          const stored = JSON.parse((await tree.bodyOf(entry.node.contentHash)).toString('utf8'));
          const person = people.get(entry.userId);
          messages.push({
            ...stored, channelId, username: person?.username ?? null, name: person?.name ?? null,
            ...(stored.deletedAt ? {body: null} : {}),
          });
        }
        return {messages, hasMore: page.length === capped && all.length > capped};
      });
    },

    async postMessage(workspaceId, userId, channelId, body) {
      return run(workspaceId, userId, async tree => {
        const channel = await visible(tree, workspaceId, userId, channelId);
        if (!channel) return {error: 'not-found'};
        if (channel.archivedAt) return {error: 'archived'};
        if (!await joined(tree, channelId, userId)) return {error: 'not-a-member'};
        const text = typeof body === 'string' ? body.trim() : '';
        if (!text) return {error: 'empty'};
        if (text.length > MAX_BODY) return {error: 'too-long'};
        // The channel's metadata is the lock that orders its messages.
        await tree.nodeAt(`${channelFolder(channelId)}/channel.json`, {lock: true});
        const seq = ((await messageNodes(tree, channelId)).at(-1)?.seq ?? 0) + 1;
        const id = newId('msg');
        const at = now();
        const message = {id, seq, userId, body: text, createdAt: at, editedAt: null, deletedAt: null};
        await tree.write(`${channelFolder(channelId)}/messages/${seqName(seq)}-${encodeURIComponent(userId)}.json`, json(message), {baseRev: 0});
        const membership = `${channelFolder(channelId)}/members/${userId}.json`;
        await tree.write(membership, json({...await read(tree, membership), lastReadSeq: seq}));
        const person = (await users(tree, [userId])).get(userId);
        return {message: {...message, channelId, username: person?.username ?? null, name: person?.name ?? null}};
      });
    },

    async deleteMessage(workspaceId, userId, messageId) {
      return run(workspaceId, userId, async tree => {
        const nodes = (await tree.list({prefix: 'chat'})).filter(node => /^chat\/[\w-]+\/messages\/[^/]+\.json$/.test(node.path));
        for (const node of nodes) {
          const match = MESSAGE.exec(node.path.split('/').pop());
          if (!match || match[3]) continue;
          const stored = JSON.parse((await tree.bodyOf(node.contentHash)).toString('utf8'));
          if (stored.id !== messageId) continue;
          if (stored.userId !== userId) return {error: 'forbidden'};
          const channelId = node.path.split('/')[1];
          await tree.write(node.path, json({...stored, body: null, deletedAt: now()}), {baseRev: node.rev});
          await tree.move(node.path, node.path.replace(/\.json$/, '-deleted.json'));
          return {deleted: true, channelId};
        }
        return {error: 'not-found'};
      });
    },

    /**
     * A new member's channels (workspace-provisioning.js): the workspace's
     * first channel, which its owner's arrival creates, joined by everyone.
     */
    async provisionMember(workspaceId, userId, {isOwner, name, topic}) {
      return run(workspaceId, userId, async tree => {
        let registry = await read(tree, `chat/.names/${encodeURIComponent(name)}.json`);
        if (!registry && isOwner) {
          const id = newId('ch');
          const at = now();
          await tree.write(`chat/.names/${encodeURIComponent(name)}.json`, json({channelId: id}), {baseRev: 0});
          await tree.mkdir(channelFolder(id));
          await tree.write(`${channelFolder(id)}/channel.json`, json({
            id, kind: 'public', name, topic, dmKey: null, createdBy: userId, createdAt: at, archivedAt: null,
          }), {baseRev: 0});
          registry = {channelId: id};
        }
        if (registry && !await joined(tree, registry.channelId, userId)) await addMemberFile(tree, registry.channelId, userId);
      });
    },

    /** A member leaving the workspace leaves every channel, and every private one stops showing them. */
    async removeMember(workspaceId, userId) {
      return run(workspaceId, userId, async tree => {
        const files = (await tree.list({prefix: 'chat'}))
          .filter(node => /^chat\/[\w-]+\/members\/[^/]+$/.test(node.path) && node.path.endsWith(`/members/${userId}.json`));
        for (const file of files) {
          const channelId = file.path.split('/')[1];
          await tree.remove(file.path);
          const folder = await tree.nodeAt(channelFolder(channelId));
          if (folder?.access === 'shared') {
            await shareMembers(tree, channelId, (await tree.sharedWith(channelFolder(channelId))).filter(other => other !== userId));
          }
        }
      });
    },

    async markRead(workspaceId, userId, channelId) {
      return run(workspaceId, userId, async tree => {
        if (!await visible(tree, workspaceId, userId, channelId)) return {error: 'not-found'};
        const newest = (await messageNodes(tree, channelId)).at(-1)?.seq ?? 0;
        const membership = `${channelFolder(channelId)}/members/${userId}.json`;
        const mine = await read(tree, membership);
        if (!mine) return {marked: false, lastReadSeq: newest};
        if (Number(mine.lastReadSeq) !== newest) await tree.write(membership, json({...mine, lastReadSeq: newest}));
        return {marked: true, lastReadSeq: newest};
      });
    },
  });
}

module.exports = {createFsChat};
