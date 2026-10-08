'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// The workspace named by the URL: who is in it, what they may do, and what has
// been done. RequestContext has already joined that immutable workspace id to
// the signed-in user's membership.
//
// The writes here delegate to Better Auth, which owns the rules about who may
// change whom. This module owns the reads, the audit row, and the translation
// of the plugin's answers into this API's shape.

/** /api/org/members/:memberId and /api/org/members/:memberId/role. */
const MEMBER_RE = /^\/api\/org\/members\/([^/]+)(?:\/(role))?$/;
/** /api/org/invitations/:id, for withdrawing one. */
const INVITATION_RE = /^\/api\/org\/invitations\/([^/]+)$/;
/**
 * The two halves of an invitation link. Reading one is public, because the
 * person holding the link has no session yet and cannot make an account with
 * the right address without being told which address was invited. Accepting is
 * not: it needs the session whose address that is.
 */
const INVITE_READ_RE = /^\/api\/invite\/([^/]+)$/;
const INVITE_ACCEPT_RE = /^\/api\/invite\/([^/]+)\/accept$/;

/**
 * Answer a refusal from Better Auth.
 *
 * Its "you are not allowed to remove this member" arrives as a 401, which to a
 * browser means the session is gone and it should sign in again. The session is
 * fine; the caller simply may not do this, which is a 403. Nothing else is
 * rewritten: the plugin's message is the accurate one and it is already written
 * for a person.
 */
function sendRefusal(json, res, err) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  if (status >= 500 || !err?.body?.message) {
    return json(res, 500, {error: 'The organization service could not complete that change'});
  }
  return json(res, status === 401 ? 403 : status, {
    error: err.body.message,
    code: err.body.code ?? null,
  });
}

module.exports = async function org_routes(req, res, url, pathname, ctx) {
  const {json, readBody, rateLimit, org} = ctx;

  const orgPath = req.context && req.workspacePath
    ? `/api/org${req.workspacePath === '/' ? '' : req.workspacePath}`
    : pathname;

  // ── An invitation link, before its holder has signed in ──
  // The only unauthenticated read in this module. It answers for a pending
  // invitation and nothing else: an expired or withdrawn one is a 404, the same
  // as an id that never existed, so the link cannot be used to learn that an
  // organization has been in touch with an address.
  const inviteRead = INVITE_READ_RE.exec(pathname);
  if (inviteRead && req.method === 'GET') {
    const invitation = await org.invitationForLink(inviteRead[1]);
    if (!invitation || invitation.status !== 'pending' || invitation.expired) {
      return json(res, 404, {error: 'This invitation is not valid any more', code: 'invitation-not-found'});
    }
    return json(res, 200, {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        organization: invitation.organization,
        invitedBy: invitation.invitedBy,
      },
    });
  }

  // ── Accepting one, as the account it was sent to ──
  const inviteAccept = INVITE_ACCEPT_RE.exec(pathname);
  if (inviteAccept && req.method === 'POST') {
    if (!req.auth?.userId) return json(res, 401, {error: 'Sign in to accept an invitation'});
    if (!rateLimit(`invite-accept:${req.auth.userId}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const result = await org.acceptInvitation(req.auth, {
        headers: req.headers, invitationId: inviteAccept[1],
      });
      if (result.error === 'not-found') return json(res, 404, {error: 'This invitation is not valid any more', code: 'invitation-not-found'});
      return json(res, 200, {joined: true, organizationId: result.organizationId});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  if (orgPath !== '/api/org' && !orgPath.startsWith('/api/org/')) return;

  const userId = req.context?.userId ?? req.auth.userId;
  const orgId = req.context?.workspaceId ?? null;
  const orgRole = req.context?.role ?? null;

  // ── The three that answer before you are in one ──
  // Everything below the guard needs an active organization. These are how you
  // come to have one, so they run above it: listing what you belong to, making
  // a workspace, and moving between them.

  if (req.method === 'GET' && orgPath === '/api/org/memberships') {
    return json(res, 200, {memberships: await org.listMemberships(req.auth), activeId: orgId});
  }

  if (req.method === 'POST' && orgPath === '/api/org') {
    if (!rateLimit(`org-create:${userId}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
    try {
      const result = await org.createWorkspace(req.auth, {headers: req.headers, name: body.name, slug: body.slug});
      if (result.error === 'invalid-name') return json(res, 400, {error: 'A workspace name is 2 to 60 characters', code: 'invalid-name'});
      if (result.error === 'invalid-slug') return json(res, 400, {error: 'A short name is 2 to 40 characters, using lowercase letters, digits, and inner dashes', code: 'invalid-slug'});
      if (result.error === 'slug-taken') return json(res, 409, {error: 'That short name is taken', code: 'slug-taken'});
      if (result.error === 'not-created') return json(res, 500, {error: 'The organization service could not create that workspace'});
      return json(res, 201, {organization: result.organization, channel: result.channel});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  if (!orgId) {
    return json(res, 409, {
      error: 'No active organization. Create or select one first.',
      code: 'no-organization',
      hint: 'POST /api/org to make one, or follow an invitation link',
    });
  }

  // Every write below is refused early for anyone who is plainly not a manager.
  // This is a filter and not the authority: Better Auth re-decides each one
  // against the caller's real session, so a check that drifts from its rules can
  // only refuse something it would have refused, never allow something it would
  // not have.
  const manages = org.canManage(orgRole);

  // ── The organization, and who you are in it ──
  if (req.method === 'GET' && orgPath === '/api/org') {
    const organization = await org.getOrganization(req.context);
    if (!organization) return json(res, 404, {error: 'Organization not found'});
    return json(res, 200, {organization, you: {userId, role: orgRole, canManage: manages}});
  }

  // ── The roster ──
  if (req.method === 'GET' && orgPath === '/api/org/members') {
    return json(res, 200, {
      members: await org.listMembers(req.context),
      you: {userId, role: orgRole, canManage: manages},
    });
  }

  // ── Invitations outstanding ──
  if (req.method === 'GET' && orgPath === '/api/org/invitations') {
    if (!manages) return json(res, 403, {error: 'Only the workspace owner can see invitations'});
    return json(res, 200, {invitations: await org.listInvitations(req.context)});
  }

  // ── Invite an address ──
  if (req.method === 'POST' && orgPath === '/api/org/invitations') {
    if (!manages) return json(res, 403, {error: 'Only the workspace owner can invite people'});
    if (!rateLimit(`org-invite:${userId}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
    try {
      const result = await org.invite(req.context, {headers: req.headers, email: body.email, role: body.role});
      if (result.error === 'invalid-email') return json(res, 400, {error: 'An email address is required', code: 'invalid-email'});
      if (result.error === 'invalid-role') return json(res, 400, {error: `Role must be one of ${org.ROLES.join(', ')}`, code: 'invalid-role'});
      return json(res, 200, {invitation: result.invitation});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  // ── Withdraw one ──
  const invitationMatch = INVITATION_RE.exec(orgPath);
  if (invitationMatch && req.method === 'DELETE') {
    if (!manages) return json(res, 403, {error: 'Only the workspace owner can withdraw an invitation'});
    try {
      const result = await org.cancelInvitation(req.context, {
        headers: req.headers, invitationId: invitationMatch[1],
      });
      if (result.error === 'not-found') return json(res, 404, {error: 'No such invitation', code: 'not-found'});
      return json(res, 200, {cancelled: result.cancelled});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  // ── What has been done to it ──
  if (req.method === 'GET' && orgPath === '/api/org/audit') {
    if (!manages) return json(res, 403, {error: 'Only the workspace owner can read the audit log'});
    return json(res, 200, {events: await org.listAudit(req.context, url.searchParams.get('limit'))});
  }

  const match = MEMBER_RE.exec(orgPath);
  if (match) {
    const [, memberId, action] = match;

    // ── Change someone's role ──
    if (req.method === 'POST' && action === 'role') {
      if (!manages) return json(res, 403, {error: 'Only the workspace owner can change roles'});
      if (!rateLimit(`org-role:${userId}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      let role;
      try {
        ({role} = await readBody(req));
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
      try {
        const result = await org.setMemberRole(req.context, {headers: req.headers, memberId, role});
        if (result.error === 'invalid-role') return json(res, 400, {error: `Role must be one of ${org.ROLES.join(', ')}`, code: 'invalid-role'});
        if (result.error === 'not-found') return json(res, 404, {error: 'No such member of this organization', code: 'not-found'});
        return json(res, 200, {member: result.member, changed: result.changed});
      } catch (err) {
        return sendRefusal(json, res, err);
      }
    }

    // ── Remove someone from the organization ──
    if (req.method === 'DELETE' && !action) {
      if (!manages) return json(res, 403, {error: 'Only the workspace owner can remove people'});
      if (!rateLimit(`org-remove:${userId}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const result = await org.removeMember(req.context, {headers: req.headers, memberId});
        if (result.error === 'not-found') return json(res, 404, {error: 'No such member of this organization', code: 'not-found'});
        return json(res, 200, {removed: {userId: result.removed.userId, username: result.removed.username}});
      } catch (err) {
        return sendRefusal(json, res, err);
      }
    }
  }
};

module.exports.MEMBER_RE = MEMBER_RE;
module.exports.INVITATION_RE = INVITATION_RE;
module.exports.INVITE_READ_RE = INVITE_READ_RE;
module.exports.INVITE_ACCEPT_RE = INVITE_ACCEPT_RE;
module.exports.sendRefusal = sendRefusal;
