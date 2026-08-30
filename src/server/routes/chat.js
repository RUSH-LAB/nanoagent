'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// Chat: channels, direct messages, and messages. Everything is scoped to the
// caller's ACTIVE organization, taken from req.auth.orgId, which comes from the
// verified session. There is no organization id in any path or body, so a
// caller cannot address another tenant's channels by naming one.
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
  'cannot-invite-to-dm': [400, 'A direct message takes exactly two people'],
  'self-dm': [400, 'You cannot message yourself'],
  'invalid-kind': [400, 'Channel kind must be public or private'],
  'invalid-name': [400, 'Channel name is required'],
  'name-taken': [409, 'A channel with that name already exists'],
  'name-too-long': [400, 'Channel name is too long'],
  'topic-too-long': [400, 'Channel topic is too long'],
  'invalid-cursor': [400, 'The before cursor must be a message sequence number'],
  'empty': [400, 'Message body is required'],
  'too-long': [400, 'Message is too long'],
});

/** Send a chat.js error result, or 500 if it is one this module has not met. */
function sendError(json, res, code) {
  const mapped = ERRORS[code];
  if (!mapped) return json(res, 500, {error: `Unhandled chat error: ${code}`});
  return json(res, mapped[0], {error: mapped[1]});
}

// /api/chat/channels/:id and /api/chat/channels/:id/<action>. The id segment
// excludes '/' so the action, when present, is always the fifth segment.
const CHANNEL_RE = /^\/api\/chat\/channels\/([^/]+)(?:\/([a-z-]+))?$/;
const MESSAGE_RE = /^\/api\/chat\/messages\/([^/]+)$/;

module.exports = async function chat_routes(req, res, url, pathname, ctx) {
  const {json, readBody, rateLimit, chat} = ctx;

  if (!pathname.startsWith('/api/chat/')) return;

  // Every handler below needs both, and neither can be supplied by the caller.
  const {userId, orgId} = req.auth;
  if (!orgId) {
    return json(res, 409, {
      error: 'No active organization. Create or select one first.',
      hint: 'POST /api/auth/organization/create, then /api/auth/organization/set-active',
    });
  }

  // ── Channels: list ──
  if (req.method === 'GET' && pathname === '/api/chat/channels') {
    return json(res, 200, {channels: chat.listChannels(orgId, userId)});
  }

  // ── Channels: create ──
  if (req.method === 'POST' && pathname === '/api/chat/channels') {
    if (!rateLimit(`chat-create:${userId}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const {name, topic, kind} = await readBody(req);
      const result = chat.createChannel(orgId, userId, {name, topic, kind});
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {channel: result.channel});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Direct messages: open (or reopen) one ──
  if (req.method === 'POST' && pathname === '/api/chat/dm') {
    if (!rateLimit(`chat-dm:${userId}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const {userId: otherUserId} = await readBody(req);
      if (!otherUserId || typeof otherUserId !== 'string') {
        return json(res, 400, {error: 'Missing or invalid userId'});
      }
      const result = chat.openDm(orgId, userId, otherUserId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {channel: result.channel, created: result.created});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  const channelMatch = CHANNEL_RE.exec(pathname);
  if (channelMatch) {
    const [, channelId, action] = channelMatch;

    // ── One channel, with its members ──
    if (req.method === 'GET' && !action) {
      const channel = chat.visibleChannel(orgId, userId, channelId);
      if (!channel) return sendError(json, res, 'not-found');
      return json(res, 200, {channel, members: chat.listMembers(channelId)});
    }

    // ── History ──
    if (req.method === 'GET' && action === 'messages') {
      const result = chat.listMessages(orgId, userId, channelId, {
        before: url.searchParams.get('before'),
        limit: url.searchParams.get('limit'),
      });
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, result);
    }

    // ── Post ──
    if (req.method === 'POST' && action === 'messages') {
      if (!rateLimit(`chat-post:${userId}`, 120)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const {body} = await readBody(req);
        const result = chat.postMessage(orgId, userId, channelId, body);
        if (result.error) return sendError(json, res, result.error);
        return json(res, 200, {message: result.message});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }

    if (req.method === 'POST' && action === 'join') {
      const result = chat.joinChannel(orgId, userId, channelId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {channel: result.channel, joined: result.joined});
    }

    if (req.method === 'POST' && action === 'leave') {
      const result = chat.leaveChannel(orgId, userId, channelId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {left: result.left});
    }

    if (req.method === 'POST' && action === 'read') {
      const result = chat.markRead(orgId, userId, channelId);
      if (result.error) return sendError(json, res, result.error);
      return json(res, 200, {marked: result.marked});
    }

    // ── Invite someone into a private channel ──
    if (req.method === 'POST' && action === 'members') {
      try {
        const {userId: inviteeId} = await readBody(req);
        if (!inviteeId || typeof inviteeId !== 'string') {
          return json(res, 400, {error: 'Missing or invalid userId'});
        }
        const result = chat.addMember(orgId, userId, channelId, inviteeId);
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
    const result = chat.deleteMessage(orgId, userId, messageMatch[1]);
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
module.exports.MESSAGE_RE = MESSAGE_RE;
