'use strict';

const {createAccessControl} = require('better-auth/plugins/access');

// Better Auth owns the generic organization lifecycle. Mochi's content
// permissions remain in workspace-context.js because they describe product
// operations rather than identity-provider operations.
const workspaceAccessControl = createAccessControl({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const workspaceRoles = Object.freeze({
  owner: workspaceAccessControl.newRole({
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
  }),
  editor: workspaceAccessControl.newRole({organization: [], member: [], invitation: []}),
  viewer: workspaceAccessControl.newRole({organization: [], member: [], invitation: []}),
});

const postgresCoreSchema = Object.freeze({
  user: {
    modelName: 'app_user',
    fields: {name: 'display_name', emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at'},
  },
  session: {
    modelName: 'auth_session',
    fields: {
      expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at',
      ipAddress: 'ip_address', userAgent: 'user_agent', userId: 'user_id',
    },
    additionalFields: {
      activeOrganizationId: {type: 'string', required: false},
    },
  },
  account: {
    modelName: 'auth_account',
    fields: {
      accountId: 'account_id', providerId: 'provider_id', userId: 'user_id',
      accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at', updatedAt: 'updated_at',
    },
  },
  verification: {
    modelName: 'auth_verification',
    fields: {expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at'},
  },
});

/** Preserve PostgreSQL's physical session-table mapping when adding behavior. */
function authSessionOptions({postgresEnabled = false, cookieCacheMaxAge = 60} = {}) {
  return {
    ...(postgresEnabled ? postgresCoreSchema.session : {}),
    cookieCache: {enabled: true, maxAge: cookieCacheMaxAge},
  };
}

// The product calls these records workspaces, while Better Auth calls them
// organizations. Schema aliases keep one physical PostgreSQL model and let the
// framework remain the sole writer of membership and invitation lifecycle.
const postgresOrganizationSchema = Object.freeze({
  organization: {
    modelName: 'workspace',
    fields: {
      createdAt: 'created_at',
      metadata: 'metadata',
    },
  },
  member: {
    modelName: 'workspace_member',
    fields: {
      organizationId: 'workspace_id',
      userId: 'user_id',
      createdAt: 'created_at',
    },
  },
  invitation: {
    modelName: 'workspace_invitation',
    fields: {
      organizationId: 'workspace_id',
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      inviterId: 'invited_by',
    },
  },
});

function organizationOptions({postgresEnabled = false, isProduction = false, sendInvitationEmail, hooks} = {}) {
  return {
    ac: workspaceAccessControl,
    roles: workspaceRoles,
    creatorRole: 'owner',
    cancelPendingInvitationsOnReInvite: true,
    // Mochi's hard-delete endpoint first writes asset keys to the durable
    // deletion outbox. Bypassing it through Better Auth would orphan blobs.
    disableOrganizationDeletion: true,
    requireEmailVerificationOnInvitation: isProduction,
    ...(postgresEnabled ? {schema: postgresOrganizationSchema} : {}),
    ...(hooks ? {organizationHooks: hooks} : {}),
    ...(sendInvitationEmail ? {sendInvitationEmail} : {}),
  };
}

module.exports = {
  workspaceAccessControl,
  workspaceRoles,
  postgresCoreSchema,
  authSessionOptions,
  postgresOrganizationSchema,
  organizationOptions,
};
