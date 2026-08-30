/**
 * The organization as a thing you administer: who is in it, what they may do,
 * and a record of every change to that.
 *
 * The rules about membership are not reimplemented here. Better Auth's
 * organization plugin already decides them, and it decides them well: only an
 * owner may promote to owner or touch another owner, the last owner cannot be
 * removed or demoted, and admins may manage ordinary members. Writing a second
 * copy of that policy would mean two answers to the same question, and the
 * wrong one would be whichever was checked. So the writes below delegate to
 * `auth.api`, passing the caller's own headers so the plugin sees the real
 * session and applies those rules to it.
 *
 * What this module adds is the part the plugin cannot: reads shaped for a
 * member list, and the audit row. The audit itself lives in ./audit, shared
 * with the channel administration in ./chat, and it is written here inside each
 * write rather than by each caller, because a trail a caller can forget to
 * leave is not one.
 */
const {fromNodeHeaders} = require('better-auth/node');
const {db} = require('./db');
const {auth} = require('./auth');
const audit = require('./audit');

/** Organization roles, most privileged first. Better Auth's own set. */
const ROLES = Object.freeze(['owner', 'admin', 'member']);

/** The roles that may manage other people. */
const MANAGER_ROLES = Object.freeze(['owner', 'admin']);

/**
 * Whether `role` may manage membership.
 *
 * A member may hold several roles as a comma-separated string, so this asks
 * whether any of them qualifies rather than comparing the whole field.
 */
function canManage(role) {
  if (!role) return false;
  return String(role).split(',').some(r => MANAGER_ROLES.includes(r.trim()));
}

/** What a person is called, for a label that has to survive their account. */
function labelFor(user) {
  return user?.username || user?.name || user?.email || 'someone';
}

/** The organization itself, or null when the caller is not in it. */
function getOrganization(orgId, userId) {
  const row = db
    .prepare(
      `SELECT o.id, o.name, o.slug, o.createdAt,
              (SELECT COUNT(*) FROM member m WHERE m.organizationId = o.id) AS memberCount
         FROM organization o
         JOIN member m ON m.organizationId = o.id AND m.userId = ?
        WHERE o.id = ?`,
    )
    .get(userId, orgId);
  return row ?? null;
}

/**
 * Everyone in the organization, including the caller.
 *
 * The caller is in the list because this is the roster a directory shows, and
 * leaving yourself out of a list of who is here reads as a bug. `you` marks the
 * row instead, and `dmChannelId` is null on it: the dm subquery requires the
 * two sides to be different people, which is also what openDm requires.
 *
 * `memberId` is the membership, not the account, and it is what the writes
 * below address. The distinction matters: the same account in two
 * organizations is two memberships with two roles.
 */
function listMembers(orgId, viewerId) {
  if (!db.prepare('SELECT 1 FROM member WHERE organizationId = ? AND userId = ?').get(orgId, viewerId)) {
    return [];
  }
  return db
    .prepare(
      `SELECT m.id AS memberId, m.role, m.createdAt AS joinedAt,
              u.id, u.username, u.name, u.email,
              (SELECT c.id FROM channel c
                 JOIN channel_member mine ON mine.channelId = c.id AND mine.userId = ?
                 JOIN channel_member theirs ON theirs.channelId = c.id
                                           AND theirs.userId = u.id
                                           AND theirs.userId != mine.userId
                WHERE c.organizationId = ? AND c.kind = 'dm') AS dmChannelId
         FROM member m
         JOIN "user" u ON u.id = m.userId
        WHERE m.organizationId = ?
        ORDER BY u.username COLLATE NOCASE, u.id`,
    )
    .all(viewerId, orgId, orgId)
    .map(row => ({...row, you: row.id === viewerId}));
}

/** One membership, by the id the writes address it with. */
function findMember(orgId, memberId) {
  return db
    .prepare(
      `SELECT m.id AS memberId, m.role, m.userId, u.username, u.name, u.email
         FROM member m JOIN "user" u ON u.id = m.userId
        WHERE m.id = ? AND m.organizationId = ?`,
    )
    .get(memberId, orgId) ?? null;
}

/* ── Invitations ──────────────────────────────────────────────────── */

/** The invitations still outstanding, with who sent each and whether it has run out. */
function listInvitations(orgId) {
  const at = Date.now();
  return db
    .prepare(
      `SELECT i.id, i.email, i.role, i.status, i.expiresAt, i.inviterId,
              u.username AS inviterUsername, u.name AS inviterName
         FROM invitation i
         LEFT JOIN "user" u ON u.id = i.inviterId
        WHERE i.organizationId = ? AND i.status = 'pending'
        ORDER BY i.expiresAt DESC`,
    )
    .all(orgId)
    .map(row => ({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt,
      expired: new Date(row.expiresAt).getTime() < at,
      invitedBy: row.inviterUsername || row.inviterName || 'someone',
    }));
}

/**
 * One invitation, by the id in its link.
 *
 * The route serving this to a signed-out visitor picks from it: which workspace
 * the link is for, who sent it, and which address it was sent to, because
 * accepting requires an account with that address and they would otherwise have
 * to guess. Everything else, the organization id included, stays here.
 */
function invitationForLink(invitationId) {
  const row = db
    .prepare(
      `SELECT i.id, i.email, i.role, i.status, i.expiresAt, i.organizationId,
              o.name AS organizationName,
              u.username AS inviterUsername, u.name AS inviterName
         FROM invitation i
         JOIN organization o ON o.id = i.organizationId
         LEFT JOIN "user" u ON u.id = i.inviterId
        WHERE i.id = ?`,
    )
    .get(invitationId);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expired: new Date(row.expiresAt).getTime() < Date.now(),
    organization: row.organizationName,
    invitedBy: row.inviterUsername || row.inviterName || 'someone',
    organizationId: row.organizationId,
  };
}

/**
 * Invite an email address into the organization.
 *
 * There is no mail server, so nothing is sent: the invitation is a row, and the
 * link to it is what the inviter copies and passes on. That is a smaller
 * feature than Slack's, and an honest one; configuring `sendInvitationEmail`
 * later makes the same row arrive by post without changing anything here.
 */
async function invite({headers, orgId, actorId, email, role = 'member'}) {
  if (!ROLES.includes(role)) return {error: 'invalid-role'};
  const clean = String(email ?? '').trim().toLowerCase();
  if (!clean) return {error: 'invalid-email'};

  // resend: true so that inviting the same address twice refreshes the existing
  // invitation rather than refusing, which is what "I lost the link" needs.
  const invitation = await auth.api.createInvitation({
    body: {email: clean, role, organizationId: orgId, resend: true},
    headers: fromNodeHeaders(headers),
  });

  audit.record({orgId, action: 'member.invite', actorId, targetLabel: clean, detail: {role}});
  return {invitation: invitationForLink(invitation.id)};
}

/** Withdraw an invitation that has not been accepted. */
async function cancelInvitation({headers, orgId, actorId, invitationId}) {
  const before = invitationForLink(invitationId);
  if (!before || before.organizationId !== orgId) return {error: 'not-found'};

  await auth.api.cancelInvitation({
    body: {invitationId},
    headers: fromNodeHeaders(headers),
  });
  audit.record({orgId, action: 'member.invite-cancel', actorId, targetLabel: before.email});
  return {cancelled: before.email};
}

/**
 * Accept an invitation as the caller.
 *
 * Better Auth checks that the session's address is the invited one, that the
 * invitation is still pending, and that it has not expired, then creates the
 * membership and makes the organization the session's active one. All this adds
 * is the record that somebody joined.
 */
async function acceptInvitation({headers, actorId, invitationId}) {
  const before = invitationForLink(invitationId);
  if (!before) return {error: 'not-found'};

  const result = await auth.api.acceptInvitation({
    body: {invitationId},
    headers: fromNodeHeaders(headers),
  });
  audit.record({
    orgId: before.organizationId,
    action: 'member.join',
    actorId,
    targetId: actorId,
    targetLabel: labelFor(db.prepare('SELECT username, name, email FROM "user" WHERE id = ?').get(actorId)),
    detail: {invitedBy: before.invitedBy, role: before.role},
  });
  return {member: result?.member ?? null, organizationId: before.organizationId};
}

/**
 * Create an account and put it straight into the organization.
 *
 * Not something Slack has, and not something a hosted product should: whoever
 * does this chooses the password, so they know it. It exists because this one
 * runs on a laptop, where the reason to add a person is usually to have a
 * second person to test with, and the alternative is a script.
 *
 * Restricted to owners by the route, and written down like every other way
 * somebody gets in.
 */
async function createAccount({orgId, actorId, username, password, email, name, role = 'member'}) {
  if (!ROLES.includes(role)) return {error: 'invalid-role'};
  const handle = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(handle)) return {error: 'invalid-username'};
  if (String(password ?? '').length < 8) return {error: 'weak-password'};

  const address = String(email ?? '').trim().toLowerCase() || `${handle}@mochi.local`;
  let created;
  try {
    created = await auth.api.signUpEmail({
      body: {email: address, password, name: String(name ?? '').trim() || handle, username: handle},
    });
  } catch (err) {
    // An address or handle already taken is the ordinary case here, and the
    // message Better Auth gives says which.
    return {error: 'signup-failed', reason: err?.body?.message || err.message};
  }

  await auth.api.addMember({body: {userId: created.user.id, organizationId: orgId, role}});
  audit.record({
    orgId, action: 'member.create', actorId,
    targetId: created.user.id, targetLabel: handle, detail: {role},
  });
  return {user: {id: created.user.id, username: handle, email: address}, role};
}

/* ── Writes, delegated ────────────────────────────────────────────── */

/**
 * Change a member's role.
 *
 * `headers` are the caller's own, forwarded so Better Auth resolves the same
 * session the request arrived with and applies its permission rules to that
 * person rather than to the server.
 */
async function setMemberRole({headers, orgId, actorId, memberId, role}) {
  if (!ROLES.includes(role)) return {error: 'invalid-role'};
  const before = findMember(orgId, memberId);
  if (!before) return {error: 'not-found'};
  if (before.role === role) return {member: before, changed: false};

  await auth.api.updateMemberRole({
    body: {memberId, role, organizationId: orgId},
    headers: fromNodeHeaders(headers),
  });

  audit.record({
    orgId,
    action: 'member.role',
    actorId,
    targetId: before.userId,
    targetLabel: labelFor(before),
    detail: {from: before.role, to: role},
  });
  return {member: findMember(orgId, memberId), changed: true};
}

/**
 * Remove someone from the organization.
 *
 * Their messages stay. `message.userId` restricts rather than cascades, so a
 * conversation does not lose its replies when someone leaves; what they lose is
 * access, which is what removal means.
 */
async function removeMember({headers, orgId, actorId, memberId}) {
  const before = findMember(orgId, memberId);
  if (!before) return {error: 'not-found'};

  await auth.api.removeMember({
    body: {memberIdOrEmail: memberId, organizationId: orgId},
    headers: fromNodeHeaders(headers),
  });

  // Membership in the organization's channels is not membership in the
  // organization, and Better Auth knows nothing about channels. Left behind, it
  // would keep a removed account in #general's member count and, worse, let a
  // readmitted one walk back into every private channel it was once in.
  db.prepare(
    `DELETE FROM channel_member
      WHERE userId = ?
        AND channelId IN (SELECT id FROM channel WHERE organizationId = ?)`,
  ).run(before.userId, orgId);

  audit.record({
    orgId,
    action: 'member.remove',
    actorId,
    targetId: before.userId,
    targetLabel: labelFor(before),
  });
  return {removed: before};
}

module.exports = {
  ROLES, MANAGER_ROLES,
  /** The audit is its own module; these are here so callers need one import. */
  AUDIT_LIMIT: audit.LIMIT,
  listAudit: audit.list,
  canManage, labelFor,
  getOrganization, listMembers, findMember,
  listInvitations, invitationForLink, invite, cancelInvitation, acceptInvitation,
  createAccount,
  setMemberRole, removeMember,
};
