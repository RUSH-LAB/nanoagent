'use strict';
const crypto = require('crypto');
const {BenchmarkError} = require('../benchmark/errors');
const {canonicalJson, sha256Hex} = require('../benchmark/prompt');
const {overBudget} = require('../benchmark/rules');
const {capabilitiesOf, exceeded} = require('../benchmark/limits');
const {chargeStorage, inTransaction} = require('./benchmark-context');
const {sweepExpired} = require('./benchmark-sweep');

const TODAY = "(now() at time zone 'utc')::date";

const lost = () => new BenchmarkError(409, 'lease_lost', 'The attempt is no longer leased to this worker');

/**
 * The benchmark worker's side (migration 0052; docs/contracts/rush-benchmark-api.md): claiming
 * and fencing leases, admitting and settling spend, committing evidence and finalizing attempts. It acts as the system, with no member, so each operation checks the lease itself.
 * `config` is `{leaseSeconds, uncertainDeadlineSeconds, memberBudgetUsd, workspaceBudgetUsd}`.
 */
function createPostgresBenchmarkWorker({pool, config}) {
  const system = operation => inTransaction(pool, {system: true}, operation);
  const lease = `now() + make_interval(secs => ${Number(config.leaseSeconds)})`;
  const deadline = `now() + make_interval(secs => ${Number(config.uncertainDeadlineSeconds)})`;

  /** End `attempt`, whose lease ran out, as interrupted, keeping what it committed. */
  const interrupt = (client, attemptId) => client.query(
    `update benchmark_attempt set state = 'final', execution_status = 'interrupted', finalized_at = now(), sealed = true,
       final_cursor = next_cursor - 1 where attempt_id = $1`, [attemptId]);

  /**
   * Run `work(client, attempt)` on the attempt `attemptId` locked, if it is leased to `fence`:
   * otherwise throws lease_lost, or sealed for an attempt this worker finalized. A lease that has
   * run out interrupts the attempt, and commits that, before it refuses. `final: true` lets
   * `work` see a final attempt of this fence (a retried finalize).
   */
  async function fenced(userId, attemptId, fence, work, {final = false} = {}) {
    const outcome = await system(async client => {
      const attempt = (await client.query(
        `select a.*, r.canceled_at, r.limits, r.user_id, r.workspace_id, r.endpoint_label from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id
          where a.attempt_id = $1 and r.user_id = $2 for update of a`, [attemptId, userId],
      )).rows[0];
      if (!attempt) return {refusal: new BenchmarkError(404, 'unknown_attempt', 'No such attempt')};
      if (attempt.fence !== fence || attempt.execution_status === 'interrupted') return {refusal: lost()};
      if (attempt.state === 'final') {
        return final ? {value: await work(client, attempt)} : {refusal: new BenchmarkError(409, 'sealed', 'The attempt is sealed')};
      }
      if (attempt.state !== 'leased') return {refusal: lost()};
      const expired = (await client.query('select $1::timestamptz < now() as expired', [attempt.lease_expires_at])).rows[0].expired;
      if (expired) {
        await interrupt(client, attemptId);
        return {refusal: lost()};
      }
      return {value: await work(client, attempt)};
    });
    if (outcome.refusal) throw outcome.refusal;
    return outcome.value;
  }

  /**
   * Lease the next queued attempt a worker with `capabilities` can run: the oldest run's, among the member's own runs for `label` whose limits
   * those capabilities cover. A run has no concurrency of its own: the worker's slots bound what it runs at once.
   */
  async function claimAttempt(client, userId, workerId, label, capabilities) {
    const runs = (await client.query(
      `select r.run_id, r.limits from benchmark_run r
        where r.canceled_at is null and r.user_id = $1 and r.endpoint_label = $2
          and exists (select 1 from workspace_member m where m.workspace_id = r.workspace_id and m.user_id = r.user_id)
          and exists (select 1 from benchmark_attempt a where a.run_id = r.run_id and a.state = 'queued')
        order by r.created_at, r.run_id limit 200`, [userId, label],
    )).rows;
    for (const candidate of runs) {
      if (exceeded(candidate.limits, capabilities).length) continue;
      const run = (await client.query('select * from benchmark_run where run_id = $1 for update skip locked', [candidate.run_id])).rows[0];
      // A run someone else holds (a cancel) is skipped: claim locks an attempt (sweep) before a run, cancel a run before an attempt.
      if (!run || run.canceled_at) continue;
      const picked = (await client.query(
        `select a.attempt_id from benchmark_attempt a join benchmark_run_case c on c.run_id = a.run_id and c.case_id = a.case_id
          where a.run_id = $1 and a.state = 'queued' order by a.created_at, c.position, a.attempt_id limit 1 for update of a skip locked`, [run.run_id],
      )).rows[0];
      if (!picked) continue;
      const attempt = (await client.query(
        `update benchmark_attempt set state = 'leased', fence = fence + 1, worker_id = $2, claimed_at = now(), lease_expires_at = ${lease}
          where attempt_id = $1 returning *`, [picked.attempt_id, workerId],
      )).rows[0];
      const c = (await client.query('select * from benchmark_run_case where run_id = $1 and case_id = $2', [attempt.run_id, attempt.case_id])).rows[0];
      const reference = (await client.query('select reference from benchmark_run_private where run_id = $1 and case_id = $2', [attempt.run_id, attempt.case_id])).rows[0];
      const {task} = run;
      // The task's instructions as this run works it: the task tools policy's prompt text, which may be the member's own.
      const instructions = run.policy === 'task_tools' ? run.prompt_text : task.instructions;
      return {
        kind: 'attempt', attempt_id: attempt.attempt_id, attempt_no: attempt.attempt_no, fence: attempt.fence, lease_expires_at: attempt.lease_expires_at,
        lease_seconds: Number(config.leaseSeconds),
        run: {
          run_id: run.run_id, model: run.model, endpoint_profile: run.endpoint_label, dialects: run.dialects, source_sha256: run.source_sha256,
          policy: run.policy, limits: run.limits, prompt_source: 'benchmark', renderer_version: run.renderer_version,
        },
        plugin: {id: run.plugin_id, name: run.plugin_name, version: run.version, sha256: run.package_sha256},
        case_set: {case_set_id: run.case_set_id, digest: run.case_set_digest},
        task: {
          id: run.task_id, kind: task.kind, description: task.description, instructions, plugin_name: run.plugin_name, tools: task.tools, egress_hosts: task.egress_hosts,
        },
        case: {
          case_id: c.case_id, position: c.position, kind: c.kind, arguments: c.arguments, context: run.context,
          input_schema: task.input_schema, output_schema: task.output_schema, content_digest: c.content_digest,
        },
        prompt: {system: c.prompt_system, user: c.prompt_user, sha256: c.prompt_sha256},
        private_reference: reference.reference,
      };
    }
    return null;
  }

  /** Lock the member's and the workspace's budget rows for `day` in a fixed order: `{member, workspace}` committed USD. */
  async function budgets(client, attempt, day) {
    await client.query(
      `insert into benchmark_budget (scope_kind, scope_id, day) values ('member', $1, $3), ('workspace', $2, $3) on conflict do nothing`,
      [attempt.user_id, attempt.workspace_id, day],
    );
    const rows = (await client.query(
      `select scope_kind, committed_usd::float8 as committed from benchmark_budget
        where day = $3 and ((scope_kind = 'member' and scope_id = $1) or (scope_kind = 'workspace' and scope_id = $2))
        order by scope_kind for update`, [attempt.user_id, attempt.workspace_id, day],
    )).rows;
    return Object.fromEntries(rows.map(row => [row.scope_kind, row.committed]));
  }

  const adjustBudgets = (client, attempt, day, delta) => client.query(
    `update benchmark_budget set committed_usd = committed_usd + $4 where day = $3
      and ((scope_kind = 'member' and scope_id = $1) or (scope_kind = 'workspace' and scope_id = $2))`,
    [attempt.user_id, attempt.workspace_id, day, delta],
  );

  return Object.freeze({
    /**
     * Expire stale leases and overdue reservations (see `sweep`), keep `capabilities` as what member `userId`'s worker can do for `label`,
     * then lease the next of that member's own attempts for `label` within them: a job, or null.
     */
    async claim(userId, workerId, label, capabilities) {
      // As the member too, so the workspace_member policy shows the member's own memberships to the claim.
      return inTransaction(pool, {system: true, userId}, async client => {
        await sweepExpired(client);
        await client.query(
          `insert into benchmark_worker_capability (user_id, endpoint_label, worker_id, capabilities) values ($1, $2, $3, $4)
           on conflict (user_id, endpoint_label) do update set worker_id = excluded.worker_id, capabilities = excluded.capabilities, updated_at = now()`,
          [userId, label, workerId, JSON.stringify(capabilitiesOf(capabilities))],
        );
        return claimAttempt(client, userId, workerId, label, capabilities);
      });
    },

    /**
     * Mint a credential named `name` for member `userId`'s worker: `{credential_id, name, token, created_at}`. The token is shown only
     * here; what is kept is its SHA-256 (the token is 256 random bits, so a fast hash is enough).
     */
    async mintCredential(userId, name) {
      const token = `rwk_${crypto.randomBytes(32).toString('base64url')}`;
      const credentialId = crypto.randomUUID();
      const row = (await inTransaction(pool, {userId}, client => client.query(
        'insert into benchmark_worker_credential (credential_id, user_id, name, token_sha256) values ($1, $2, $3, $4) returning created_at',
        [credentialId, userId, name, sha256Hex(token)],
      ))).rows[0];
      return {credential_id: credentialId, name, token, created_at: row.created_at};
    },

    /** Member `userId`'s credentials, newest first, without their tokens. */
    async listCredentials(userId) {
      return (await inTransaction(pool, {userId}, client => client.query(
        'select credential_id, name, created_at, last_used_at, revoked_at from benchmark_worker_credential where user_id = $1 order by created_at desc, credential_id', [userId],
      ))).rows;
    },

    /** Revoke member `userId`'s credential `credentialId` (revoking again changes nothing): its `{credential_id, revoked_at}`, or null when the member has none. */
    async revokeCredential(userId, credentialId) {
      return (await inTransaction(pool, {userId}, client => client.query(
        `update benchmark_worker_credential set revoked_at = coalesce(revoked_at, now()) where credential_id = $1 and user_id = $2
          returning credential_id, revoked_at`, [credentialId, userId],
      ))).rows[0] ?? null;
    },

    /** The member a bearer `token` belongs to, or null when no credential has it, it is revoked or the member is suspended. */
    async authenticate(token) {
      return inTransaction(pool, {system: true}, async client => (await client.query(
        `update benchmark_worker_credential set last_used_at = now() where token_sha256 = $1 and revoked_at is null
           and not exists (select 1 from app_user u where u.id = benchmark_worker_credential.user_id and u.banned_at is not null) returning user_id`, [sha256Hex(token)],
      )).rows[0]?.user_id ?? null);
    },

    /** Interrupt attempts whose lease ran out and settle reservations past their deadline, without waiting for a claim. */
    sweep() {
      return system(sweepExpired);
    },

    async renew(userId, attemptId, fence) {
      return fenced(userId, attemptId, fence, async (client, attempt) => {
        if (attempt.cancel_requested || attempt.canceled_at) throw new BenchmarkError(409, 'canceled', 'The run was canceled');
        const renewed = (await client.query(`update benchmark_attempt set lease_expires_at = ${lease} where attempt_id = $1 returning lease_expires_at`, [attemptId])).rows[0];
        // A worker busy on one long attempt claims nothing, so renewing is what keeps it advertised as live.
        await client.query(
          'update benchmark_worker_capability set updated_at = now() where user_id = $1 and endpoint_label = $2', [userId, attempt.endpoint_label],
        );
        return {...renewed, lease_seconds: Number(config.leaseSeconds)};
      });
    },

    /** The source ZIP or the package of a leased attempt: `{data, sha256}`. */
    async artifact(userId, attemptId, fence, which) {
      return fenced(userId, attemptId, fence, async (client, attempt) => {
        const row = which === 'source'
          ? (await client.query(
            `select s.data, s.sha256 from benchmark_run r join benchmark_source s on s.workspace_id = r.workspace_id and s.user_id = r.user_id and s.sha256 = r.source_sha256
              where r.run_id = $1`, [attempt.run_id])).rows[0]
          : (await client.query(
            `select p.data, p.sha256 from benchmark_run r join benchmark_package p on p.sha256 = r.package_sha256
              where r.run_id = $1`, [attempt.run_id])).rows[0];
        return {data: Buffer.from(row.data), sha256: row.sha256};
      });
    },

    /** Reserve `reserveUsd` for model call `callId` against the attempt, member and workspace. */
    async admit(userId, attemptId, fence, callId, reserveUsd) {
      return fenced(userId, attemptId, fence, async (client, attempt) => {
        if (attempt.cancel_requested || attempt.canceled_at) throw new BenchmarkError(409, 'canceled', 'The run was canceled');
        if ((await client.query('select 1 from benchmark_admission where attempt_id = $1 and call_id = $2', [attemptId, callId])).rowCount) {
          throw new BenchmarkError(409, 'duplicate_call', `Call ${callId} was already admitted`);
        }
        const day = (await client.query(`select ${TODAY}::text as day`)).rows[0].day;
        const spent = (await client.query(
          `select count(*)::int as calls, coalesce(sum(case when status = 'settled' then cost_usd else reserve_usd end), 0)::float8 as committed
             from benchmark_admission where attempt_id = $1`, [attemptId],
        )).rows[0];
        const committed = await budgets(client, attempt, day);
        const over = overBudget({
          reserve: reserveUsd, callsAdmitted: spent.calls, maxCalls: attempt.limits.max_model_calls,
          attemptCommitted: spent.committed, maxCost: attempt.limits.max_cost_usd,
          memberCommitted: committed.member, memberCap: config.memberBudgetUsd,
          workspaceCommitted: committed.workspace, workspaceCap: config.workspaceBudgetUsd,
        });
        if (over) throw new BenchmarkError(402, 'budget_exhausted', `The ${over} budget cannot cover another call`, {scope: over});
        await adjustBudgets(client, attempt, day, reserveUsd);
        await client.query(
          `insert into benchmark_admission (attempt_id, call_id, reserve_usd, status, day, deadline_at)
           values ($1, $2, $3, 'reserved', $4, ${deadline})`, [attemptId, callId, reserveUsd, day],
        );
        return {call_id: callId, reserve_usd: reserveUsd};
      });
    },

    /**
     * Settle a call at `costUsd`, or mark it uncertain, which keeps its reservation. Allowed after the
     * lease is lost: the spend is real either way. Throws unknown_call or already_settled.
     */
    async settle(userId, attemptId, callId, {outcome, costUsd, provenance}) {
      return system(async client => {
        const attempt = (await client.query(
          `select a.attempt_id, r.user_id, r.workspace_id from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id
            where a.attempt_id = $1 and r.user_id = $2 for update of a`, [attemptId, userId],
        )).rows[0];
        if (!attempt) throw new BenchmarkError(404, 'unknown_attempt', 'No such attempt');
        const admission = (await client.query(
          'select status, reserve_usd::float8 as reserve, cost_usd::float8 as cost, day::text as day from benchmark_admission where attempt_id = $1 and call_id = $2 for update',
          [attemptId, callId],
        )).rows[0];
        if (!admission) throw new BenchmarkError(404, 'unknown_call', `Call ${callId} was never admitted`);
        if (admission.status === 'settled') {
          if (outcome === 'settled' && Math.abs(admission.cost - costUsd) < 1e-8) return {call_id: callId, status: 'settled', cost_usd: costUsd};
          throw new BenchmarkError(409, 'already_settled', `Call ${callId} is already settled`);
        }
        if (outcome === 'uncertain') {
          await client.query(
            `update benchmark_admission set status = 'uncertain', provenance = $3 where attempt_id = $1 and call_id = $2`,
            [attemptId, callId, JSON.stringify(provenance)],
          );
          return {call_id: callId, status: 'uncertain', reserve_usd: admission.reserve};
        }
        await budgets(client, attempt, admission.day);
        await adjustBudgets(client, attempt, admission.day, costUsd - admission.reserve);
        await client.query(
          `update benchmark_admission set status = 'settled', cost_usd = $3, provenance = $4, settled_at = now() where attempt_id = $1 and call_id = $2`,
          [attemptId, callId, costUsd, JSON.stringify(provenance)],
        );
        return {call_id: callId, status: 'settled', cost_usd: costUsd};
      });
    },

    /** Commit `events` in order, each with the next cursor, or the cursor an identical earlier one got. */
    async appendEvents(userId, attemptId, fence, events) {
      return fenced(userId, attemptId, fence, async (client, attempt) => {
        let next = Number(attempt.next_cursor);
        const receipts = [];
        for (const event of events) {
          const digest = sha256Hex(canonicalJson({
            source: event.source, kind: event.kind, sequence: event.sequence, occurred_ns: event.occurred_ns,
            data: event.data, payload_sha256s: event.payload_sha256s,
          }));
          const existing = (await client.query('select cursor, digest from benchmark_event where attempt_id = $1 and event_id = $2', [attemptId, event.event_id])).rows[0];
          if (existing) {
            if (existing.digest !== digest) {
              throw new BenchmarkError(409, 'conflicting_duplicate', `Event ${event.event_id} was committed with different content`);
            }
            receipts.push({event_id: event.event_id, cursor: Number(existing.cursor), duplicate: true});
            continue;
          }
          await client.query(
            `insert into benchmark_event (attempt_id, cursor, event_id, source, kind, sequence, occurred_ns, data, payload_sha256s, digest)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [attemptId, next, event.event_id, event.source, event.kind, event.sequence, event.occurred_ns, JSON.stringify(event.data), event.payload_sha256s, digest],
          );
          receipts.push({event_id: event.event_id, cursor: next, duplicate: false});
          next += 1;
        }
        await client.query('update benchmark_attempt set next_cursor = $2 where attempt_id = $1', [attemptId, next]);
        return {receipts, high_water_cursor: next - 1};
      });
    },

    async putPayload(userId, attemptId, fence, {sha256, data, redaction, contentType}) {
      return fenced(userId, attemptId, fence, async client => {
        if (!(await client.query('select 1 from benchmark_payload where attempt_id = $1 and sha256 = $2', [attemptId, sha256])).rowCount) await chargeStorage(client, userId, data.length);
        const inserted = await client.query(
          `insert into benchmark_payload (attempt_id, sha256, size, redaction, content_type, data) values ($1, $2, $3, $4, $5, $6)
           on conflict do nothing`, [attemptId, sha256, data.length, redaction, contentType, data],
        );
        return {sha256, size: data.length, created: inserted.rowCount > 0};
      });
    },

    async putSpans(userId, attemptId, fence, spans, links) {
      return fenced(userId, attemptId, fence, async client => {
        for (const span of spans) {
          // A later report of a span fills what the earlier one lacked and keeps what it had.
          await client.query(
            `insert into benchmark_span (attempt_id, span_id, kind, name, parent_id, scope, status, start_ns, end_ns, provenance, target, attributes)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             on conflict (attempt_id, span_id) do update set kind = excluded.kind, name = excluded.name,
               parent_id = coalesce(excluded.parent_id, benchmark_span.parent_id), scope = coalesce(excluded.scope, benchmark_span.scope),
               status = coalesce(excluded.status, benchmark_span.status), start_ns = coalesce(excluded.start_ns, benchmark_span.start_ns),
               end_ns = coalesce(excluded.end_ns, benchmark_span.end_ns), provenance = coalesce(excluded.provenance, benchmark_span.provenance),
               target = coalesce(excluded.target, benchmark_span.target), attributes = benchmark_span.attributes || excluded.attributes`,
            [attemptId, span.id, span.kind, span.name, span.parent, span.scope, span.status, span.start_ns, span.end_ns, span.provenance, span.target, JSON.stringify(span.attributes)],
          );
        }
        for (const link of links) {
          await client.query(
            `insert into benchmark_link (attempt_id, kind, from_id, to_id, method, attributes) values ($1, $2, $3, $4, $5, $6)
             on conflict (attempt_id, kind, from_id, to_id) do update set method = coalesce(excluded.method, benchmark_link.method),
               attributes = benchmark_link.attributes || excluded.attributes`,
            [attemptId, link.kind, link.from, link.to, link.method, JSON.stringify(link.attributes)],
          );
        }
        return {spans: spans.length, links: links.length};
      });
    },

    /**
     * Seal the attempt at `finalCursorExpected` with its status, the verdict the plugin's verifier
     * gave it (or the verifier's error), coverage and metrics, in one transaction. A retry
     * of the same finalize answers the same; a different one is a conflicting_duplicate.
     */
    async finalize(userId, attemptId, fence, body) {
      const digest = sha256Hex(canonicalJson(body));
      return fenced(userId, attemptId, fence, async (client, attempt) => {
        if (attempt.state === 'final') {
          if (attempt.finalize_digest === digest) return {attempt_id: attemptId, sealed: true, final_cursor: Number(attempt.final_cursor), replayed: true};
          throw new BenchmarkError(409, 'conflicting_duplicate', 'The attempt was finalized with different content');
        }
        const highWater = Number(attempt.next_cursor) - 1;
        if (highWater !== body.final_cursor_expected) {
          throw new BenchmarkError(409, 'cursor_mismatch', `The attempt's committed events end at ${highWater}`, {high_water_cursor: highWater});
        }
        await client.query(
          `update benchmark_attempt set state = 'final', execution_status = $2, execution_reason = $3, verdict = $4, verifier_error = $5,
             coverage = $6, metrics = $7, finalized_at = now(), sealed = true, final_cursor = $8, finalize_digest = $9, explanation = $10
           where attempt_id = $1`,
          [attemptId, body.execution.status, body.execution.reason, body.verdict, body.verifier_error,
            JSON.stringify(body.coverage), JSON.stringify(body.metrics), highWater, digest, body.explanation],
        );
        return {attempt_id: attemptId, sealed: true, final_cursor: highWater, replayed: false};
      }, {final: true});
    },

    /** Late accounting for a call, a new `version` of its record; allowed on a sealed attempt. */
    async putAccounting(userId, attemptId, callId, version, record) {
      return system(async client => {
        if (!(await client.query('select 1 from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id where a.attempt_id = $1 and r.user_id = $2', [attemptId, userId])).rowCount) {
          throw new BenchmarkError(404, 'unknown_attempt', 'No such attempt');
        }
        if (!(await client.query('select 1 from benchmark_admission where attempt_id = $1 and call_id = $2', [attemptId, callId])).rowCount) {
          throw new BenchmarkError(404, 'unknown_call', `Call ${callId} was never admitted`);
        }
        const inserted = await client.query(
          `insert into benchmark_accounting (attempt_id, call_id, version, record) values ($1, $2, $3, $4) on conflict do nothing`,
          [attemptId, callId, version, JSON.stringify(record)],
        );
        if (inserted.rowCount) return {call_id: callId, version, created: true};
        const existing = (await client.query('select record from benchmark_accounting where attempt_id = $1 and call_id = $2 and version = $3', [attemptId, callId, version])).rows[0];
        if (canonicalJson(existing.record) !== canonicalJson(record)) {
          throw new BenchmarkError(409, 'conflicting_duplicate', `Version ${version} of call ${callId} was recorded with different content`);
        }
        return {call_id: callId, version, created: false};
      });
    },
  });
}

module.exports = {createPostgresBenchmarkWorker};
