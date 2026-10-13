const crypto = require('crypto');
const {fromNodeHeaders} = require('better-auth/node');
const {withRequestContext} = require('./client');
const {githubProfile, githubLoginOf} = require('../github-users');

const ROLES = Object.freeze(['owner', 'editor', 'viewer']);
const MANAGER_ROLES = Object.freeze(['owner']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const FIRST_CHANNEL = 'general';
const AUDIT_LIMIT = 200;
// How long a GitHub invitation stands, as Better Auth's default for its own.
const GITHUB_INVITATION_MS = 48 * 3600 * 1000;

const canManage = role => String(role ?? '').split(',').some(item => MANAGER_ROLES.includes(item.trim()));
const labelFor = user => user?.name || user?.email || 'someone';
const slugify = name => String(name ?? '').normalize('NFKD').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');

function createPostgresOrg({pool, auth, removeMemberChannels = null, now = () => new Date().toISOString(), newId = () => crypto.randomUUID()}) {
  if (!auth?.api) throw new Error('Better Auth is required for PostgreSQL workspace lifecycle');
  const scoped = (userId, workspaceId, operation) => withRequestContext(pool, {userId, workspaceId}, operation);

  async function record(client, {orgId, action, actorId, targetId = null, targetLabel, detail = null}) {
    const actor = (await client.query('select coalesce(display_name, email) as label from app_user where id = $1', [actorId])).rows[0];
    await client.query(
      `insert into workspace_audit(id, workspace_id, action, actor_id, actor_label, target_id, target_label, detail, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [newId(), orgId, action, actorId, actor?.label || 'someone', targetId, targetLabel || 'someone', detail ? JSON.stringify(detail) : null, now()],
    );
  }

  async function listMemberships(userId) {
    if (!userId) return [];
    return scoped(userId, null, async client => (await client.query(
      `select id, name, slug, role, joined_at as "joinedAt", member_count as "memberCount"
         from list_user_workspaces($1)`, [userId],
    )).rows);
  }

  async function getOrganization(orgId, userId) {
    return scoped(userId, orgId, async client => (await client.query(
      `select w.id, w.name, w.slug, w.created_at as "createdAt",
              (select count(*)::int from workspace_member m where m.workspace_id = w.id) as "memberCount"
         from workspace w where w.id = $1 and w.status = 'active'`, [orgId],
    )).rows[0] ?? null);
  }

  async function listMembers(orgId, viewerId) {
    return scoped(viewerId, orgId, async client => (await client.query(
      `select m.id as "memberId", m.role, m.created_at as "joinedAt", u.id,
              coalesce(u.display_name, u.email) as username, u.display_name as name, u.email, u.image,
              (select c.id from channel c
                join channel_member mine on mine.channel_id = c.id and mine.user_id = $1
                join channel_member theirs on theirs.channel_id = c.id and theirs.user_id = u.id and theirs.user_id <> mine.user_id
               where c.workspace_id = $2 and c.kind = 'dm' limit 1) as "dmChannelId"
         from workspace_member m join app_user u on u.id = m.user_id
        where m.workspace_id = $2 order by coalesce(u.display_name, u.email), u.id`, [viewerId, orgId],
    )).rows.map(row => ({...row, you: row.id === viewerId})));
  }

  async function findMember(orgId, actorId, memberId) {
    return scoped(actorId, orgId, async client => (await client.query(
      `select m.id as "memberId", m.role, m.user_id as "userId",
              coalesce(u.display_name, u.email) as username, u.display_name as name, u.email
         from workspace_member m join app_user u on u.id = m.user_id
        where m.id = $1 and m.workspace_id = $2`, [memberId, orgId],
    )).rows[0] ?? null);
  }

  async function createWorkspace({actorId, name, slug}) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 60) return {error: 'invalid-name'};
    const chosen = String(slug ?? '').trim().toLowerCase();
    const base = chosen || slugify(clean);
    if (!SLUG_RE.test(base)) return {error: 'invalid-slug'};

    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = attempt === 1 ? base : `${base.slice(0, 37).replace(/-+$/, '')}-${attempt}`;
      if (chosen && attempt > 1) return {error: 'slug-taken'};
      const taken = (await pool.query('select 1 from workspace where lower(slug) = lower($1) limit 1', [candidate])).rows[0];
      if (taken) continue;
      try {
        const created = await auth.api.createOrganization({
          body: {
            name: clean,
            slug: candidate,
            userId: actorId,
            keepCurrentActiveOrganization: true,
          },
        });
        return {organization: {id: created.id, name: created.name, slug: created.slug, role: 'owner', memberCount: 1}, channel: FIRST_CHANNEL};
      } catch (error) {
        if (error?.code === '23505') continue;
        throw error;
      }
    }
    return {error: 'slug-taken'};
  }

  const archiveWorkspace = context => scoped(context.userId, context.workspaceId, async client =>
    (await client.query("update workspace set status = 'archived', archived_at = $1 where id = $2 and status = 'active'", [now(), context.workspaceId])).rowCount > 0);
  const deleteWorkspace = context => scoped(context.userId, context.workspaceId, async client =>
    Number((await client.query('select delete_workspace_and_queue_assets($1) as queued', [context.workspaceId])).rows[0]?.queued ?? 0));

  // An invitation goes to an email address (Better Auth's workspace_invitation)
  // or to a GitHub account (workspace_github_invitation), as ../org.js.
  async function listInvitations(orgId, actorId) {
    return scoped(actorId, orgId, async client => (await client.query(
      `select i.id, i.email, null as "githubLogin", i.role, i.expires_at as "expiresAt",
              coalesce(u.display_name, u.email) as "invitedBy"
         from workspace_invitation i left join app_user u on u.id = i.invited_by
        where i.workspace_id = $1 and i.status = 'pending'
       union all
       select g.id, null, g.github_login, g.role, g.expires_at, coalesce(u.display_name, u.email)
         from workspace_github_invitation g left join app_user u on u.id = g.invited_by
        where g.workspace_id = $1 and g.status = 'pending'
        order by "expiresAt" desc`, [orgId],
    )).rows.map(row => ({...row, expired: new Date(row.expiresAt).getTime() < Date.now()})));
  }

  async function invitationForLink(invitationId) {
    const row = (await pool.query(
      `select i.id, i.email, null as github_id, null as github_login, i.role, i.status, i.expires_at, i.workspace_id,
              w.name as workspace_name, coalesce(u.display_name, u.email) as inviter_name
         from workspace_invitation i
         join workspace w on w.id = i.workspace_id
         left join app_user u on u.id = i.invited_by
        where i.id = $1
       union all
       select g.id, null, g.github_id, g.github_login, g.role, g.status, g.expires_at, g.workspace_id,
              w.name, coalesce(u.display_name, u.email)
         from workspace_github_invitation g
         join workspace w on w.id = g.workspace_id
         left join app_user u on u.id = g.invited_by
        where g.id = $1`,
      [invitationId],
    )).rows[0];
    if (!row) return null;
    return {
      id: row.id, email: row.email, githubId: row.github_id, githubLogin: row.github_login, role: row.role, status: row.status,
      expired: new Date(row.expires_at).getTime() < Date.now(),
      organization: row.workspace_name, invitedBy: row.inviter_name || 'someone', organizationId: row.workspace_id,
    };
  }

  async function pendingInvitationsFor(userId) {
    return (await pool.query(
      `select id, role, organization, "invitedBy" from (
         select i.id, i.role, w.name as organization, coalesce(u.display_name, u.email, 'someone') as "invitedBy", i.created_at
           from app_user me
           join workspace_invitation i on i.email = lower(me.email)
           join workspace w on w.id = i.workspace_id and w.status = 'active'
           left join app_user u on u.id = i.invited_by
          where me.id = $1 and i.status = 'pending' and i.expires_at > now()
         union all
         select g.id, g.role, w.name, coalesce(u.display_name, u.email, 'someone'), g.created_at
           from auth_account a
           join workspace_github_invitation g on g.github_id = a.account_id
           join workspace w on w.id = g.workspace_id and w.status = 'active'
           left join app_user u on u.id = g.invited_by
          where a.user_id = $1 and a.provider_id = 'github' and g.status = 'pending' and g.expires_at > now()
       ) pending order by created_at`,
      [userId],
    )).rows;
  }

  async function invite({headers, orgId, actorId, email, role = 'viewer'}) {
    if (!ROLES.includes(role)) return {error: 'invalid-role'};
    const clean = String(email ?? '').trim().toLowerCase();
    if (!clean) return {error: 'invalid-email'};
    const invitation = await auth.api.createInvitation({
      body: {email: clean, role, organizationId: orgId, resend: true},
      headers: fromNodeHeaders(headers),
    });
    await scoped(actorId, orgId, client => record(client, {
      orgId, action: 'member.invite', actorId, targetLabel: clean, detail: {role},
    }));
    const preview = await invitationForLink(invitation.id);
    return {invitation: preview};
  }

  async function mayInvite(headers, orgId, action) {
    const {success} = await auth.api.hasPermission({
      body: {organizationId: orgId, permissions: {invitation: [action]}},
      headers: fromNodeHeaders(headers),
    });
    return success;
  }

  async function inviteGithub({headers, orgId, actorId, githubLogin, role = 'viewer', fetchImpl}) {
    if (!ROLES.includes(role)) return {error: 'invalid-role'};
    const login = githubLoginOf(githubLogin);
    if (!login) return {error: 'invalid-github-login'};
    if (!await mayInvite(headers, orgId, 'create')) return {error: 'forbidden'};
    const profile = await githubProfile(login, fetchImpl);
    if (!profile) return {error: 'github-user-not-found'};
    const githubId = String(profile.id);
    const member = (await pool.query(
      `select 1 from workspace_member m join auth_account a on a.user_id = m.user_id and a.provider_id = 'github'
        where m.workspace_id = $1 and a.account_id = $2`, [orgId, githubId],
    )).rows[0];
    if (member) return {error: 'already-member'};
    const expiresAt = new Date(Date.now() + GITHUB_INVITATION_MS);
    const pending = (await pool.query(
      `update workspace_github_invitation set github_login = $3, role = $4, expires_at = $5, invited_by = $6
        where workspace_id = $1 and github_id = $2 and status = 'pending' returning id`,
      [orgId, githubId, profile.login, role, expiresAt, actorId],
    )).rows[0];
    const id = pending?.id ?? newId();
    if (!pending) {
      await pool.query(
        `insert into workspace_github_invitation (id, workspace_id, github_id, github_login, role, expires_at, invited_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, orgId, githubId, profile.login, role, expiresAt, actorId],
      );
    }
    await scoped(actorId, orgId, client => record(client, {
      orgId, action: 'member.invite', actorId, targetLabel: `@${profile.login}`, detail: {role},
    }));
    return {invitation: await invitationForLink(id)};
  }

  const inviteeLabel = invitation => invitation.email ?? `@${invitation.githubLogin}`;

  async function cancelInvitation({headers, orgId, actorId, invitationId}) {
    const before = await invitationForLink(invitationId);
    if (!before || before.organizationId !== orgId) return {error: 'not-found'};
    if (before.githubId) {
      if (!await mayInvite(headers, orgId, 'cancel')) return {error: 'forbidden'};
      await pool.query(`update workspace_github_invitation set status = 'canceled' where id = $1`, [invitationId]);
    } else {
      await auth.api.cancelInvitation({
        body: {invitationId},
        headers: fromNodeHeaders(headers),
      });
    }
    await scoped(actorId, orgId, client => record(client, {
      orgId, action: 'member.invite-cancel', actorId, targetLabel: inviteeLabel(before),
    }));
    return {cancelled: inviteeLabel(before)};
  }

  async function acceptInvitation({headers, actorId, invitationId}) {
    const before = await invitationForLink(invitationId);
    if (!before) return {error: 'not-found'};
    let member;
    if (before.githubId) {
      if (before.status !== 'pending' || before.expired) return {error: 'not-found'};
      const githubId = (await pool.query(
        `select account_id from auth_account where user_id = $1 and provider_id = 'github'`, [actorId],
      )).rows[0]?.account_id ?? null;
      if (githubId !== before.githubId) return {error: 'not-recipient', githubLogin: before.githubLogin};
      member = await auth.api.addMember({body: {userId: actorId, organizationId: before.organizationId, role: before.role}});
      await pool.query(`update workspace_github_invitation set status = 'accepted' where id = $1`, [invitationId]);
      await auth.api.setActiveOrganization({body: {organizationId: before.organizationId}, headers: fromNodeHeaders(headers)});
    } else {
      member = (await auth.api.acceptInvitation({
        body: {invitationId},
        headers: fromNodeHeaders(headers),
      }))?.member;
    }
    await scoped(actorId, before.organizationId, client => record(client, {
      orgId: before.organizationId, action: 'member.join', actorId, targetId: actorId,
      targetLabel: inviteeLabel(before), detail: {invitedBy: before.invitedBy, role: before.role},
    }));
    return {member: member ?? null, organizationId: before.organizationId};
  }

  async function setMemberRole({headers, orgId, actorId, memberId, role}) {
    if (!ROLES.includes(role)) return {error: 'invalid-role'};
    const before = await findMember(orgId, actorId, memberId);
    if (!before) return {error: 'not-found'};
    if (before.role === role) return {member: before, changed: false};
    await auth.api.updateMemberRole({
      body: {memberId, role, organizationId: orgId},
      headers: fromNodeHeaders(headers),
    });
    await scoped(actorId, orgId, client => record(client, {
      orgId, action: 'member.role', actorId, targetId: before.userId,
      targetLabel: before.username, detail: {from: before.role, to: role},
    }));
    return {member: await findMember(orgId, actorId, memberId), changed: true};
  }

  async function removeMember({headers, orgId, actorId, memberId}) {
    const before = await findMember(orgId, actorId, memberId);
    if (!before) return {error: 'not-found'};
    await auth.api.removeMember({
      body: {memberIdOrEmail: memberId, organizationId: orgId},
      headers: fromNodeHeaders(headers),
    });
    await scoped(actorId, orgId, client => record(client, {
      orgId, action: 'member.remove', actorId, targetId: before.userId, targetLabel: before.username,
    }));
    return {removed: before};
  }

  /** Leave a workspace. Better Auth refuses the last owner; it runs no member hooks, so channels are cleared here. */
  async function leaveWorkspace({headers, orgId, actorId}) {
    if (!removeMemberChannels) throw new Error('Leaving a workspace requires removeMemberChannels');
    const before = await scoped(actorId, orgId, async client => (await client.query(
      `select m.id as "memberId", coalesce(u.display_name, u.email) as label
         from workspace_member m join app_user u on u.id = m.user_id
        where m.workspace_id = $1 and m.user_id = $2`, [orgId, actorId],
    )).rows[0] ?? null);
    if (!before) return {error: 'not-found'};
    await auth.api.leaveOrganization({body: {organizationId: orgId}, headers: fromNodeHeaders(headers)});
    await removeMemberChannels({member: {userId: actorId}, organization: {id: orgId}});
    await scoped(actorId, orgId, client => record(client, {
      orgId, action: 'member.leave', actorId, targetId: actorId, targetLabel: before.label,
    }));
    return {left: true};
  }

  async function listAudit(orgId, limit = AUDIT_LIMIT, actorId) {
    const capped = Math.min(Math.max(Number(limit) || AUDIT_LIMIT, 1), AUDIT_LIMIT);
    return scoped(actorId, orgId, async client => (await client.query(
      `select id, action, actor_id as "actorId", actor_label as "actorLabel", target_id as "targetId",
              target_label as "targetLabel", detail, at from workspace_audit
        where workspace_id = $1 order by at desc, id desc limit $2`, [orgId, capped],
    )).rows);
  }

  return {
    ROLES, MANAGER_ROLES, SLUG_RE, FIRST_CHANNEL, AUDIT_LIMIT, canManage, labelFor, slugify,
    listMemberships, getOrganization, listMembers, createWorkspace, archiveWorkspace, deleteWorkspace,
    listInvitations, invitationForLink, pendingInvitationsFor, invite, inviteGithub, cancelInvitation, acceptInvitation, setMemberRole, removeMember,
    leaveWorkspace,
    listAudit,
    slugForOrg: () => null,
    allOrganizations: async () => (await pool.query('select * from list_scheduled_workspaces()')).rows.map(row => ({
      id: row.id, slug: row.slug, name: row.name, ownerId: row.owner_id,
    })),
  };
}

module.exports = {createPostgresOrg, ROLES, MANAGER_ROLES, SLUG_RE, FIRST_CHANNEL, canManage, slugify};
