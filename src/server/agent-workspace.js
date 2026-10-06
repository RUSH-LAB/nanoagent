'use strict';

const crypto = require('node:crypto');

/**
 * The NanoAgent workspace that belongs to one member of one Mochi workspace.
 * Opaque, so NanoAgent learns nothing about who it is, and derived rather
 * than stored, so the same person always finds the same files.
 */
function agentWorkspaceId(context) {
  return crypto.createHash('sha256').update(`${context.workspaceId}:${context.userId}`).digest('hex').slice(0, 32);
}

module.exports = {agentWorkspaceId};
