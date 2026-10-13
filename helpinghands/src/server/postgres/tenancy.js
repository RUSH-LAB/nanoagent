'use strict';
/**
 * The platform's tenancy rules: who may sign up, how many workspaces an account
 * may own, what each workspace may store and spend on the assistant, which
 * accounts are suspended, and the administration of all of it.
 *
 * Storage and member limits are also enforced by triggers (0011_tenancy.sql),
 * so a write path that never calls this module still cannot exceed them; the
 * checks here exist to refuse early with a message a person can act on.
 */
const {withRequestContext} = require('./client');

const SIGNUP_MODES = Object.freeze(['open', 'invite', 'allowlist']);
const AI_KINDS = Object.freeze(['chat', 'inline', 'complete', 'app', 'task', 'plugin']);
const AUDIT_LIMIT = 200;

// What each policy and workspace-limit field accepts. USD amounts are capped so
// a typo cannot lift a budget to something no one meant.
const LIMIT_FIELDS = Object.freeze({
  storageBytes: {column: 'storage_bytes', min: 0, max: 1024 ** 4, integer: true},
  maxMembers: {column: 'max_members', min: 1, max: 10_000, integer: true},
  aiDailyUsd: {column: 'ai_daily_usd', min: 0, max: 10_000},
  aiMonthlyUsd: {column: 'ai_monthly_usd', min: 0, max: 100_000},
  memberAiDailyUsd: {column: 'member_ai_daily_usd', min: 0, max: 10_000},
});
const POLICY_FIELDS = Object.freeze({
  maxWorkspacesPerUser: {column: 'max_workspaces_per_user', min: 0, max: 1_000, integer: true},
  workspaceStorageBytes: {column: 'workspace_storage_bytes', min: 0, max: 1024 ** 4, integer: true},
  workspaceMaxMembers: {column: 'workspace_max_members', min: 1, max: 10_000, integer: true},
  workspaceAiDailyUsd: {column: 'workspace_ai_daily_usd', min: 0, max: 10_000},
  workspaceAiMonthlyUsd: {column: 'workspace_ai_monthly_usd', min: 0, max: 100_000},
  memberAiDailyUsd: {column: 'member_ai_daily_usd', min: 0, max: 10_000},
});

class TenancyError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'TenancyError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const usd = value => `$${Number(value).toFixed(2)}`;

function validNumber(spec, value, name) {
  const number = Number(value);
  if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(number)
    || number < spec.min || number > spec.max || (spec.integer && !Number.isInteger(number))) {
    throw new TenancyError(400, 'invalid-limit', `${name} must be ${spec.integer ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max}`);
  }
  return number;
}

/** Lowercased addresses and @domains, deduplicated; anything else is refused. */
function normalizeAllowlist(entries) {
  if (!Array.isArray(entries)) throw new TenancyError(400, 'invalid-allowlist', 'signupAllowlist must be a list');
  const clean = [...new Set(entries.map(entry => String(entry ?? '').trim().toLowerCase()).filter(Boolean))];
  for (const entry of clean) {
    if (!/^(?:[^\s@]+)?@[a-z0-9.-]+\.[a-z]{2,}$/.test(entry)) {
      throw new TenancyError(400, 'invalid-allowlist', `"${entry}" is not an email address or @domain`);
    }
  }
  if (clean.length > 1000) throw new TenancyError(400, 'invalid-allowlist', 'The allowlist holds at most 1000 entries');
  return clean;
}

function allowlisted(allowlist, email) {
  const address = String(email ?? '').trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@'));
  return allowlist.includes(address) || allowlist.includes(domain);
}

function policyFromRow(row) {
  return {
    signupMode: row.signup_mode,
    signupAllowlist: row.signup_allowlist,
    maxWorkspacesPerUser: row.max_workspaces_per_user,
    workspaceStorageBytes: Number(row.workspace_storage_bytes),
    workspaceMaxMembers: row.workspace_max_members,
    workspaceAiDailyUsd: Number(row.workspace_ai_daily_usd),
    workspaceAiMonthlyUsd: Number(row.workspace_ai_monthly_usd),
    memberAiDailyUsd: Number(row.member_ai_daily_usd),
    updatedAt: row.updated_at,
  };
}

function limitsFromRow(row) {
  return {
    storageBytes: Number(row.storage_bytes),
    maxMembers: row.max_members,
    aiDailyUsd: Number(row.ai_daily_usd),
    aiMonthlyUsd: Number(row.ai_monthly_usd),
    memberAiDailyUsd: Number(row.member_ai_daily_usd),
  };
}

function createPostgresTenancy({pool}) {
  if (!pool) throw new Error('Tenancy requires a PostgreSQL pool');
  const asUser = (userId, workspaceId, operation) => withRequestContext(pool, {userId, workspaceId}, operation);

  async function labelOf(client, userId) {
    return (await client.query('select coalesce(display_name, email) as label from app_user where id = $1', [userId]))
      .rows[0]?.label ?? 'someone';
  }

  async function audit(client, {actorId, action, targetType, targetId = null, targetLabel = null, detail = null}) {
    await client.query(
      `insert into platform_audit(actor_id, actor_label, action, target_type, target_id, target_label, detail)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [actorId, await labelOf(client, actorId), action, targetType, targetId, targetLabel, detail ? JSON.stringify(detail) : null],
    );
  }

  async function requireAdmin(client, actorId) {
    const admin = (await client.query('select 1 from platform_admin where user_id = $1', [actorId])).rowCount > 0;
    if (!admin) throw new TenancyError(403, 'not-platform-admin', 'Only platform administrators can do that');
  }

  // ── Policy ──

  async function policy() {
    return policyFromRow((await pool.query('select * from platform_policy')).rows[0]);
  }

  async function updatePolicy(actorId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TenancyError(400, 'invalid-policy', 'Send the policy fields to change');
    }
    const sets = [];
    const values = [];
    const changed = {};
    if (patch.signupMode !== undefined) {
      if (!SIGNUP_MODES.includes(patch.signupMode)) {
        throw new TenancyError(400, 'invalid-signup-mode', `signupMode must be one of ${SIGNUP_MODES.join(', ')}`);
      }
      values.push(patch.signupMode);
      sets.push(`signup_mode = $${values.length}`);
      changed.signupMode = patch.signupMode;
    }
    if (patch.signupAllowlist !== undefined) {
      const allowlist = normalizeAllowlist(patch.signupAllowlist);
      values.push(allowlist);
      sets.push(`signup_allowlist = $${values.length}`);
      changed.signupAllowlist = allowlist;
    }
    for (const [field, spec] of Object.entries(POLICY_FIELDS)) {
      if (patch[field] === undefined) continue;
      values.push(validNumber(spec, patch[field], field));
      sets.push(`${spec.column} = $${values.length}`);
      changed[field] = values.at(-1);
    }
    for (const field of Object.keys(patch)) {
      if (!['signupMode', 'signupAllowlist', ...Object.keys(POLICY_FIELDS)].includes(field)) {
        throw new TenancyError(400, 'invalid-policy', `Unknown policy field: ${field}`);
      }
    }
    if (!sets.length) return policy();
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      values.push(actorId);
      await client.query(`update platform_policy set ${sets.join(', ')}, updated_at = now(), updated_by = $${values.length}`, values);
      await audit(client, {actorId, action: 'policy.update', targetType: 'policy', detail: changed});
      return policyFromRow((await client.query('select * from platform_policy')).rows[0]);
    });
  }

  /** Whether a GitHub account, by its address and username, may create an account under the current policy. */
  async function signupDecision(email, githubLogin) {
    const current = await policy();
    if (current.signupMode === 'open' || allowlisted(current.signupAllowlist, email)) return {allowed: true};
    if (current.signupMode === 'invite' && (await pool.query(
      'select signup_invitation_exists($1) or signup_github_invitation_exists($2) as invited', [email, githubLogin],
    )).rows[0].invited) {
      return {allowed: true};
    }
    return {
      allowed: false,
      message: current.signupMode === 'invite'
        ? 'Sign-up is by invitation. Ask a workspace owner to invite this address or GitHub account, then follow the link they send.'
        : 'Sign-up is limited to approved addresses. Ask an administrator to add yours.',
    };
  }

  // ── Workspaces and members ──

  async function workspaceAllowance(userId) {
    const row = (await asUser(userId, null, client => client.query(
      `select coalesce(u.max_workspaces, p.max_workspaces_per_user) as allowed,
              (select count(*)::int from workspace_member m join workspace w on w.id = m.workspace_id
                where m.user_id = u.id and m.role = 'owner' and w.status = 'active') as owned
         from app_user u cross join platform_policy p where u.id = $1`, [userId],
    ))).rows[0];
    return row ? {allowed: row.allowed, owned: row.owned} : {allowed: 0, owned: 0};
  }

  async function workspaceLimitReached(userId) {
    const {allowed, owned} = await workspaceAllowance(userId);
    return owned >= allowed;
  }

  async function limitsFor(workspaceId) {
    return limitsFromRow((await pool.query('select * from workspace_effective_limits($1)', [workspaceId])).rows[0]);
  }

  /** Members plus pending invitations, against the member limit, before inviting. */
  async function inviteAllowance(context) {
    const [limits, counts] = await Promise.all([
      limitsFor(context.workspaceId),
      asUser(context.userId, context.workspaceId, async client => (await client.query(
        `select (select count(*)::int from workspace_member where workspace_id = $1) as members,
                (select count(*)::int from workspace_invitation
                  where workspace_id = $1 and status = 'pending' and expires_at > now())
                + (select count(*)::int from workspace_github_invitation
                  where workspace_id = $1 and status = 'pending' and expires_at > now()) as pending`,
        [context.workspaceId],
      )).rows[0]),
    ]);
    if (counts.members + counts.pending >= limits.maxMembers) {
      throw new TenancyError(409, 'member-limit-reached',
        `This workspace is limited to ${limits.maxMembers} members, counting pending invitations. Withdraw an invitation or remove a member first.`);
    }
  }

  // ── Assistant spending ──

  async function spend(client, context) {
    const row = (await client.query(
      `select coalesce(sum(cost_usd) filter (where at >= date_trunc('day', now())), 0) as today,
              coalesce(sum(cost_usd), 0) as month,
              coalesce(sum(cost_usd) filter (where at >= date_trunc('day', now()) and user_id = $2), 0) as member_today
         from ai_usage where workspace_id = $1 and at >= date_trunc('month', now())`,
      [context.workspaceId, context.userId],
    )).rows[0];
    return {today: Number(row.today), month: Number(row.month), memberToday: Number(row.member_today)};
  }

  /** Throws when the workspace or the caller has used their assistant budget. */
  async function assertAiAllowed(context) {
    const [limits, spent] = await Promise.all([
      limitsFor(context.workspaceId),
      asUser(context.userId, context.workspaceId, client => spend(client, context)),
    ]);
    if (spent.month >= limits.aiMonthlyUsd) {
      throw new TenancyError(429, 'ai-budget-monthly',
        `This workspace has used its ${usd(limits.aiMonthlyUsd)} assistant budget for this month. It resets on the 1st (UTC).`);
    }
    if (spent.today >= limits.aiDailyUsd) {
      throw new TenancyError(429, 'ai-budget-daily',
        `This workspace has used its ${usd(limits.aiDailyUsd)} assistant budget for today. It resets at midnight UTC.`);
    }
    if (spent.memberToday >= limits.memberAiDailyUsd) {
      throw new TenancyError(429, 'ai-budget-member-daily',
        `You have used your ${usd(limits.memberAiDailyUsd)} daily assistant budget in this workspace. It resets at midnight UTC.`);
    }
  }

  /**
   * One call. `usage` is NanoAgent's (prompt_tokens, completion_tokens);
   * `metrics` its timings in seconds (ttft_s, generation_s, duration_s); a
   * plugin's call also names the plugin, its session and the task it ran.
   */
  async function recordAiUsage(context, {
    kind, model = null, cost, usage = null, estimated = false, metrics = null, pluginId = null, sessionId = null, task = null,
  }) {
    if (!AI_KINDS.includes(kind)) throw new Error(`Unknown assistant call kind: ${kind}`);
    const amount = Number(cost);
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid assistant cost: ${cost}`);
    const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
    const seconds = value => (Number.isFinite(value) && value >= 0 ? value : null);
    await asUser(context.userId, context.workspaceId, client => client.query(
      `insert into ai_usage(workspace_id, user_id, kind, model, cost_usd, input_tokens, output_tokens, estimated,
                            plugin_id, session_id, task, ttft_s, generation_s, duration_s)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [context.workspaceId, context.userId, kind, model, amount,
        count(usage?.prompt_tokens), count(usage?.completion_tokens), estimated,
        pluginId, sessionId, task,
        seconds(metrics?.ttft_s), seconds(metrics?.generation_s), seconds(metrics?.duration_s)],
    ));
  }

  /** What a workspace has used against its limits, for its members to see. */
  async function usage(context) {
    const limits = await limitsFor(context.workspaceId);
    return asUser(context.userId, context.workspaceId, async client => {
      const counts = (await client.query(
        `select workspace_storage_used($1) as storage,
                (select count(*)::int from workspace_member where workspace_id = $1) as members`,
        [context.workspaceId],
      )).rows[0];
      return {
        limits,
        ai: await spend(client, context),
        storageBytes: Number(counts.storage),
        members: counts.members,
      };
    });
  }

  // ── Accounts ──

  async function suspension(userId) {
    const row = (await pool.query('select banned_at, ban_reason from app_user where id = $1', [userId])).rows[0];
    return row?.banned_at ? {bannedAt: row.banned_at, reason: row.ban_reason} : null;
  }

  /**
   * Make an account deletable: refuse while it is the only owner of a workspace
   * other people use, and delete the workspaces it uses alone. Returns how many
   * asset objects were queued for deletion.
   */
  async function prepareAccountDeletion(actorId, userId) {
    const admins = (await pool.query(
      'select count(*)::int as total, bool_or(user_id = $1) as target from platform_admin', [userId],
    )).rows[0];
    if (admins.target && admins.total <= 1) {
      throw new TenancyError(409, 'last-platform-admin', 'Make another account a platform administrator before deleting this one');
    }
    const owned = (await asUser(actorId, null, client =>
      client.query('select * from owned_workspaces($1)', [userId]))).rows;
    const shared = owned.filter(workspace => workspace.other_members > 0 && workspace.other_owners === 0);
    if (shared.length) {
      throw new TenancyError(409, 'owns-shared-workspaces',
        `Make someone else an owner of ${shared.map(workspace => workspace.name).join(', ')} first, or remove its other members.`,
        {workspaces: shared.map(({id, name, slug}) => ({id, name, slug}))});
    }
    let queued = 0;
    for (const workspace of owned.filter(item => item.other_members === 0)) {
      queued += Number((await asUser(userId, workspace.id, client => client.query(
        'select delete_workspace_and_queue_assets($1) as queued', [workspace.id],
      ))).rows[0].queued);
    }
    return queued;
  }

  // ── Platform administration ──

  async function listUsers(actorId) {
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      const spendByUser = new Map((await client.query('select * from platform_user_ai_spend()')).rows
        .map(row => [row.user_id, Number(row.ai_30d_usd)]));
      const rows = (await client.query(
        `select u.id, u.email, u.display_name as name, u.image, u.email_verified as "emailVerified",
                u.created_at as "createdAt", u.banned_at as "bannedAt", u.ban_reason as "banReason",
                u.max_workspaces as "maxWorkspaces", p.user_id is not null as admin,
                (select count(*)::int from auth_session s where s.user_id = u.id and s.expires_at > now()) as sessions,
                (select max(s.updated_at) from auth_session s where s.user_id = u.id) as "lastSeenAt"
           from app_user u left join platform_admin p on p.user_id = u.id
          order by u.created_at desc, u.id`,
      )).rows;
      return rows.map(row => ({...row, ai30dUsd: spendByUser.get(row.id) ?? 0}));
    });
  }

  async function targetUser(client, userId) {
    const row = (await client.query('select id, coalesce(display_name, email) as label from app_user where id = $1', [userId])).rows[0];
    if (!row) throw new TenancyError(404, 'user-not-found', 'No such account');
    return row;
  }

  async function banUser(actorId, userId, reason) {
    if (actorId === userId) throw new TenancyError(409, 'cannot-ban-self', 'You cannot suspend your own account');
    const clean = String(reason ?? '').trim().slice(0, 500) || null;
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      const target = await targetUser(client, userId);
      if ((await client.query('select 1 from platform_admin where user_id = $1', [userId])).rowCount) {
        throw new TenancyError(409, 'cannot-ban-admin', 'Remove administrator access before suspending this account');
      }
      await client.query('update app_user set banned_at = now(), ban_reason = $2 where id = $1', [userId, clean]);
      const revoked = (await client.query('delete from auth_session where user_id = $1', [userId])).rowCount;
      await audit(client, {actorId, action: 'user.ban', targetType: 'user', targetId: userId, targetLabel: target.label, detail: {reason: clean}});
      return {revokedSessions: revoked};
    });
  }

  async function unbanUser(actorId, userId) {
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      const target = await targetUser(client, userId);
      await client.query('update app_user set banned_at = null, ban_reason = null where id = $1', [userId]);
      await audit(client, {actorId, action: 'user.unban', targetType: 'user', targetId: userId, targetLabel: target.label});
    });
  }

  async function revokeSessions(actorId, userId) {
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      const target = await targetUser(client, userId);
      const revoked = (await client.query('delete from auth_session where user_id = $1', [userId])).rowCount;
      await audit(client, {actorId, action: 'user.sessions-revoke', targetType: 'user', targetId: userId, targetLabel: target.label, detail: {revoked}});
      return {revokedSessions: revoked};
    });
  }

  async function setUserWorkspaceLimit(actorId, userId, maxWorkspaces) {
    const value = maxWorkspaces === null ? null : validNumber(POLICY_FIELDS.maxWorkspacesPerUser, maxWorkspaces, 'maxWorkspaces');
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      const target = await targetUser(client, userId);
      await client.query('update app_user set max_workspaces = $2 where id = $1', [userId, value]);
      await audit(client, {actorId, action: 'user.workspace-limit', targetType: 'user', targetId: userId, targetLabel: target.label, detail: {maxWorkspaces: value}});
    });
  }

  async function deleteUser(actorId, userId) {
    if (actorId === userId) throw new TenancyError(409, 'cannot-delete-self', 'Delete your own account from Settings');
    const label = await asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      if ((await client.query('select 1 from platform_admin where user_id = $1', [userId])).rowCount) {
        throw new TenancyError(409, 'cannot-delete-admin', 'Remove administrator access before deleting this account');
      }
      return (await targetUser(client, userId)).label;
    });
    const queued = await prepareAccountDeletion(actorId, userId);
    await asUser(actorId, null, async client => {
      await client.query('delete from app_user where id = $1', [userId]);
      await audit(client, {actorId, action: 'user.delete', targetType: 'user', targetId: userId, targetLabel: label});
    });
    return {queuedObjects: queued};
  }

  async function listWorkspaces(actorId) {
    return asUser(actorId, null, async client => (await client.query('select * from platform_workspace_overview()')).rows
      .map(row => ({
        id: row.id, name: row.name, slug: row.slug, status: row.status, createdAt: row.created_at,
        owner: row.owner_id ? {id: row.owner_id, email: row.owner_email} : null,
        members: row.member_count,
        storageBytes: Number(row.storage_used),
        aiMonthUsd: Number(row.ai_month_usd),
        limits: limitsFromRow(row),
        overridden: row.overridden,
      })));
  }

  async function workspaceLabel(client, workspaceId) {
    const row = (await client.query(
      'select name from platform_workspace_overview() where id = $1', [workspaceId],
    )).rows[0];
    if (!row) throw new TenancyError(404, 'workspace-not-found', 'No such workspace');
    return row.name;
  }

  /** Override a workspace's limits; null for a field (or for the whole patch) restores the default. */
  async function setWorkspaceLimits(actorId, workspaceId, patch) {
    const values = {};
    if (patch !== null) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TenancyError(400, 'invalid-limit', 'Send the limits to change, or null to restore the defaults');
      }
      for (const [field, value] of Object.entries(patch)) {
        const spec = LIMIT_FIELDS[field];
        if (!spec) throw new TenancyError(400, 'invalid-limit', `Unknown limit: ${field}`);
        values[spec.column] = value === null ? null : validNumber(spec, value, field);
      }
    }
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      const label = await workspaceLabel(client, workspaceId);
      if (patch === null) {
        await client.query('delete from workspace_limits where workspace_id = $1', [workspaceId]);
      } else {
        const columns = Object.keys(values);
        await client.query(
          `insert into workspace_limits(workspace_id, ${columns.join(', ')}, updated_at, updated_by)
           values ($1, ${columns.map((_, index) => `$${index + 2}`).join(', ')}, now(), $${columns.length + 2})
           on conflict (workspace_id) do update set
             ${columns.map(column => `${column} = excluded.${column}`).join(', ')}${columns.length ? ',' : ''}
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          [workspaceId, ...Object.values(values), actorId],
        );
      }
      await audit(client, {actorId, action: 'workspace.limits', targetType: 'workspace', targetId: workspaceId, targetLabel: label, detail: patch === null ? {reset: true} : patch});
      return limitsFor(workspaceId);
    });
  }

  async function setWorkspaceStatus(actorId, workspaceId, status) {
    if (!['active', 'archived'].includes(status)) throw new TenancyError(400, 'invalid-status', 'status must be active or archived');
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      const label = await workspaceLabel(client, workspaceId);
      const changed = (await client.query('select platform_set_workspace_status($1, $2) as changed', [workspaceId, status])).rows[0].changed;
      if (changed) {
        await audit(client, {actorId, action: status === 'archived' ? 'workspace.archive' : 'workspace.restore', targetType: 'workspace', targetId: workspaceId, targetLabel: label});
      }
      return {changed};
    });
  }

  /** A workspace owner archiving or deleting their own workspace, kept beyond its own audit log. */
  async function recordWorkspaceRemoval(actorId, workspace, mode) {
    await asUser(actorId, null, client => audit(client, {
      actorId, action: mode === 'delete' ? 'workspace.delete' : 'workspace.archive',
      targetType: 'workspace', targetId: workspace.id, targetLabel: workspace.name, detail: {by: 'owner'},
    }));
  }

  async function listAudit(actorId, limit = AUDIT_LIMIT) {
    const capped = Math.min(Math.max(Number(limit) || AUDIT_LIMIT, 1), AUDIT_LIMIT);
    return asUser(actorId, null, async client => {
      await requireAdmin(client, actorId);
      return (await client.query(
        `select id, at, actor_id as "actorId", actor_label as "actorLabel", action, target_type as "targetType",
                target_id as "targetId", target_label as "targetLabel", detail
           from platform_audit order by at desc, id desc limit $1`, [capped],
      )).rows;
    });
  }

  // ── Rate limits shared by every process ──

  /** Better Auth's rate-limit storage contract, also used by the API's own limits. */
  async function consume(key, {window, max}) {
    const row = (await pool.query(
      `insert into rate_limit_bucket as b (key, window_start, count) values ($1, now(), 1)
       on conflict (key) do update set
         window_start = case when b.window_start <= now() - make_interval(secs => $2) then now() else b.window_start end,
         count = case when b.window_start <= now() - make_interval(secs => $2) then 1 else b.count + 1 end
       returning count, extract(epoch from (b.window_start + make_interval(secs => $2) - now())) as remaining`,
      [key, window],
    )).rows[0];
    const allowed = row.count <= max;
    return {allowed, retryAfter: allowed ? null : Math.max(1, Math.ceil(Number(row.remaining)))};
  }

  async function sweepRateLimits() {
    await pool.query("delete from rate_limit_bucket where window_start < now() - interval '1 hour'");
  }

  return Object.freeze({
    policy, updatePolicy, signupDecision,
    workspaceAllowance, workspaceLimitReached, limitsFor, inviteAllowance,
    assertAiAllowed, recordAiUsage, usage,
    suspension, prepareAccountDeletion,
    listUsers, banUser, unbanUser, revokeSessions, setUserWorkspaceLimit, deleteUser,
    listWorkspaces, setWorkspaceLimits, setWorkspaceStatus, recordWorkspaceRemoval, listAudit,
    consume, sweepRateLimits,
  });
}

module.exports = {
  createPostgresTenancy, TenancyError, SIGNUP_MODES, AI_KINDS, LIMIT_FIELDS, POLICY_FIELDS,
  normalizeAllowlist, allowlisted,
};
