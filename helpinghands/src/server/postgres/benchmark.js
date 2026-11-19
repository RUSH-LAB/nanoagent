'use strict';
const crypto = require('crypto');
const {BenchmarkError} = require('../benchmark/errors');
const {checkTaskAgainstEntry} = require('../benchmark/entry-check');
const {CAPABILITY_WINDOW_S} = require('../benchmark/limits');
const {stringifyJson} = require('../benchmark/json');
const {RENDERER_VERSION, canonicalJson, sha256Hex} = require('../benchmark/prompt');
const {checkReference, referencePolicy} = require('../benchmark/harness');
const {renderCase} = require('../benchmark/plan');
const {latestByCase, runScore, sumMetrics} = require('../benchmark/rules');
const {MAX_ATTEMPT_LINKS, MAX_ATTEMPTS_PER_CASE, MAX_EVENT_PAGE_BYTES, MAX_TRACE_PAGE_BYTES} = require('../benchmark/limits');
const {chargeStorage, inTransaction} = require('./benchmark-context');
const {sweepExpired} = require('./benchmark-sweep');

/** The previews a member keeps. */
const MAX_PREVIEWS = 50;

function attemptView(row) {
  return {
    attempt_id: row.attempt_id, run_id: row.run_id, case_id: row.case_id,
    attempt_no: row.attempt_no, rerun_of: row.rerun_of, state: row.state,
    execution: row.execution_status ? {status: row.execution_status, reason: row.execution_reason} : null,
    verdict: row.verdict, explanation: row.explanation, verifier_error: row.verifier_error,
    coverage: row.coverage, metrics: row.metrics, sealed: row.sealed, final_cursor: row.final_cursor === null ? null : Number(row.final_cursor),
    high_water_cursor: Number(row.next_cursor) - 1, cancel_requested: row.cancel_requested,
    created_at: row.created_at, claimed_at: row.claimed_at, finalized_at: row.finalized_at,
  };
}

/** A run as the API summarizes it, from a `benchmark_run_summary` row: the caller's own runs and other members' alike. */
function runSummary(row) {
  const latest = latestByCase(row.attempts);
  return {
    run_id: row.run_id, harness: {name: row.harness_name, version: row.harness_version}, benchmark: {name: row.benchmark_name},
    plugin: {id: row.plugin_id, name: row.plugin_name, version: row.plugin_version}, model: row.model, policy: row.policy,
    // The detail's own sum (GET /runs/{run_id}), so a list row's metrics equal it.
    user: {id: row.user_id, name: row.user_name, github: row.user_github}, metrics: sumMetrics([...latest.values()].map(attempt => attempt.metrics)),
    status: runStatus(row, row.attempts), score: runScore(row.case_ids, row.attempts), created_at: row.created_at,
  };
}

/** A case's rendered prompt as the API shows it. */
const promptView = row => ({system: row.prompt_system, user: row.prompt_user, sha256: row.prompt_sha256});

/**
 * Cancel member `userId`'s unfinished interactive session runs, as `cancel` does one run: a queued attempt ends canceled, a leased
 * one is told to stop. `client` acts as the system.
 */
async function endInteractiveSessions(client, userId) {
  const runs = (await client.query(
    `select run_id from benchmark_run r where r.user_id = $1 and r.interactive and r.canceled_at is null
       and exists (select 1 from benchmark_attempt a where a.run_id = r.run_id and a.state <> 'final') order by run_id for update`, [userId],
  )).rows.map(row => row.run_id);
  if (!runs.length) return;
  await client.query('update benchmark_run set canceled_at = now() where run_id = any($1)', [runs]);
  await client.query(
    `update benchmark_attempt set state = 'final', execution_status = 'canceled', finalized_at = now(), sealed = true,
       final_cursor = next_cursor - 1 where run_id = any($1) and state = 'queued'`, [runs]);
  await client.query("update benchmark_attempt set cancel_requested = true where run_id = any($1) and state = 'leased'", [runs]);
}

function runStatus(run, attempts) {
  if (run.canceled_at) return 'canceled';
  const current = [...latestByCase(attempts).values()];
  if (current.every(attempt => attempt.state === 'final')) return 'complete';
  return current.some(attempt => attempt.state === 'leased' || attempt.state === 'final') ? 'running' : 'queued';
}

/**
 * Benchmarks, previews, sources, and the member's runs (migration 0052). Every read is as the
 * member, so row-level security shows a run only to the member who submitted it, in a workspace
 * they are still in. Writes of a run go through `system` after the route has verified membership.
 */
function createPostgresBenchmark({pool}) {
  /** Interrupt what time has expired before a member reads it, so a stalled attempt never reads as leased. */
  const sweep = () => inTransaction(pool, {system: true}, sweepExpired);
  const member = (context, operation) => inTransaction(pool, {userId: context.userId, workspaceId: context.workspaceId}, operation);
  const memberWrite = (context, operation) => inTransaction(
    pool, {userId: context.userId, workspaceId: context.workspaceId, system: true}, operation,
  );
  /**
   * A write on a run that exists: the run is looked up first as the member, whose policies show it
   * only to its owner, and only then does the transaction act as the system and lock it.
   */
  const ownRunWrite = (context, runId, operation) => inTransaction(pool, {userId: context.userId, workspaceId: context.workspaceId}, async client => {
    if (!(await client.query('select 1 from benchmark_run where run_id = $1', [runId])).rowCount) throw new BenchmarkError(404, 'unknown_run', 'No such run');
    await client.query("select set_config('app.benchmark_system', 'on', true)");
    return operation(client);
  });

  const benchmarkRow = row => ({
    benchmark_id: row.benchmark_id, name: row.name,
    plugin: {id: row.plugin_id, name: row.plugin_name, version: row.plugin_version, sha256: row.package_sha256},
    task_id: row.task_id, task_kind: row.task.kind, publisher: {id: row.publisher_id, name: row.publisher_name, github: row.publisher_github},
    case_set_id: row.case_set_id, case_set_digest: row.case_set_digest, digest: row.digest,
    model: row.model, endpoint_profile: row.endpoint_label, limits: row.limits, coding_template: row.coding_template, task_instructions: row.task_instructions,
    renderer_version: RENDERER_VERSION, published_at: row.published_at,
    case_count: Number(row.case_count), answer_count: Number(row.answer_count), refuse_count: Number(row.refuse_count),
    run_count: Number(row.run_count), runner_count: Number(row.runner_count),
  });
  const BENCHMARK_SELECT = `select b.benchmark_id, b.name, b.plugin_id, b.plugin_version, b.model, b.endpoint_label, b.limits, b.coding_template, b.task_instructions,
    b.digest, b.published_at, b.publisher_id, u.display_name as publisher_name, u.github_login as publisher_github,
    s.case_set_id, s.plugin_name, s.package_sha256, s.task_id, s.task, s.context, s.digest as case_set_digest,
    (select count(*) from benchmark_case_set_case c where c.case_set_id = s.case_set_id) as case_count,
    (select count(*) from benchmark_case_set_case c where c.case_set_id = s.case_set_id and c.kind = 'answer') as answer_count,
    (select count(*) from benchmark_case_set_case c where c.case_set_id = s.case_set_id and c.kind = 'refuse') as refuse_count,
    st.run_count, st.runner_count
    from benchmark b join benchmark_case_set s on s.case_set_id = b.case_set_id join app_user u on u.id = b.publisher_id
    cross join lateral benchmark_stats(b.benchmark_id) st`;

  /** The run `row` as the API shows it. */
  async function runDetail(client, row) {
    const runId = row.run_id;
    const results = [];
    for (const [sql, values] of [
      ['select * from benchmark_run_case where run_id = $1 order by position', [runId]],
      ['select * from benchmark_attempt where run_id = $1 order by case_id, attempt_no', [runId]],
      ['select size from benchmark_source where workspace_id = $1 and user_id = $2 and sha256 = $3', [row.workspace_id, row.user_id, row.source_sha256]],
    ]) results.push((await client.query(sql, values)).rows);
    const [cases, attempts, source] = results;
    const latest = latestByCase(attempts);
    return {
      run_id: runId, status: runStatus(row, attempts), created_at: row.created_at, canceled_at: row.canceled_at,
      benchmark: {benchmark_id: row.benchmark_id, name: row.benchmark_name}, harness: {name: row.harness_name, version: row.harness_version, dialects: row.dialects},
      model: row.model, endpoint_profile: row.endpoint_label, dialects: row.dialects, policy: row.policy,
      prompt: {source: 'benchmark', text: row.prompt_text, renderer_version: row.renderer_version},
      limits: row.limits, egress_hosts: row.policy === 'task_tools' ? row.task.egress_hosts : null, unverified_egress: row.limits.internet_access === true, selection: row.selection,
      preview_id: row.preview_id, source: {sha256: row.source_sha256, size: source[0]?.size ?? null},
      case_set: {
        case_set_id: row.case_set_id, name: row.benchmark_name, digest: row.case_set_digest, publisher: row.publisher,
        plugin: {id: row.plugin_id, name: row.plugin_name, version: row.version, sha256: row.package_sha256},
        task_id: row.task_id, task: row.task, context: row.context,
      },
      cases: cases.map(c => ({
        case_id: c.case_id, position: c.position, kind: c.kind, arguments: c.arguments, expected_error: c.expected_error,
        content_digest: c.content_digest, prompt: promptView(c),
        latest_attempt_id: latest.get(c.case_id)?.attempt_id ?? null,
        attempts: attempts.filter(a => a.case_id === c.case_id).map(attemptView),
      })),
      score: runScore(cases.map(c => c.case_id), attempts),
      metrics: sumMetrics([...latest.values()].map(a => a.metrics)),
    };
  }

  /**
   * Keep the case set of `benchmark` (a validated publication) for its published plugin version, or reuse an identical one: its
   * cases, and their private references.
   */
  async function keepCaseSet(client, userId, benchmark) {
    const version = (await client.query(
      'select entry from market_plugin_version where plugin_id = $1 and version = $2 and sha256 = $3', [benchmark.plugin_id, benchmark.version, benchmark.package_sha256],
    )).rows[0];
    if (!version) throw new BenchmarkError(404, 'unknown_plugin_version', `${benchmark.plugin_id} ${benchmark.version} with that sha256 is not published`);
    checkTaskAgainstEntry(version.entry, benchmark);
    const caseSetId = benchmark.case_set_digest;
    const caseSet = await client.query(
      `insert into benchmark_case_set (case_set_id, publisher_id, plugin_id, plugin_name, version, package_sha256, task_id, task, context, digest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1) on conflict do nothing`,
      [caseSetId, userId, benchmark.plugin_id, benchmark.plugin_name, benchmark.version, benchmark.package_sha256, benchmark.task_id,
        stringifyJson(benchmark.task), benchmark.context],
    );
    if (caseSet.rowCount) {
      for (const [position, c] of benchmark.cases.entries()) {
        await client.query(
          `insert into benchmark_case_set_case (case_set_id, case_id, position, kind, arguments, expected_error, reference_sha256, content_digest)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [caseSetId, c.case_id, position, c.kind, stringifyJson(c.arguments), c.expected_error, c.reference_sha256, c.content_digest],
        );
        await client.query(
          'insert into benchmark_case_set_private (case_set_id, case_id, reference) values ($1, $2, $3)',
          [caseSetId, c.case_id, stringifyJson(benchmark.private[c.case_id])],
        );
      }
    }
  }

  /** Copy the private reference of case `caseId` of case set `caseSetId` to run `runId`. */
  const keepRunPrivate = (client, runId, caseSetId, caseId) => client.query(
    `insert into benchmark_run_private (run_id, case_id, reference)
     select $1, case_id, reference from benchmark_case_set_private where case_set_id = $2 and case_id = $3`,
    [runId, caseSetId, caseId],
  );
  /**
   * What an imported run (`importRun`) keeps besides its score, as a run made in RUSH keeps it: its case pinned (`record.case`'s
   * arguments and digest, and the prompt RUSH renders for it under the run's policy), its private reference, and after its verdict
   * (event 1) the harness's answer (`harness.answer`, `{answer}`) and each step of its ATIF trajectory (`trajectory.step`, the step).
   */
  const keepTrace = async (client, frame, record, {runId, attemptId, policy, ended}) => {
    const c = record.case;
    const prompt = renderCase({
      benchmark: {task: frame.task, context: frame.context, plugin: {name: frame.plugin_name}}, policy,
      text: policy === 'coding' ? frame.coding_template : frame.task_instructions, c,
    });
    await client.query(
      `update benchmark_run_case set arguments = $3, content_digest = $4, prompt_system = $5, prompt_user = $6, prompt_sha256 = $7 where run_id = $1 and case_id = $2`,
      [runId, c.case_id, stringifyJson(c.arguments), c.content_digest, prompt.system, prompt.user, prompt.sha256],
    );
    await client.query('insert into benchmark_run_private (run_id, case_id, reference) values ($1, $2, $3)', [runId, c.case_id, JSON.stringify(c.reference)]);
    const events = [['answer', 'harness.answer', {answer: record.answer}], ...record.trajectory.map((step, index) => [`step-${index + 1}`, 'trajectory.step', step])];
    await client.query(
      `insert into benchmark_event (attempt_id, cursor, event_id, source, kind, sequence, data, digest, received_at)
       select $1, 1 + t.n, t.id, 'import', t.kind, 1 + t.n, t.data, t.digest, $6
         from unnest($2::text[], $3::text[], $4::jsonb[], $5::text[]) with ordinality as t(id, kind, data, digest, n)`,
      [attemptId, events.map(([id]) => id), events.map(([, kind]) => kind), events.map(([, , data]) => JSON.stringify(data)),
        events.map(([, , data]) => sha256Hex(canonicalJson(data))), ended],
    );
    await client.query('update benchmark_attempt set next_cursor = $2, final_cursor = $3 where attempt_id = $1', [attemptId, events.length + 2, events.length + 1]);
  };
  const publisherOf = async (client, userId) => (await client.query('select id, display_name as name, github_login as github from app_user where id = $1', [userId])).rows[0];

  return Object.freeze({
    /** At most `limit` published benchmarks (public parts of each, no cases) published before `before`, newest first, of plugin `pluginId` and its version `version` if given. */
    async benchmarks(context, {pluginId = null, version = null, limit, before = null}) {
      return member(context, async client => (await client.query(
        `${BENCHMARK_SELECT} where ($1::text is null or b.plugin_id = $1) and ($2::text is null or b.plugin_version = $2) and ($3::timestamptz is null or b.published_at < $3)
          order by b.published_at desc, b.benchmark_id limit $4`,
        [pluginId, version, before, limit],
      )).rows.map(benchmarkRow));
    },
    /** A benchmark with its case set's task, context and cases (public parts only), or null. */
    async benchmark(context, benchmarkId) {
      return member(context, async client => {
        const row = (await client.query(`${BENCHMARK_SELECT} where b.benchmark_id = $1`, [benchmarkId])).rows[0];
        if (!row) return null;
        const cases = (await client.query(
          'select case_id, position, kind, arguments, expected_error, content_digest from benchmark_case_set_case where case_set_id = $1 order by position', [row.case_set_id],
        )).rows;
        return {...benchmarkRow(row), task: row.task, context: row.context, cases};
      });
    },
    /** Run summaries of every member's runs of a benchmark, newest first. */
    async benchmarkResults(context, benchmarkId, {limit, before}) {
      await sweep();
      return member(context, async client => {
        if (!(await client.query('select 1 from benchmark where benchmark_id = $1', [benchmarkId])).rowCount) return null;
        return (await client.query('select * from benchmark_results($1, $2, $3)', [benchmarkId, limit, before])).rows.map(runSummary);
      });
    },

    /**
     * Publish a benchmark as `userId`, for any published plugin version, creating its case set or reusing an identical one. A name is unique
     * per plugin version: the same benchmark again changes nothing, a different one under the name is refused (`benchmark_name_taken`) and
     * stores nothing. `benchmark` is the validated publication (`benchmarkPublication`). Resolves to `{created, benchmark_id}`.
     */
    async publishBenchmark(userId, benchmark) {
      return inTransaction(pool, {userId}, async client => {
        await keepCaseSet(client, userId, benchmark);
        const benchmarkId = crypto.randomUUID();
        const inserted = await client.query(
          `insert into benchmark (benchmark_id, name, plugin_id, plugin_version, case_set_id, model, endpoint_label, limits, coding_template, task_instructions, digest, publisher_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (plugin_id, plugin_version, name) do nothing`,
          [benchmarkId, benchmark.name, benchmark.plugin_id, benchmark.version, caseSetId, benchmark.model, benchmark.endpoint_profile, JSON.stringify(benchmark.limits),
            benchmark.coding_template, benchmark.task_instructions, benchmark.digest, userId],
        );
        if (inserted.rowCount) return {created: true, benchmark_id: benchmarkId};
        const existing = (await client.query(
          'select benchmark_id, digest from benchmark where plugin_id = $1 and plugin_version = $2 and name = $3', [benchmark.plugin_id, benchmark.version, benchmark.name],
        )).rows[0];
        if (existing.digest !== benchmark.digest) {
          throw new BenchmarkError(409, 'benchmark_name_taken', `Benchmark ${benchmark.name} is published for ${benchmark.plugin_id} ${benchmark.version} with different content; a changed benchmark needs a new name`);
        }
        return {created: false, benchmark_id: existing.benchmark_id};
      });
    },

    /**
     * Keep the case set of a Harness tab session (a validated publication) as `userId`, as publishing does, under no benchmark:
     * the member as its publisher, `{id, name, github}`.
     */
    async saveCaseSet(userId, publication) {
      return inTransaction(pool, {userId}, async client => {
        await keepCaseSet(client, userId, publication);
        return publisherOf(client, userId);
      });
    },
    /** Member `userId` as a case set's publisher: `{id, name, github}`. */
    async publisher(userId) {
      return inTransaction(pool, {userId}, client => publisherOf(client, userId));
    },

    /** What member `userId`'s worker last advertised for endpoint profile `label` within the capability window, or null when it has not. */
    async capabilities(userId, label) {
      return inTransaction(pool, {system: true}, async client => (await client.query(
        `select capabilities from benchmark_worker_capability where user_id = $1 and endpoint_label = $2 and updated_at > now() - make_interval(secs => $3)`,
        [userId, label, CAPABILITY_WINDOW_S],
      )).rows[0]?.capabilities ?? null);
    },
    /** Every endpoint profile member `userId`'s worker has advertised for within the capability window, with its capabilities: `[{label, capabilities, updated_at, expires_at}]`. */
    async endpoints(userId) {
      return inTransaction(pool, {system: true}, async client => (await client.query(
        `select endpoint_label as label, capabilities, updated_at, updated_at + make_interval(secs => $1) as expires_at
           from benchmark_worker_capability where user_id = $2 and updated_at > now() - make_interval(secs => $1) order by endpoint_label`,
        [CAPABILITY_WINDOW_S, userId],
      )).rows);
    },

    /** Keep a preview's resolved `plan` and its `digest` as `previewId` (a new one unless given): the preview's id. */
    async savePreview(context, plan, digest, previewId = crypto.randomUUID()) {
      // As the system (still the member's own rows), so the prune sees the member's previews of every workspace, not only this one's.
      await memberWrite(context, async client => {
        await client.query(
          'insert into benchmark_preview (preview_id, workspace_id, user_id, plan, plan_digest) values ($1, $2, $3, $4, $5)',
          [previewId, context.workspaceId, context.userId, JSON.stringify(plan), digest],
        );
        // A member keeps their newest MAX_PREVIEWS previews: one is read right after it is made.
        await client.query(
          `delete from benchmark_preview where user_id = $1 and preview_id in (select preview_id from benchmark_preview where user_id = $1
             order by created_at desc, preview_id offset ${MAX_PREVIEWS})`, [context.userId],
        );
      });
      return previewId;
    },
    /** The caller's preview `id`: `{plan, plan_digest}`, or null. */
    async preview(context, id) {
      return member(context, async client => (await client.query(
        'select plan, plan_digest from benchmark_preview where preview_id = $1', [id],
      )).rows[0] ?? null);
    },

    /**
     * Keep the source ZIP `data` and the `harness` its manifest declares (`{name, version, dialects}`) under its digest: the digest, size and harness.
     * The first upload of the member's `name@version` pins its digest: another ZIP under it is `harness_version_taken`, and stores nothing. Saving it again changes nothing.
     */
    async saveSource(context, data, harness) {
      const sha256 = sha256Hex(data);
      await member(context, async client => {
        const pinned = await client.query(
          'insert into benchmark_harness_version (owner_id, name, version, source_sha256) values ($1, $2, $3, $4) on conflict do nothing',
          [context.userId, harness.name, harness.version, sha256],
        );
        if (!pinned.rowCount) {
          const {source_sha256: pinnedSha256} = (await client.query(
            'select source_sha256 from benchmark_harness_version where owner_id = $1 and name = $2 and version = $3', [context.userId, harness.name, harness.version],
          )).rows[0];
          if (pinnedSha256 !== sha256) {
            throw new BenchmarkError(409, 'harness_version_taken', `${harness.name}@${harness.version} is uploaded with different content; a changed harness needs a new version`, {
              harness: {name: harness.name, version: harness.version}, pinned_sha256: pinnedSha256,
            });
          }
        }
        if (!(await client.query('select 1 from benchmark_source where workspace_id = $1 and user_id = $2 and sha256 = $3', [context.workspaceId, context.userId, sha256])).rowCount) {
          await chargeStorage(client, context.userId, data.length);
        }
        await client.query(
          `insert into benchmark_source (workspace_id, user_id, sha256, size, data, harness_name, harness_version, dialects) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict do nothing`, [context.workspaceId, context.userId, sha256, data.length, data, harness.name, harness.version, JSON.stringify(harness.dialects)],
        );
      });
      return {source_sha256: sha256, size: data.length, harness};
    },
    /** The caller's source `sha256`: `{harness: {name, version, dialects}}`, or null. */
    async source(context, sha256) {
      return member(context, async client => {
        const row = (await client.query('select harness_name, harness_version, dialects from benchmark_source where sha256 = $1', [sha256])).rows[0];
        return row ? {harness: {name: row.harness_name, version: row.harness_version, dialects: row.dialects}} : null;
      });
    },

    /** The caller's run submitted under `key`: `{run_id, request_digest}` or null. */
    async runByKey(context, key) {
      return member(context, async client => (await client.query(
        'select run_id, request_digest from benchmark_run where idempotency_key = $1', [key],
      )).rows[0] ?? null);
    },

    /**
     * Pin a run and queue one attempt per case, in one transaction: the source and package bytes,
     * each case with its rendered prompt, and the case set's private references are in rows before
     * any attempt is claimable. `request` is the validated run request, `resolved` what it resolved to
     * (`resolve` in benchmark/plan.js), `benchmark` the benchmark it was resolved against and `harness` the source's manifest identity;
     * `session` marks a Harness tab or `nanoagent harness` run, never a benchmark result, and `interactive` one whose member works at its
     * terminal; `free` a free-form Terminal session, with no package, task or case and one attempt of none. A session's one attempt is `attempt_id`
     * in the answer; an `interactive` one ends the member's other unfinished interactive sessions first. A concurrent submission under the same key gets the first one's run: `{run_id, replayed}`.
     */
    async createRun(context, request, resolved, benchmark, harness, {session = false, interactive = false, free = false, resumedFrom = null, startCli = null, resumeChat = null} = {}) {
      const {plan, cases} = resolved;
      return memberWrite(context, async client => {
        // A free-form Terminal session runs nothing of its plugin: it keeps no package.
        if (!free) {
          await client.query(
            `insert into benchmark_package (sha256, data)
             select sha256, package from market_plugin_version where plugin_id = $1 and sha256 = $2 limit 1 on conflict do nothing`,
            [benchmark.plugin.id, benchmark.plugin.sha256],
          );
          if (!(await client.query('select 1 from benchmark_package where sha256 = $1', [benchmark.plugin.sha256])).rowCount) {
            throw new BenchmarkError(409, 'package_unavailable', `${benchmark.plugin.id} ${benchmark.plugin.version} is no longer published, so its benchmark cannot be run`);
          }
        }
        // One terminal session per member: a new one ends their other unfinished ones (any plugin, any workspace), so it never waits behind them.
        if (interactive) await endInteractiveSessions(client, context.userId);
        const runId = crypto.randomUUID();
        const inserted = (await client.query(
          `insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, preview_id, source_sha256,
             model, endpoint_label, dialects, policy, prompt_text, limits, selection, renderer_version,
             benchmark_id, benchmark_name, harness_name, harness_version, case_set_id, case_set_digest, publisher,
             plugin_id, plugin_name, version, package_sha256, task_id, task, context, session, interactive, resumed_from, start_cli, resume_chat)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)
           on conflict (workspace_id, user_id, idempotency_key) do nothing returning run_id`,
          [runId, context.workspaceId, context.userId, request.idempotency_key, request.request_digest, request.preview_id, request.source_sha256,
            plan.model, plan.endpoint_profile, JSON.stringify(harness.dialects), plan.policy, plan.prompt.text,
            JSON.stringify(plan.limits), JSON.stringify({case_ids: cases.map(c => c.case_id)}), plan.renderer_version,
            benchmark.benchmark_id, benchmark.name, harness.name, harness.version, benchmark.case_set_id, benchmark.case_set_digest, JSON.stringify(benchmark.publisher),
            benchmark.plugin.id, benchmark.plugin.name, benchmark.plugin.version, benchmark.plugin.sha256, benchmark.task_id, free ? null : stringifyJson(benchmark.task), benchmark.context,
            session, interactive, resumedFrom, startCli, resumeChat === null ? null : JSON.stringify(resumeChat)],
        )).rows[0];
        if (!inserted) {
          const existing = (await client.query(
            'select run_id, request_digest from benchmark_run where workspace_id = $1 and user_id = $2 and idempotency_key = $3',
            [context.workspaceId, context.userId, request.idempotency_key],
          )).rows[0];
          if (existing.request_digest !== request.request_digest) {
            throw new BenchmarkError(409, 'idempotency_conflict', 'That idempotency_key was used for a different request');
          }
          return {run_id: existing.run_id, replayed: true};
        }
        let attemptId = null;
        for (const c of cases) {
          // A session's case is queued before it is pinned (`pinSessionCase` fills it in), with no arguments, digest or prompt.
          await client.query(
            `insert into benchmark_run_case (run_id, case_id, position, kind, arguments, expected_error, content_digest, prompt_system, prompt_user, prompt_sha256)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [runId, c.case_id, c.position, c.kind, c.prompt ? stringifyJson(c.arguments) : null, c.expected_error, c.content_digest, c.prompt?.system ?? null,
              c.prompt?.user ?? null, c.prompt?.sha256 ?? null],
          );
          if (c.prompt) await keepRunPrivate(client, runId, benchmark.case_set_id, c.case_id);
          attemptId = crypto.randomUUID();
          await client.query('insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no) values ($1, $2, $3, 1)', [attemptId, runId, c.case_id]);
        }
        if (free) {
          attemptId = crypto.randomUUID();
          await client.query('insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no) values ($1, $2, null, 1)', [attemptId, runId]);
        }
        return {run_id: runId, replayed: false, ...(session ? {attempt_id: attemptId} : {})};
      });
    },

    /**
     * Pin the one case of the caller's session run `runId`, queued before it was known: `benchmark` is the session's benchmark with its
     * case set kept (`saveCaseSet`) and `c` the case as it resolved (`resolve`'s), its rendered prompt and private reference.
     */
    async pinSessionCase(context, runId, benchmark, c) {
      return memberWrite(context, async client => {
        const run = await client.query(
          'update benchmark_run set case_set_id = $3, case_set_digest = $4 where run_id = $1 and user_id = $2 and case_set_id is null',
          [runId, context.userId, benchmark.case_set_id, benchmark.case_set_digest],
        );
        if (!run.rowCount) throw new BenchmarkError(409, 'case_pinned', `Run ${runId} is no session of yours waiting for its case`);
        await client.query(
          `update benchmark_run_case set arguments = $3, content_digest = $4, prompt_system = $5, prompt_user = $6, prompt_sha256 = $7
            where run_id = $1 and case_id = $2 and prompt_sha256 is null and pin_error is null`,
          [runId, c.case_id, stringifyJson(c.arguments), c.content_digest, c.prompt.system, c.prompt.user, c.prompt.sha256],
        );
        await keepRunPrivate(client, runId, benchmark.case_set_id, c.case_id);
      });
    },
    /** Say why the case `caseId` of the caller's session run `runId` could not be pinned: its harness then ends with `error`, unscored. */
    async failSessionCase(context, runId, caseId, error) {
      return memberWrite(context, client => client.query(
        `update benchmark_run_case c set pin_error = $4 from benchmark_run r
          where c.run_id = $1 and c.case_id = $2 and r.run_id = c.run_id and r.user_id = $3 and c.prompt_sha256 is null`,
        [runId, caseId, context.userId, error],
      ));
    },

    /** The caller's own runs as run summaries, newest first; a Harness tab session is not a benchmark result, so it is not listed. */
    async listRuns(context, {limit, before}) {
      await sweep();
      return member(context, async client => (await client.query(
        `select s.* from benchmark_run_summary s join benchmark_run r on r.run_id = s.run_id
          where not r.session and ($1::timestamptz is null or s.created_at < $1) order by s.created_at desc, s.run_id limit $2`, [before, limit],
      )).rows.map(runSummary));
    },
    async run(context, runId) {
      await sweep();
      return member(context, async client => {
        const row = (await client.query('select * from benchmark_run where run_id = $1', [runId])).rows[0];
        return row ? runDetail(client, row) : null;
      });
    },
    async attempt(context, attemptId) {
      await sweep();
      return member(context, async client => {
        const row = (await client.query(
          `select a.*, c.kind, c.content_digest, c.prompt_system, c.prompt_user, c.prompt_sha256
             from benchmark_attempt a left join benchmark_run_case c on c.run_id = a.run_id and c.case_id = a.case_id
            where a.attempt_id = $1`, [attemptId],
        )).rows[0];
        return row ? {...attemptView(row), kind: row.kind, content_digest: row.content_digest, prompt: promptView(row)} : null;
      });
    },
    /** Committed events after `after`, at most `limit`, and the attempt's seal: null for an attempt the caller cannot see. */
    async events(context, attemptId, after, limit) {
      return member(context, async client => {
        const attempt = (await client.query('select sealed, final_cursor, next_cursor - 1 as high_water from benchmark_attempt where attempt_id = $1', [attemptId])).rows[0];
        if (!attempt) return null;
        // The page ends at `limit` events or once its data passes MAX_EVENT_PAGE_BYTES, whichever comes first (it always holds one).
        const rows = (await client.query(
          `select cursor, event_id, source, kind, sequence, occurred_ns, data, payload_sha256s, received_at from (
             select cursor, event_id, source, kind, sequence, occurred_ns::text as occurred_ns, data, payload_sha256s, received_at,
               sum(octet_length(data::text)) over (order by cursor) - octet_length(data::text) as before_bytes
               from benchmark_event where attempt_id = $1 and cursor > $2 order by cursor limit $3) page
            where before_bytes < $4 order by cursor`, [attemptId, after, limit, MAX_EVENT_PAGE_BYTES],
        )).rows;
        return {
          events: rows.map(row => ({...row, cursor: Number(row.cursor), sequence: Number(row.sequence)})),
          has_more: rows.length > 0 && Number(rows.at(-1).cursor) < Number(attempt.high_water), sealed: attempt.sealed,
          final_cursor: attempt.final_cursor === null ? null : Number(attempt.final_cursor), high_water_cursor: Number(attempt.high_water),
        };
      });
    },
    async spans(context, attemptId, {kind, status, q, limit}) {
      return member(context, async client => {
        if (!(await client.query('select 1 from benchmark_attempt where attempt_id = $1', [attemptId])).rowCount) return null;
        const escaped = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
        // Each read ends at its row limit or once its bytes pass MAX_TRACE_PAGE_BYTES, whichever comes first (it always holds one row).
        const spanRows = (await client.query(
          `select id, kind, name, parent, scope, status, start_ns, end_ns, provenance, target, attributes, fetched from (
             select *, count(*) over () as fetched, sum(octet_length(attributes::text) + octet_length(name) + 512) over (order by order_ns nulls last, id) - octet_length(attributes::text) - octet_length(name) - 512 as before_bytes from (
               select span_id as id, kind, name, parent_id as parent, scope, status, start_ns::text, end_ns::text, start_ns as order_ns, provenance, target, attributes
                 from benchmark_span where attempt_id = $1 and ($2::text is null or kind = $2) and ($3::text is null or status = $3)
                  and ($4::text is null or name ilike $4 or target ilike $4 or scope ilike $4 or span_id ilike $4)
                order by order_ns nulls last, id limit $5) page) sized
            where before_bytes < $6 order by order_ns nulls last, id`, [attemptId, kind, status, escaped, limit, MAX_TRACE_PAGE_BYTES],
        )).rows;
        const linkRows = (await client.query(
          `select kind, "from", "to", method, attributes, fetched from (
             select *, sum(octet_length(attributes::text) + 512) over (order by kind, "from", "to") - octet_length(attributes::text) - 512 as before_bytes from (
               select kind, from_id as "from", to_id as "to", method, attributes, count(*) over () as fetched
                 from benchmark_link where attempt_id = $1 order by kind, from_id, to_id limit $2) page) sized
            where before_bytes < $3 order by kind, "from", "to"`, [attemptId, MAX_ATTEMPT_LINKS, MAX_TRACE_PAGE_BYTES],
        )).rows;
        const cut = rows => rows.length > 0 && rows.length < Number(rows[0].fetched);
        const strip = ({fetched, ...row}) => row;
        return {spans: spanRows.map(strip), links: linkRows.map(strip), truncated: cut(spanRows) || cut(linkRows)};
      });
    },
    /**
     * Where the caller reaches their session attempt's terminals on their computer: `{port, token}`, `{port: null}` before its worker
     * started them; null for an attempt that is not the caller's own running session.
     */
    async terminalLink(context, attemptId) {
      return member(context, async client => {
        const row = (await client.query(
          `select l.port, l.token from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id
             left join benchmark_terminal_link l on l.attempt_id = a.attempt_id
            where a.attempt_id = $1 and r.user_id = $2 and r.interactive`, [attemptId, context.userId],
        )).rows[0];
        return row ? {port: row.port, token: row.token} : null;
      });
    },
    async payload(context, attemptId, sha256) {
      return member(context, async client => (await client.query(
        'select data, size, redaction, content_type from benchmark_payload where attempt_id = $1 and sha256 = $2', [attemptId, sha256],
      )).rows[0] ?? null);
    },
    async accounting(context, attemptId) {
      await sweep();
      return member(context, async client => {
        if (!(await client.query('select 1 from benchmark_attempt where attempt_id = $1', [attemptId])).rowCount) return null;
        const calls = (await client.query(
          `select d.call_id, d.status, d.reserve_usd::float8 as reserve_usd, d.cost_usd::float8 as cost_usd, d.provenance, d.created_at, d.settled_at,
             a.version, a.record
             from benchmark_admission d left join lateral (select version, record from benchmark_accounting x
               where x.attempt_id = d.attempt_id and x.call_id = d.call_id order by version desc limit 1) a on true
            where d.attempt_id = $1 order by d.created_at, d.call_id`, [attemptId],
        )).rows;
        const sum = pick => calls.reduce((total, call) => total + pick(call), 0);
        return {
          calls: calls.map(call => ({
            call_id: call.call_id,
            admission: {status: call.status, reserve_usd: call.reserve_usd, cost_usd: call.cost_usd, provenance: call.provenance, created_at: call.created_at, settled_at: call.settled_at},
            accounting: call.version === null ? null : {version: call.version, record: call.record},
          })),
          totals: {
            calls: calls.length,
            reserved_usd: sum(call => (call.status === 'settled' ? 0 : call.reserve_usd)),
            // Null when calls were made but none has a known cost (every one reserved or uncertain): an unknown cost is never zero.
            settled_usd: calls.length && !calls.some(call => call.status === 'settled') ? null : sum(call => (call.status === 'settled' ? call.cost_usd : 0)),
            uncertain_calls: calls.filter(call => call.status === 'uncertain').length,
          },
        };
      });
    },

    /**
     * Queue a new attempt of a case, as the member who owns the run. `{attempt_id}`, or throws
     * unknown_case, run_canceled or attempt_active. The run's retained package and source
     * are used, whether or not the plugin is still installed.
     */
    async rerun(context, runId, caseId) {
      return ownRunWrite(context, runId, async client => {
        const run = (await client.query('select run_id, canceled_at from benchmark_run where run_id = $1 for update', [runId])).rows[0];
        if (run.canceled_at) throw new BenchmarkError(409, 'run_canceled', 'A canceled run takes no new attempts');
        const latest = (await client.query(
          `select attempt_id, attempt_no, state from benchmark_attempt where run_id = $1 and case_id = $2
            order by attempt_no desc limit 1`, [runId, caseId],
        )).rows[0];
        if (!latest) throw new BenchmarkError(404, 'unknown_case', `Run ${runId} has no case ${caseId}`);
        if (latest.state !== 'final') throw new BenchmarkError(409, 'attempt_active', 'The case has an attempt that is not final yet');
        // Run detail and comparison load every attempt of a run, so a case's attempts are capped.
        if (latest.attempt_no >= MAX_ATTEMPTS_PER_CASE) throw new BenchmarkError(409, 'too_many_attempts', `A case keeps ${MAX_ATTEMPTS_PER_CASE} attempts at most`);
        const attemptId = crypto.randomUUID();
        await client.query(
          'insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, rerun_of) values ($1, $2, $3, $4, $5)',
          [attemptId, runId, caseId, latest.attempt_no + 1, latest.attempt_id],
        );
        return {attempt_id: attemptId, attempt_no: latest.attempt_no + 1};
      });
    },

    /**
     * Cancel a run: its queued attempts end canceled at once, and a leased attempt is told at its
     * next renewal. `{canceled_attempts, signaled_attempts}`; canceling again changes nothing.
     */
    async cancel(context, runId) {
      return ownRunWrite(context, runId, async client => {
        await client.query('select run_id from benchmark_run where run_id = $1 for update', [runId]);
        await client.query('update benchmark_run set canceled_at = coalesce(canceled_at, now()) where run_id = $1', [runId]);
        const queued = await client.query(
          `update benchmark_attempt set state = 'final', execution_status = 'canceled', finalized_at = now(), sealed = true,
             final_cursor = next_cursor - 1 where run_id = $1 and state = 'queued'`, [runId]);
        const leased = await client.query(
          "update benchmark_attempt set cancel_requested = true where run_id = $1 and state = 'leased'", [runId]);
        return {canceled_attempts: queued.rowCount, signaled_attempts: leased.rowCount};
      });
    },

    /**
     * What each attempt of run `runId` cost, from its model call admissions: `Map<attempt_id, {cost_usd, calls, uncertain_calls}>`.
     * `cost_usd` sums the settled costs and is null when any call is not settled with a known cost (a reserve is a spending
     * bound, not a cost).
     */
    async runCosts(context, runId) {
      return member(context, async client => new Map((await client.query(
        `select d.attempt_id, count(*)::int as calls, count(*) filter (where d.status = 'uncertain')::int as uncertain_calls,
           case when bool_and(d.status = 'settled' and d.cost_usd is not null) then sum(d.cost_usd)::float8 end as cost_usd
           from benchmark_admission d join benchmark_attempt a on a.attempt_id = d.attempt_id where a.run_id = $1 group by d.attempt_id`, [runId],
      )).rows.map(row => [row.attempt_id, {cost_usd: row.cost_usd, calls: row.calls, uncertain_calls: row.uncertain_calls}])));
    },

    /**
     * The caller's own Harness tab sessions (runs with `session`), newest first, each attempt with its model calls (the gateway's
     * spans), the processes the process record shows (with `atCalls`, only those running when one of its model calls started, or all
     * of them when it made none: what names its agents, or its main command; and, without their argv and folder, every process those
     * started, the tools an agent ran), the turns at its terminals (`terminal_turn` spans: from the member's Enter to the last output
     * before they typed again) and each call's settled cost (null while it is not; jsonb, so a cost reads as a number, not as the
     * LosslessNumber a json column's decimal reads as): of plugin `pluginId`, or only attempt `attemptId`.
     */
    async terminalRows(context, {pluginId = null, attemptId = null, atCalls = false}) {
      await sweep();
      return member(context, async client => (await client.query(
        `select a.attempt_id, a.state, a.finalized_at, a.resumable, a.chats, r.resumed_from, r.archived_chats, (a.metrics->>'elapsed_ms')::float8 as elapsed_ms, r.harness_name, r.task_id, r.interactive, r.created_at,
           coalesce((select json_agg(json_build_object('call_id', s.attributes->>'call_id', 'status', s.status, 'client', s.attributes->>'client',
               'prompt', s.attributes->>'prompt', 'start_ns', s.start_ns::text, 'end_ns', s.end_ns::text, 'usage', s.attributes->'usage') order by s.start_ns)
              from benchmark_span s where s.attempt_id = a.attempt_id and s.kind = 'model_call'), '[]') as calls,
           coalesce((with recursive named as (
                select s.span_id from benchmark_span s where s.attempt_id = a.attempt_id and s.kind = 'process'
                 and (not $3::boolean or not exists (select 1 from benchmark_span c where c.attempt_id = a.attempt_id and c.kind = 'model_call')
                   or exists (select 1 from benchmark_span c where c.attempt_id = a.attempt_id and c.kind = 'model_call'
                     and s.start_ns <= c.start_ns and (s.end_ns is null or s.end_ns >= c.start_ns)))),
              tree as (select span_id from named union
                select c.span_id from benchmark_span c join tree t on c.parent_id = t.span_id where c.attempt_id = a.attempt_id and c.kind = 'process')
              select json_agg(json_build_object('span_id', s.span_id, 'parent_id', s.parent_id,
                  'argv', case when s.span_id in (select span_id from named) then s.attributes->'argv' end,
                  'cwd', case when s.span_id in (select span_id from named) then s.attributes->>'cwd' end,
                  'title', case when s.span_id in (select span_id from named) then s.attributes->>'title' end,
                  'verdict', case when s.span_id in (select span_id from named) then s.attributes->>'verdict' end,
                  'start_ns', s.start_ns::text, 'end_ns', s.end_ns::text) order by s.start_ns nulls first)
                from benchmark_span s join tree t on t.span_id = s.span_id where s.attempt_id = a.attempt_id), '[]') as processes,
           coalesce((select json_agg(json_build_object('terminal', s.attributes->'terminal', 'start_ns', s.start_ns::text, 'end_ns', s.end_ns::text,
               'until_ns', s.attributes->>'until_ns') order by s.start_ns)
              from benchmark_span s where s.attempt_id = a.attempt_id and s.kind = 'terminal_turn'), '[]') as turns,
           coalesce((select jsonb_object_agg(d.call_id, d.cost_usd::float8) from benchmark_admission d
              where d.attempt_id = a.attempt_id and d.status = 'settled'), '{}') as costs
           from benchmark_run r join benchmark_attempt a on a.run_id = r.run_id
          where r.user_id = $4 and r.session and ($1::text is null or r.plugin_id = $1) and ($2::uuid is null or a.attempt_id = $2)
          order by r.created_at desc, a.attempt_no desc`, [pluginId, attemptId, atCalls, context.userId],
      )).rows);
    },
    /** The member's free-form Terminal session on plugin `pluginId` that still runs, `{run_id, attempt_id}`, or null. */
    async liveTerminal(context, pluginId) {
      await sweep();
      return member(context, async client => (await client.query(
        `select r.run_id, a.attempt_id from benchmark_run r join benchmark_attempt a on a.run_id = r.run_id
          where r.user_id = $1 and r.plugin_id = $2 and r.session and r.interactive and r.harness_name = 'shell' and r.task_id is null
            and r.canceled_at is null and a.state <> 'final' and not a.cancel_requested
          order by r.created_at desc limit 1`, [context.userId, pluginId],
      )).rows[0] ?? null);
    },
    /** Everything each terminal of attempt `attemptId` wrote, by terminal: `[{terminal, data}]`, data a Buffer. */
    async terminalTranscripts(context, attemptId) {
      return member(context, async client => (await client.query(
        `select t.terminal, string_agg(t.data, ''::bytea order by t.byte_offset) as data from benchmark_terminal t
          join benchmark_attempt a on a.attempt_id = t.attempt_id join benchmark_run r on r.run_id = a.run_id
          where t.attempt_id = $1 and r.user_id = $2 group by t.terminal order by t.terminal`, [attemptId, context.userId],
      )).rows);
    },
    /**
     * Archive chat `chat` ("<agent>:<id>") of the caller's Harness tab session `attemptId`, the one that last held it, or with `archived`
     * false restore it; false when the session is not theirs.
     */
    async archiveChat(context, attemptId, chat, archived) {
      return member(context, async client => {
        const [run] = (await client.query(
          'select r.run_id from benchmark_run r join benchmark_attempt a on a.run_id = r.run_id where a.attempt_id = $1 and r.user_id = $2 and r.session', [attemptId, context.userId],
        )).rows;
        if (!run) return false;
        await client.query("select set_config('app.benchmark_system', 'on', true)");
        await client.query(
          `update benchmark_run set archived_chats = case when $3 then archived_chats || jsonb_build_object($2::text, now()) else archived_chats - $2::text end
            where run_id = $1`, [run.run_id, chat, archived],
        );
        return true;
      });
    },

    /** Published plugin version `version` of `pluginId`: `{entry, sha256}`, or null. */
    async marketVersion(context, pluginId, version) {
      return member(context, async client => (await client.query(
        'select entry, sha256 from market_plugin_version where plugin_id = $1 and version = $2', [pluginId, version],
      )).rows[0] ?? null);
    },

    /**
     * Keep a run of a reference harness made outside RUSH (examples/benchmark in the NanoAgent project) as the caller's own scored run:
     * `frame` is its case set but the case (`publicationFrame`, checked against its plugin version's entry), `record` the case it ran
     * (`importBody`, whose own frame is `frame` before the check), worked by the harness of the caller's source `record.source_sha256`. Like a session's, its run is of a benchmark
     * nobody publishes; its one attempt is final as the run ended, with its verdict, its time, tokens and profile (metrics), its cost (one
     * settled admission) and its trace (`keepTrace`). `{run_id, created, filled}`: the same plugin, task, case and harness kept again is
     * the run kept before, its trace (case and answer) or its profile filled in (`filled`) when it was kept without it; only its version
     * and score (the verifier's verdict and word, and the answer when kept) are compared, and a different one is refused (409
     * idempotency_conflict). The rest (frame, source, time, tokens, cost) is what a later build of the harness may record differently.
     */
    async importRun(context, frame, record) {
      return memberWrite(context, async client => {
        const source = (await client.query(
          'select harness_name, harness_version, dialects from benchmark_source where workspace_id = $1 and user_id = $2 and sha256 = $3',
          [context.workspaceId, context.userId, record.source_sha256],
        )).rows[0];
        if (!source) throw new BenchmarkError(404, 'unknown_source', 'Upload the source first');
        checkReference(source.harness_name);
        const key = `import:${frame.plugin_id}/${frame.task_id}/${record.case_id}/${source.harness_name}`;
        const said = {correct: record.correct, verdict: record.verdict};
        const digest = sha256Hex(canonicalJson({key, version: frame.version, ...said, answer: record.answer}));
        const policy = referencePolicy(source.harness_name);
        const ended = new Date(Date.parse(record.started_at) + record.elapsed_ms).toISOString();
        const metrics = {
          elapsed_ms: record.elapsed_ms, input_tokens: record.input_tokens, output_tokens: record.output_tokens, total_tokens: record.input_tokens + record.output_tokens,
          ...record.profile,
        };
        const existing = (await client.query(
          'select run_id, version from benchmark_run where workspace_id = $1 and user_id = $2 and idempotency_key = $3', [context.workspaceId, context.userId, key],
        )).rows[0];
        if (existing) {
          const kept = (await client.query(
            `select a.attempt_id, a.metrics ? 'model_ms' as profiled, c.prompt_sha256, v.data as said, w.data as answered
               from benchmark_attempt a join benchmark_run_case c using (run_id, case_id)
               join benchmark_event v on v.attempt_id = a.attempt_id and v.event_id = 'verdict'
               left join benchmark_event w on w.attempt_id = a.attempt_id and w.event_id = 'answer'
              where a.run_id = $1`,
            [existing.run_id],
          )).rows[0];
          const differs = existing.version !== frame.version || canonicalJson(kept.said) !== canonicalJson(said)
            || (kept.answered !== null && canonicalJson(kept.answered) !== canonicalJson({answer: record.answer}));
          if (differs) throw new BenchmarkError(409, 'idempotency_conflict', `${key} was kept with a different record`);
          if (kept.prompt_sha256 === null) await keepTrace(client, frame, record, {runId: existing.run_id, attemptId: kept.attempt_id, policy, ended});
          if (!kept.profiled) await client.query('update benchmark_attempt set metrics = $2 where attempt_id = $1', [kept.attempt_id, JSON.stringify(metrics)]);
          return {run_id: existing.run_id, created: false, filled: kept.prompt_sha256 === null || !kept.profiled};
        }
        await client.query(
          'insert into benchmark_package (sha256, data) select sha256, package from market_plugin_version where plugin_id = $1 and sha256 = $2 limit 1 on conflict do nothing',
          [frame.plugin_id, frame.package_sha256],
        );
        const [runId, attemptId] = [crypto.randomUUID(), crypto.randomUUID()];
        await client.query(
          `insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, preview_id, source_sha256,
             model, endpoint_label, dialects, policy, prompt_text, limits, selection, renderer_version,
             benchmark_id, benchmark_name, harness_name, harness_version, publisher,
             plugin_id, plugin_name, version, package_sha256, task_id, task, context, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)`,
          [runId, context.workspaceId, context.userId, key, digest, crypto.randomUUID(), record.source_sha256,
            frame.model, frame.endpoint_profile, JSON.stringify(source.dialects), policy, policy === 'coding' ? frame.coding_template : frame.task_instructions,
            JSON.stringify(frame.limits), JSON.stringify({case_ids: [record.case_id]}), RENDERER_VERSION,
            crypto.randomUUID(), frame.name, source.harness_name, source.harness_version, JSON.stringify(await publisherOf(client, context.userId)),
            frame.plugin_id, frame.plugin_name, frame.version, frame.package_sha256, frame.task_id, stringifyJson(frame.task), frame.context, record.started_at],
        );
        await client.query('insert into benchmark_run_case (run_id, case_id, position, kind) values ($1, $2, 0, $3)', [runId, record.case_id, record.kind]);
        await client.query(
          `insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, execution_status, verdict, explanation, metrics,
             sealed, next_cursor, final_cursor, created_at, claimed_at, finalized_at)
           values ($1, $2, $3, 1, 'final', $4, $5, $6, $7, true, 2, 1, $8, $8, $9)`,
          [attemptId, runId, record.case_id, record.execution, record.correct ? 'pass' : 'fail',
            record.execution === 'execution_failed' ? 'execution_failed' : null, JSON.stringify(metrics), record.started_at, ended],
        );
        await client.query(
          `insert into benchmark_event (attempt_id, cursor, event_id, source, kind, sequence, data, digest, received_at)
           values ($1, 1, 'verdict', 'import', 'verifier.verdict', 1, $2, $3, $4)`,
          [attemptId, JSON.stringify(said), sha256Hex(canonicalJson(said)), ended],
        );
        await client.query(
          `insert into benchmark_admission (attempt_id, call_id, reserve_usd, status, cost_usd, day, created_at, settled_at, deadline_at)
           values ($1, 'import', $2, 'settled', $2, $3::timestamptz::date, $3, $4, $4)`,
          [attemptId, record.cost_usd, record.started_at, ended],
        );
        await keepTrace(client, frame, record, {runId, attemptId, policy, ended});
        return {run_id: runId, created: true, filled: true};
      });
    },
  });
}

module.exports = {createPostgresBenchmark};
