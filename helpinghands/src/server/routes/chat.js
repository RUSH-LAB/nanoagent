'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// Chat: channels, direct messages, and messages. Everything is scoped by the
// RequestContext resolved from the explicit workspace URL and verified
// membership. The session's active organization is never an authority.
//
// The organization itself is Better Auth's: creating one, listing them,
// switching the active one, inviting and removing members all live under
// /api/auth/organization/*. This module only owns what happens inside one.

// Every failure mode chat.js can report, mapped to a status and a message.
// Kept in one table so two handlers cannot disagree about what 'not-found'
// means, and so a new error in chat.js fails loudly here rather than falling
// through as a 500.
const ERRORS = Object.freeze({
  'forbidden': [403, 'You are not a member of this organization'],
  'not-found': [404, 'Channel not found'],
  'not-a-member': [403, 'Join the channel before posting'],
  'not-joinable': [400, 'Only public channels can be joined'],
  'not-in-organization': [400, 'That user is not in this organization'],
  'cannot-leave-dm': [400, 'A direct message cannot be left'],
  'not-a-channel': [400, 'A direct message is not a channel you administer'],
  // Distinct from 'forbidden', which means "not in this organization". These
  // two are for someone who is in it and still may not do this particular
  // thing, and telling them they are not a member would simply be false.
  'not-channel-admin': [403, "Only the channel's creator or workspace owner can change it"],
  'not-org-admin': [403, 'Only the workspace owner can delete a channel'],
  'archived': [409, 'This channel is archived, so it is read-only'],
  'leave-instead': [400, 'Leave the channel rather than removing yourself from it'],
  'cannot-invite-to-dm': [400, 'A direct message takes exactly two people'],
  'invalid-kind': [400, 'Channel kind must be public or private'],
  'invalid-name': [400, 'Channel name is required'],
  'name-taken': [409, 'A channel with that name already exists'],
  'name-too-long': [400, 'Channel name is too long'],
  'topic-too-long': [400, 'Channel topic is too long'],
  'invalid-cursor': [400, 'The before cursor must be a message sequence number'],
  'empty': [400, 'Message body is required'],
  'too-long': [400, 'Message is too long'],
});

/**
 * Send a chat.js error result, or 500 if it is one this module has not met.
 *
 * The chat.js code goes out alongside the sentence. A client that has to branch
 * on which failure this was (the CLI joins a channel and retries when a post is
 * refused for membership) would otherwise have to match on the prose, which is
 * a string written for people and free to change.
 */
function sendError(json, res, code) {
  const mapped = ERRORS[code];
  if (!mapped) return json(res, 500, {error: `Unhandled chat error: ${code}`});
  return json(res, mapped[0], {error: mapped[1], code});
}

// /api/chat/channels/:id and /api/chat/channels/:id/<action>. The id segment
// excludes '/' so the action, when present, is always the fifth segment.
const CHANNEL_RE = /^\/api\/chat\/channels\/([^/]+)(?:\/([a-z-]+))?$/;
// One person in one channel: /api/chat/channels/:id/members/:userId. Matched
// before CHANNEL_RE, whose action segment would otherwise stop at 'members'.
const CHANNEL_MEMBER_RE = /^\/api\/chat\/channels\/([^/]+)\/members\/([^/]+)$/;
const MESSAGE_RE = /^\/api\/chat\/messages\/([^/]+)$/;

module.exports = async function chat_routes(req, res, url, pathname, ctx) {
  const {json, readBody, rateLimit, chat, org} = ctx;

  if (!pathname.startsWith('/api/chat/')) return;

  if (!req.context) return json(res, 404, {error: 'Workspace not found'});
  const {userId, role: orgRole} = req.context;

  // Used only in the response model. The contextual chat service independently
  // derives management authority from RequestContext for every write.
  const manages = org.canManage(orgRole);

  // ── Channels: list ──
  // ?archived=1 adds the archived ones, which is the browse-and-restore view
  // rather than the sidebar's.
  if (req.method === 'GET' && pathname === '/api/chat/channels') {
    const includeArchived = url.searchParams.get('archived') === '1';
    return json(res, 200, {
      channels: await chat.listChannels(req.context, {includeArchived}),
      you: {userId, role: orgRole, canManage: manages},
    });
  }

  // ── Channels: create ──
  if (req.method === 'POST' && pathname === '/api/chat/channels') {
    if (!['owner', 'editor'].includes(orgRole)) return json(res, 403, {error: 'Only workspace editors can create channels'});
    if (!await rateLimit(`chat-create:${userId}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const {name, topic, kind} = await readBody(req);
      const result = await chat.createChannel(req.context, {name, topic, kind});
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {channel: result.channel});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Direct messages: open (or reopen) one ──
  if (req.method === 'POST' && pathname === '/api/chat/dm') {
    if (!await rateLimit(`chat-dm:${userId}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const {userId: otherUserId} = await readBody(req);
      if (!otherUserId || typeof otherUserId !== 'string') {
        return json(res, 400, {error: 'Missing or invalid userId'});
      }
      const result = await chat.openDm(req.context, otherUserId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {channel: result.channel, created: result.created});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Remove someone else from a channel ──
  const channelMemberMatch = CHANNEL_MEMBER_RE.exec(pathname);
  if (channelMemberMatch && req.method === 'DELETE') {
    const [, channelId, targetId] = channelMemberMatch;
    const result = await chat.removeChannelMember(req.context, channelId, targetId);
    if (result.error) return sendError(json, res, result.error);
    return json(res, 200, {removed: result.removed});
  }

  const channelMatch = CHANNEL_RE.exec(pathname);
  if (channelMatch) {
    const [, channelId, action] = channelMatch;

    // ── One channel, with its members ──
    if (req.method === 'GET' && !action) {
      const channel = await chat.visibleChannel(req.context, channelId);
      if (!channel) return sendError(json, res, 'not-found');
      return json(res, 200, {
        channel,
        members: await chat.listMembers(req.context, channelId),
        canAdminister: chat.mayAdminister(req.context, channel),
      });
    }

    // ── Rename, or set the topic ──
    if (req.method === 'PATCH' && !action) {
      if (!await rateLimit(`chat-edit:${userId}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        // Only the keys actually sent are touched, so setting a topic cannot
        // rename anything and vice versa.
        const changes = {};
        if ('name' in body) changes.name = body.name;
        if ('topic' in body) changes.topic = body.topic;
        if (Object.keys(changes).length === 0) return json(res, 400, {error: 'Nothing to change. Send a name, a topic, or both.'});
        const result = await chat.updateChannel(req.context, channelId, changes);
        if (result.error) return sendError(json, res, result.error);
        return json(res, 200, {channel: result.channel});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }

    // ── Archive, and bring back ──
    if (req.method === 'POST' && (action === 'archive' || action === 'unarchive')) {
      const result = await chat.setArchived(req.context, channelId, action === 'archive');
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {channel: result.channel, changed: result.changed});
    }

    // ── Delete it, and everything said in it ──
    if (req.method === 'DELETE' && !action) {
      if (!await rateLimit(`chat-delete:${userId}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      const result = await chat.deleteChannel(req.context, channelId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {deleted: result.deleted});
    }

    // ── History ──
    if (req.method === 'GET' && action === 'messages') {
      const result = await chat.listMessages(req.context, channelId, {
        before: url.searchParams.get('before'),
        limit: url.searchParams.get('limit'),
      });
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, result);
    }

    // ── Post ──
    if (req.method === 'POST' && action === 'messages') {
      if (!await rateLimit(`chat-post:${userId}`, 120)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const {body} = await readBody(req);
        const result = await chat.postMessage(req.context, channelId, body);
        if (result.error) return sendError(json, res, result.error);
        return json(res, 200, {message: result.message});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }

    if (req.method === 'POST' && action === 'join') {
      const result = await chat.joinChannel(req.context, channelId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {channel: result.channel, joined: result.joined});
    }

    if (req.method === 'POST' && action === 'leave') {
      const result = await chat.leaveChannel(req.context, channelId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {left: result.left});
    }

    if (req.method === 'POST' && action === 'read') {
      const result = await chat.markRead(req.context, channelId);
      if (result.error) return sendError(json, res, result.error);
      // `lastReadSeq` is the mark that was set, and it travels back so the
      // caller can move its divider without re-listing every channel. It comes
      // back even when `marked` is false, because an un-joined public channel
      // has no membership row to update and the client still needs the seq it
      // would have been given.
      return json(res, 200, {marked: result.marked, lastReadSeq: result.lastReadSeq});
    }

    // ── Invite someone into a private channel ──
    if (req.method === 'POST' && action === 'members') {
      try {
        const {userId: inviteeId} = await readBody(req);
        if (!inviteeId || typeof inviteeId !== 'string') {
          return json(res, 400, {error: 'Missing or invalid userId'});
        }
        const result = await chat.addMember(req.context, channelId, inviteeId);
        if (result.error) return sendError(json, res, result.error);
        return json(res, 200, {added: result.added});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
  }

  // ── Delete one of your own messages ──
  const messageMatch = MESSAGE_RE.exec(pathname);
  if (messageMatch && req.method === 'DELETE') {
    const result = await chat.deleteMessage(req.context, messageMatch[1]);
    if (result.error) {
      // A message you did not write reads as 'forbidden' from chat.js, but the
      // channel-shaped wording in ERRORS would be confusing here.
      if (result.error === 'forbidden') return json(res, 403, {error: 'You can only delete your own messages'});
      if (result.error === 'not-found') return json(res, 404, {error: 'Message not found'});
      return sendError(json, res, result.error);
    }
    return json(res, 200, {deleted: true});
  }
};

module.exports.ERRORS = ERRORS;
module.exports.CHANNEL_RE = CHANNEL_RE;
module.exports.CHANNEL_MEMBER_RE = CHANNEL_MEMBER_RE;
module.exports.MESSAGE_RE = MESSAGE_RE;
