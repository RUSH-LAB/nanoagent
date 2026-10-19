'use strict';
/**
 * The platform's tenancy rules: who may sign up, how many workspaces an account
 * may own, what each workspace may store and spend on the assistant, which
 * accounts are suspended, and the record of workspaces their owners removed.
 *
 * Storage limits are also enforced by triggers (0011_tenancy.sql),
 * so a write path that never calls this module still cannot exceed them; the
 * checks here exist to refuse early with a message a person can act on.
 */
const {withRequestContext} = require('./client');

const SIGNUP_MODES = Object.freeze(['open', 'invite', 'allowlist']);
const AI_KINDS = Object.freeze(['chat', 'inline', 'complete', 'app', 'task', 'plugin']);
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
    workspaceAiDailyUsd: Number(row.workspace_ai_daily_usd),
    workspaceAiMonthlyUsd: Number(row.workspace_ai_monthly_usd),
    memberAiDailyUsd: Number(row.member_ai_daily_usd),
    updatedAt: row.updated_at,
  };
}

function limitsFromRow(row) {
  return {
    storageBytes: Number(row.storage_bytes),
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

  // ── Policy ──

  async function policy() {
    return policyFromRow((await pool.query('select * from platform_policy')).rows[0]);
  }

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
   * `metrics` its timings in seconds (ttft_s, generation_s, duration_s, and
   * model_s and tools_s, its time on model requests and tool calls); a
   * plugin's call also names the plugin and its session.
   */
  async function recordAiUsage(context, {
    kind, model = null, cost, usage = null, estimated = false, metrics = null, pluginId = null, sessionId = null,
  }) {
    if (!AI_KINDS.includes(kind)) throw new Error(`Unknown assistant call kind: ${kind}`);
    const amount = Number(cost);
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid assistant cost: ${cost}`);
    const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
    const seconds = value => (Number.isFinite(value) && value >= 0 ? value : null);
    await asUser(context.userId, context.workspaceId, client => client.query(
      `insert into ai_usage(workspace_id, user_id, kind, model, cost_usd, input_tokens, output_tokens, estimated,
                            plugin_id, session_id, ttft_s, generation_s, duration_s, model_s, tools_s)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [context.workspaceId, context.userId, kind, model, amount,
        count(usage?.prompt_tokens), count(usage?.completion_tokens), estimated,
        pluginId, sessionId,
        seconds(metrics?.ttft_s), seconds(metrics?.generation_s), seconds(metrics?.duration_s),
        seconds(metrics?.model_s), seconds(metrics?.tools_s)],
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

  // ── Platform audit ──

  async function recordWorkspaceRemoval(actorId, workspace, mode) {
    await asUser(actorId, null, client => audit(client, {
      actorId, action: mode === 'delete' ? 'workspace.delete' : 'workspace.archive',
      targetType: 'workspace', targetId: workspace.id, targetLabel: workspace.name, detail: {by: 'owner'},
    }));
  }

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
    policy, signupDecision,
    workspaceAllowance, workspaceLimitReached, limitsFor,
    assertAiAllowed, recordAiUsage, usage,
    suspension, prepareAccountDeletion, recordWorkspaceRemoval,
    consume, sweepRateLimits,
  });
}

module.exports = {
  createPostgresTenancy, TenancyError, SIGNUP_MODES, AI_KINDS, allowlisted,
};
