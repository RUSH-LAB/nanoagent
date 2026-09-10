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
 *
 * It also owns the beginning. Creating a workspace and moving between them are
 * the two things somebody does before they are in an organization at all, so
 * they are the only functions here that do not take one; they exist because a
 * new account otherwise signs in successfully and finds that every page which
 * belongs to an organization has nothing to show it.
 */
const crypto = require('crypto');
const {fromNodeHeaders} = require('better-auth/node');
const {PRIMARY_ORG_SLUG} = require('./paths');
const {db} = require('./db');
const {auth} = require('./auth');
const audit = require('./audit');

/** Workspace roles, most privileged first. */
const ROLES = Object.freeze(['owner', 'editor', 'viewer']);

/** The roles that may manage other people. */
const MANAGER_ROLES = Object.freeze(['owner']);

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
  return user?.name || user?.email || 'someone';
}

/** The organization itself, or null when the caller is not in it. */
function getOrganization(orgId, userId) {
  const row = db
    .prepare(
      `SELECT o.id, o.name, o.slug, o.createdAt,
              (SELECT COUNT(*) FROM member m WHERE m.organizationId = o.id) AS memberCount
         FROM organization o
         JOIN member m ON m.organizationId = o.id AND m.userId = ?
        WHERE o.id = ? AND o.status = 'active'`,
    )
    .get(userId, orgId);
  return row ?? null;
}

/**
 * Everyone in the organization, including the caller.
 *
 * The caller is in the list because this is the roster a directory shows, and
 * leaving yourself out of a list of who is here reads as a bug. `you` marks the
 * row instead. The ordinary dm subquery requires its two joined sides to be
 * different so it cannot mistake one of the caller's other conversations for
 * their self-chat; the channel directory identifies that special one directly.
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
              u.id, COALESCE(u.name, u.email) AS username, u.name, u.email,
              (SELECT c.id FROM channel c
                 JOIN channel_member mine ON mine.channelId = c.id AND mine.userId = ?
                 JOIN channel_member theirs ON theirs.channelId = c.id
                                           AND theirs.userId = u.id
                                           AND theirs.userId != mine.userId
                WHERE c.organizationId = ? AND c.kind = 'dm') AS dmChannelId
         FROM member m
         JOIN "user" u ON u.id = m.userId
        WHERE m.organizationId = ?
        ORDER BY COALESCE(u.name, u.email) COLLATE NOCASE, u.id`,
    )
    .all(viewerId, orgId, orgId)
    .map(row => ({...row, you: row.id === viewerId}));
}

/** One membership, by the id the writes address it with. */
function findMember(orgId, memberId) {
  return db
    .prepare(
      `SELECT m.id AS memberId, m.role, m.userId,
              COALESCE(u.name, u.email) AS username, u.name, u.email
         FROM member m JOIN "user" u ON u.id = m.userId
        WHERE m.id = ? AND m.organizationId = ?`,
    )
    .get(memberId, orgId) ?? null;
}

/* ── Starting one, and moving between them ────────────────────────── */

/**
 * The channel a new workspace opens with.
 *
 * An organization with no channels answers every chat read with an empty list
 * and offers a new arrival nothing to click, which reads as a broken product
 * rather than an empty one. The same reasoning, and the same channel name, as
 * the root workspace in ./dev-auth.
 */
const FIRST_CHANNEL = 'general';

/**
 * What a slug may look like: 2 to 40 characters of lowercase letters, digits,
 * and inner dashes. It goes in URLs and gets read back out of them, so no
 * leading or trailing dash and nothing that needs escaping.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/**
 * A slug derived from a workspace name, for the common case where nobody wants
 * to think about one.
 *
 * NFKD first, so an accented letter decomposes into a plain one plus a
 * combining mark and the mark is what gets dropped: "Café" becomes "cafe"
 * rather than "caf". A name in a script with no ASCII form reduces to nothing,
 * and the caller is asked for a slug instead of being given a meaningless one.
 */
function slugify(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** Whether any organization already answers to this slug. */
function slugTaken(slug) {
  return Boolean(db.prepare('SELECT 1 FROM organization WHERE slug = ?').get(slug));
}

/**
 * The stable slug of `orgId`.
 *
 * Memoized because every request that touches a file asks for it, and the
 * answer cannot change because workspace renaming is not currently offered. A
 * miss is a single indexed lookup on a primary key.
 */
const slugCache = new Map();

function slugForOrg(orgId) {
  if (!orgId) return null;
  if (slugCache.has(orgId)) return slugCache.get(orgId);
  const row = db.prepare('SELECT slug FROM organization WHERE id = ?').get(orgId);
  const slug = row?.slug ?? null;
  // Only a hit is remembered. A miss means the organization is not there yet,
  // which during provisioning is a moment rather than a fact.
  if (slug) slugCache.set(orgId, slug);
  return slug;
}

/** For the tests, and for anything that does eventually learn to rename. */
slugForOrg.forget = orgId => (orgId ? slugCache.delete(orgId) : slugCache.clear());

/**
 * The id of the workspace a caller with no active one is treated as being in.
 *
 * The primary workspace id used only by explicitly unauthenticated local mode
 * and public compatibility endpoints.
 *
 * Two callers have no active workspace: the public feeds, which nobody is
 * signed in to, and every request when ENABLE_AUTH is off, which is the test
 * suites and `npm run start:noauth`. Sending those to the primary workspace is
 * what makes both behave as they did when there was only one.
 *
 * Returns null when the primary workspace does not exist yet, which is a clean
 * checkout before anything has been provisioned. The store turns that into a
 * 409 rather than inventing somewhere to write.
 *
 * Memoized like slugForOrg, and for the same reason: asked on every request
 * that touches data, and the answer cannot change. Only a hit is remembered,
 * because a miss during provisioning is a moment rather than a fact.
 */
let primaryOrgIdCache = null;

function primaryOrgId() {
  if (primaryOrgIdCache) return primaryOrgIdCache;
  const row = db.prepare('SELECT id FROM organization WHERE slug = ?').get(PRIMARY_ORG_SLUG);
  if (row?.id) primaryOrgIdCache = row.id;
  return row?.id ?? null;
}

/** For the tests, which create and destroy workspaces within one process. */
primaryOrgId.forget = () => {
  primaryOrgIdCache = null;
};

/**
 * Every workspace on this server, oldest first.
 *
 * The one read that belongs to no caller. Background work serves all of them
 * and has no session to scope itself by: the scheduled-publish loop in
 * server/index.js runs once a minute for the whole machine and has to ask each
 * workspace what it has due. Not memoized, because unlike a slug the answer
 * changes whenever somebody creates one.
 */
function allOrganizations() {
  return db.prepare('SELECT id, slug, name FROM organization ORDER BY createdAt, rowid').all();
}

/**
 * `base`, or the first numbered variant of it that is free.
 *
 * Only used for a slug we derived. A slug somebody typed is a choice, and
 * quietly giving them a different one is worse than telling them it is taken.
 * Returns null if even the variants are exhausted, which needs 99 workspaces
 * with the same name and is a refusal rather than a hundredth guess.
 */
function availableSlug(base) {
  if (!slugTaken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 37).replace(/-+$/, '')}-${n}`;
    if (!slugTaken(candidate)) return candidate;
  }
  return null;
}

/**
 * Every organization the caller belongs to, oldest membership first, with the
 * role they hold in each.
 *
 * The one read that does not take an organization id, because it is what the
 * caller asks before they have one: the sign-up gate uses an empty answer to
 * decide that somebody needs to create or join a workspace, and the switcher
 * uses a non-empty one to offer the rest.
 *
 * Ties on `createdAt` are broken by rowid, the order the rows were written, so
 * that this list opens with the same workspace a fresh session does. Two
 * memberships can share a millisecond, and the ids are random strings, so
 * ordering by one would have put the switcher's first entry and the session's
 * active workspace in disagreement at random. Same tie as ./audit.
 */
function listMemberships(userId) {
  return db
    .prepare(
      `SELECT o.id, o.name, o.slug, m.role, m.createdAt AS joinedAt,
              (SELECT COUNT(*) FROM member m2 WHERE m2.organizationId = o.id) AS memberCount
         FROM member m
         JOIN organization o ON o.id = m.organizationId
        WHERE m.userId = ? AND o.status = 'active'
        ORDER BY m.createdAt, m.rowid`,
    )
    .all(userId);
}

/**
 * Create a workspace with the caller as its owner, and open a #general in it.
 *
 * The organization, owner membership, and default settings are one database
 * transaction. The URL, not activeOrganizationId, selects it afterwards.
 *
 * The channel is best-effort on purpose. A workspace that exists without a
 * #general is recoverable in one click; a create that reports failure after
 * having created the organization is not.
 */
async function createWorkspace({headers, actorId, name, slug}) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 60) return {error: 'invalid-name'};

  const chosen = String(slug ?? '').trim().toLowerCase();
  const wanted = chosen || slugify(clean);
  if (!SLUG_RE.test(wanted)) return {error: 'invalid-slug'};

  // Numbered only when we derived it. A typed one that is taken is refused, and
  // refused here rather than by Better Auth, whose "Organization already exists"
  // is about the organization when what is taken is only its short name. The
  // plugin still checks, so this is the better sentence and not the guarantee.
  const free = chosen ? (slugTaken(chosen) ? null : chosen) : availableSlug(wanted);
  if (!free) return {error: 'slug-taken'};

  // Server-side creation names the authenticated actor explicitly. Better Auth
  // owns the organization and owner-membership writes; its lifecycle hook
  // provisions Mochi's settings and #general resources idempotently.
  const organization = await auth.api.createOrganization({
    body: {
      name: clean,
      slug: free,
      userId: actorId,
      keepCurrentActiveOrganization: true,
    },
  });

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: 'owner',
      memberCount: 1,
    },
    channel: FIRST_CHANNEL,
  };
}

function archiveWorkspace(context) {
  const changed = db.prepare(
    "UPDATE organization SET status = 'archived', archivedAt = ? WHERE id = ? AND status = 'active'",
  ).run(new Date().toISOString(), context.workspaceId).changes;
  slugForOrg.forget(context.workspaceId);
  return changed > 0;
}

function deleteWorkspace(context) {
  slugForOrg.forget(context.workspaceId);
  return db.transaction(() => {
    const assets = db.prepare('SELECT objectKey FROM asset WHERE organizationId = ?').all(context.workspaceId);
    const enqueue = db.prepare(`INSERT OR IGNORE INTO object_deletion
      (id, workspaceId, objectKey, requestedAt) VALUES (?, ?, ?, ?)`);
    const at = new Date().toISOString();
    for (const asset of assets) enqueue.run(crypto.randomUUID(), context.workspaceId, asset.objectKey, at);
    return db.prepare('DELETE FROM organization WHERE id = ?').run(context.workspaceId).changes > 0;
  })();
}

/* ── Invitations ──────────────────────────────────────────────────── */

/** The invitations still outstanding, with who sent each and whether it has run out. */
function listInvitations(orgId) {
  const at = Date.now();
  return db
    .prepare(
      `SELECT i.id, i.email, i.role, i.status, i.expiresAt, i.inviterId,
              u.name AS inviterUsername, u.name AS inviterName
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
              u.name AS inviterUsername, u.name AS inviterName
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
async function invite({headers, orgId, actorId, email, role = 'viewer'}) {
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
    targetLabel: labelFor(db.prepare('SELECT name, email FROM "user" WHERE id = ?').get(actorId)),
    detail: {invitedBy: before.invitedBy, role: before.role},
  });
  return {member: result?.member ?? null, organizationId: before.organizationId};
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
  ROLES, MANAGER_ROLES, SLUG_RE, FIRST_CHANNEL,
  /** The audit is its own module; these are here so callers need one import. */
  AUDIT_LIMIT: audit.LIMIT,
  listAudit: audit.list,
  canManage, labelFor,
  slugify, slugTaken, availableSlug, slugForOrg, primaryOrgId, allOrganizations,
  listMemberships, createWorkspace, archiveWorkspace, deleteWorkspace,
  getOrganization, listMembers, findMember,
  listInvitations, invitationForLink, invite, cancelInvitation, acceptInvitation,
  setMemberRole, removeMember,
};
