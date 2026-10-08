'use strict';

function workspaceContext(value) {
  if (!value?.userId || !value?.workspaceId || !value?.membershipId || !value?.role) {
    const error = new Error('A verified workspace context is required');
    error.status = 404;
    error.code = 'workspace-not-found';
    throw error;
  }
  return value;
}

function userContext(value) {
  if (!value?.userId) {
    const error = new Error('An authenticated user context is required');
    error.status = 401;
    error.code = 'authentication-required';
    throw error;
  }
  return value;
}

/**
 * Present chat as a RequestContext-only domain service. The SQLite and
 * PostgreSQL modules behind this adapter are persistence implementations; no
 * request route gets an API that accepts caller-selected tenant identifiers.
 */
function contextualChat(adapter) {
  const ids = context => {
    const verified = workspaceContext(context);
    return [verified.workspaceId, verified.userId];
  };
  const manages = context => workspaceContext(context).role === 'owner';

  return Object.freeze({
    listChannels(context, options) {
      return adapter.listChannels(...ids(context), options);
    },
    createChannel(context, input) {
      return adapter.createChannel(...ids(context), input);
    },
    openDm(context, otherUserId) {
      return adapter.openDm(...ids(context), otherUserId);
    },
    removeChannelMember(context, channelId, targetId) {
      return adapter.removeChannelMember(...ids(context), channelId, targetId, {manages: manages(context)});
    },
    visibleChannel(context, channelId) {
      return adapter.visibleChannel(...ids(context), channelId);
    },
    listMembers(context, channelId) {
      const [workspaceId, userId] = ids(context);
      return adapter.listMembers(channelId, workspaceId, userId);
    },
    mayAdminister(context, channel) {
      return adapter.mayAdminister(channel, workspaceContext(context).userId, manages(context));
    },
    updateChannel(context, channelId, changes) {
      return adapter.updateChannel(...ids(context), channelId, changes, {manages: manages(context)});
    },
    setArchived(context, channelId, archived) {
      return adapter.setArchived(...ids(context), channelId, archived, {manages: manages(context)});
    },
    deleteChannel(context, channelId) {
      return adapter.deleteChannel(...ids(context), channelId, {manages: manages(context)});
    },
    listMessages(context, channelId, options) {
      return adapter.listMessages(...ids(context), channelId, options);
    },
    postMessage(context, channelId, body) {
      return adapter.postMessage(...ids(context), channelId, body);
    },
    joinChannel(context, channelId) {
      return adapter.joinChannel(...ids(context), channelId);
    },
    leaveChannel(context, channelId) {
      return adapter.leaveChannel(...ids(context), channelId);
    },
    markRead(context, channelId) {
      return adapter.markRead(...ids(context), channelId);
    },
    addMember(context, channelId, inviteeId) {
      return adapter.addMember(...ids(context), channelId, inviteeId);
    },
    deleteMessage(context, messageId) {
      return adapter.deleteMessage(...ids(context), messageId);
    },
  });
}

/** Request-facing workspace/member service with the same context boundary. */
function contextualOrg(adapter) {
  return Object.freeze({
    ROLES: adapter.ROLES,
    canManage: adapter.canManage,
    invitationForLink: adapter.invitationForLink,
    slugForOrg: adapter.slugForOrg,
    primaryOrgId: adapter.primaryOrgId,
    allOrganizations: adapter.allOrganizations,

    listMemberships(identity) {
      return adapter.listMemberships(userContext(identity).userId);
    },
    createWorkspace(identity, input) {
      return adapter.createWorkspace({...input, actorId: userContext(identity).userId});
    },
    acceptInvitation(identity, input) {
      return adapter.acceptInvitation({...input, actorId: userContext(identity).userId});
    },
    getOrganization(context) {
      const verified = workspaceContext(context);
      return adapter.getOrganization(verified.workspaceId, verified.userId);
    },
    listMembers(context) {
      const verified = workspaceContext(context);
      return adapter.listMembers(verified.workspaceId, verified.userId);
    },
    listInvitations(context) {
      const verified = workspaceContext(context);
      return adapter.listInvitations(verified.workspaceId, verified.userId);
    },
    invite(context, input) {
      const verified = workspaceContext(context);
      return adapter.invite({...input, orgId: verified.workspaceId, actorId: verified.userId});
    },
    cancelInvitation(context, input) {
      const verified = workspaceContext(context);
      return adapter.cancelInvitation({...input, orgId: verified.workspaceId, actorId: verified.userId});
    },
    listAudit(context, limit) {
      const verified = workspaceContext(context);
      return adapter.listAudit(verified.workspaceId, limit, verified.userId);
    },
    setMemberRole(context, input) {
      const verified = workspaceContext(context);
      return adapter.setMemberRole({...input, orgId: verified.workspaceId, actorId: verified.userId});
    },
    removeMember(context, input) {
      const verified = workspaceContext(context);
      return adapter.removeMember({...input, orgId: verified.workspaceId, actorId: verified.userId});
    },
    archiveWorkspace(context) {
      return adapter.archiveWorkspace(workspaceContext(context));
    },
    deleteWorkspace(context) {
      return adapter.deleteWorkspace(workspaceContext(context));
    },
  });
}

module.exports = {contextualChat, contextualOrg, workspaceContext, userContext};
