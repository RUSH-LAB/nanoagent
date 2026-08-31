'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// The organization you are in: who is in it, what they may do, and what has
// been done. Scoped to the caller's ACTIVE organization from req.auth.orgId,
// which comes from the verified session, so as with chat there is no
// organization id in any path or body for a caller to substitute.
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

  // ── An invitation link, before its holder has signed in ──
  // The only unauthenticated read in this module. It answers for a pending
  // invitation and nothing else: an expired or withdrawn one is a 404, the same
  // as an id that never existed, so the link cannot be used to learn that an
  // organization has been in touch with an address.
  const inviteRead = INVITE_READ_RE.exec(pathname);
  if (inviteRead && req.method === 'GET') {
    const invitation = org.invitationForLink(inviteRead[1]);
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
      const result = await org.acceptInvitation({
        headers: req.headers, actorId: req.auth.userId, invitationId: inviteAccept[1],
      });
      if (result.error === 'not-found') return json(res, 404, {error: 'This invitation is not valid any more', code: 'invitation-not-found'});
      return json(res, 200, {joined: true, organizationId: result.organizationId});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  if (pathname !== '/api/org' && !pathname.startsWith('/api/org/')) return;

  const {userId, orgId, orgRole} = req.auth;

  // ── The three that answer before you are in one ──
  // Everything below the guard needs an active organization. These are how you
  // come to have one, so they run above it: listing what you belong to, making
  // a workspace, and moving between them.

  if (req.method === 'GET' && pathname === '/api/org/memberships') {
    return json(res, 200, {memberships: org.listMemberships(userId), activeId: orgId});
  }

  if (req.method === 'POST' && pathname === '/api/org') {
    if (!rateLimit(`org-create:${userId}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
    try {
      const result = await org.createWorkspace({headers: req.headers, actorId: userId, name: body.name, slug: body.slug});
      if (result.error === 'invalid-name') return json(res, 400, {error: 'A workspace name is 2 to 60 characters', code: 'invalid-name'});
      if (result.error === 'invalid-slug') return json(res, 400, {error: 'A short name is 2 to 40 characters, using lowercase letters, digits, and inner dashes', code: 'invalid-slug'});
      if (result.error === 'slug-taken') return json(res, 409, {error: 'That short name is taken', code: 'slug-taken'});
      if (result.error === 'not-created') return json(res, 500, {error: 'The organization service could not create that workspace'});
      return json(res, 201, {organization: result.organization, channel: result.channel});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  if (req.method === 'POST' && pathname === '/api/org/active') {
    if (!rateLimit(`org-active:${userId}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
    try {
      const result = await org.setActiveWorkspace({headers: req.headers, userId, organizationId: body.organizationId});
      if (result.error === 'not-a-member') return json(res, 404, {error: 'No such workspace, or you are not in it', code: 'not-a-member'});
      return json(res, 200, {activeId: result.organizationId});
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
  if (req.method === 'GET' && pathname === '/api/org') {
    const organization = org.getOrganization(orgId, userId);
    if (!organization) return json(res, 404, {error: 'Organization not found'});
    return json(res, 200, {organization, you: {userId, role: orgRole, canManage: manages}});
  }

  // ── The roster ──
  if (req.method === 'GET' && pathname === '/api/org/members') {
    return json(res, 200, {
      members: org.listMembers(orgId, userId),
      you: {userId, role: orgRole, canManage: manages},
    });
  }

  // ── Invitations outstanding ──
  if (req.method === 'GET' && pathname === '/api/org/invitations') {
    if (!manages) return json(res, 403, {error: 'Only an owner or admin can see the invitations'});
    return json(res, 200, {invitations: org.listInvitations(orgId)});
  }

  // ── Invite an address ──
  if (req.method === 'POST' && pathname === '/api/org/invitations') {
    if (!manages) return json(res, 403, {error: 'Only an owner or admin can invite people'});
    if (!rateLimit(`org-invite:${userId}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
    try {
      const result = await org.invite({headers: req.headers, orgId, actorId: userId, email: body.email, role: body.role});
      if (result.error === 'invalid-email') return json(res, 400, {error: 'An email address is required', code: 'invalid-email'});
      if (result.error === 'invalid-role') return json(res, 400, {error: `Role must be one of ${org.ROLES.join(', ')}`, code: 'invalid-role'});
      return json(res, 200, {invitation: result.invitation});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  // ── Withdraw one ──
  const invitationMatch = INVITATION_RE.exec(pathname);
  if (invitationMatch && req.method === 'DELETE') {
    if (!manages) return json(res, 403, {error: 'Only an owner or admin can withdraw an invitation'});
    try {
      const result = await org.cancelInvitation({
        headers: req.headers, orgId, actorId: userId, invitationId: invitationMatch[1],
      });
      if (result.error === 'not-found') return json(res, 404, {error: 'No such invitation', code: 'not-found'});
      return json(res, 200, {cancelled: result.cancelled});
    } catch (err) {
      return sendRefusal(json, res, err);
    }
  }

  // ── Create an account outright ──
  // Owners only, and not because admins are less trusted: whoever does this
  // chooses the password, so they can sign in as the account afterwards. That
  // is a different kind of power from managing people, and it belongs to
  // whoever owns the organization.
  if (req.method === 'POST' && pathname === '/api/org/members') {
    if (!org.canManage(orgRole) || !String(orgRole ?? '').split(',').some(r => r.trim() === 'owner')) {
      return json(res, 403, {error: 'Only an owner can create an account directly', code: 'not-owner'});
    }
    if (!rateLimit(`org-create-account:${userId}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
    const result = await org.createAccount({orgId, actorId: userId, ...body});
    if (result.error === 'invalid-username') return json(res, 400, {error: 'A username is 3 to 32 characters, using letters, digits, dot, dash, or underscore', code: 'invalid-username'});
    if (result.error === 'weak-password') return json(res, 400, {error: 'A password of at least 8 characters is required', code: 'weak-password'});
    if (result.error === 'invalid-role') return json(res, 400, {error: `Role must be one of ${org.ROLES.join(', ')}`, code: 'invalid-role'});
    if (result.error === 'signup-failed') return json(res, 409, {error: result.reason, code: 'signup-failed'});
    return json(res, 200, {user: result.user, role: result.role});
  }

  // ── What has been done to it ──
  if (req.method === 'GET' && pathname === '/api/org/audit') {
    if (!manages) return json(res, 403, {error: 'Only an owner or admin can read the audit log'});
    return json(res, 200, {events: org.listAudit(orgId, url.searchParams.get('limit'))});
  }

  const match = MEMBER_RE.exec(pathname);
  if (match) {
    const [, memberId, action] = match;

    // ── Change someone's role ──
    if (req.method === 'POST' && action === 'role') {
      if (!manages) return json(res, 403, {error: 'Only an owner or admin can change roles'});
      if (!rateLimit(`org-role:${userId}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      let role;
      try {
        ({role} = await readBody(req));
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
      try {
        const result = await org.setMemberRole({headers: req.headers, orgId, actorId: userId, memberId, role});
        if (result.error === 'invalid-role') return json(res, 400, {error: `Role must be one of ${org.ROLES.join(', ')}`, code: 'invalid-role'});
        if (result.error === 'not-found') return json(res, 404, {error: 'No such member of this organization', code: 'not-found'});
        return json(res, 200, {member: result.member, changed: result.changed});
      } catch (err) {
        return sendRefusal(json, res, err);
      }
    }

    // ── Remove someone from the organization ──
    if (req.method === 'DELETE' && !action) {
      if (!manages) return json(res, 403, {error: 'Only an owner or admin can remove people'});
      if (!rateLimit(`org-remove:${userId}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const result = await org.removeMember({headers: req.headers, orgId, actorId: userId, memberId});
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
