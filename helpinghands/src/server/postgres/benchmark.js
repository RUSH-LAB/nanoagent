'use strict';
const crypto = require('crypto');
const {BenchmarkError} = require('../benchmark/errors');
const {checkTaskAgainstEntry} = require('../benchmark/entry-check');
const {CAPABILITY_WINDOW_S} = require('../benchmark/limits');
const {stringifyJson} = require('../benchmark/json');
const {latestByCase, runScore, sumMetrics} = require('../benchmark/rules');
const {MAX_ATTEMPT_LINKS, MAX_ATTEMPTS_PER_CASE, MAX_EVENT_PAGE_BYTES, MAX_TRACE_PAGE_BYTES} = require('../benchmark/limits');
const {chargeStorage, inTransaction, lockStorage} = require('./benchmark-context');
const {sweepExpired} = require('./benchmark-sweep');

function attemptView(row) {
  return {
    attempt_id: row.attempt_id, run_id: row.run_id, case_id: row.case_id,
    attempt_no: row.attempt_no, rerun_of: row.rerun_of, state: row.state,
    execution: row.execution_status ? {status: row.execution_status, reason: row.execution_reason} : null,
    verdict: row.verdict, explanation: row.explanation, verifier_error: row.verifier_error,
    // The names and statuses of the verifier's checks, which only the run's member reads (an attempt is read as its member).
    checks: row.checks,
    coverage: row.coverage, metrics: row.metrics, sealed: row.sealed, final_cursor: row.final_cursor === null ? null : Number(row.final_cursor),
    high_water_cursor: Number(row.next_cursor) - 1, cancel_requested: row.cancel_requested,
    created_at: row.created_at, claimed_at: row.claimed_at, finalized_at: row.finalized_at,
    // A Terminal session's files in RUSH: their bytes, or why its worker uploaded none (`error`); null for an attempt that uploads none.
    workspace: row.workspace && (row.workspace.error ? {error: row.workspace.error} : {bytes: row.workspace.bytes}),
  };
}

/** A run as the API summarizes it, from a `benchmark_run_summary` row: the caller's own runs and other members' alike. */
function runSummary(row) {
  const latest = latestByCase(row.attempts);
  return {
    run_id: row.run_id, harness: {name: row.harness_name}, benchmark: {name: row.benchmark_name},
    plugin: {id: row.plugin_id, name: row.plugin_name, version: row.plugin_version}, model: row.model,
    // The detail's own sum (GET /runs/{run_id}), so a list row's metrics equal it.
    user: {id: row.user_id, name: row.user_name, github: row.user_github}, metrics: sumMetrics([...latest.values()].map(attempt => attempt.metrics)),
    status: runStatus(row, row.attempts), score: runScore(row.case_ids, row.attempts), created_at: row.created_at,
    archived: row.archived_at != null,
  };
}

/** A case's fixtures as the API shows them: their digest and files, never the archive; null for a case with none. */
const fixturesView = row => (row.fixtures_sha256 === null ? null : {sha256: row.fixtures_sha256, files: row.fixtures_files});

/**
 * Cancel member `userId`'s unfinished interactive session runs, as `cancel` does one run: a queued attempt ends canceled, a leased
 * one is told to stop. `client` acts as the system.
 */
/**
 * The member's session someone is at that has not ended, `{run_id, attempt_id, free}` (`free` a free-form Terminal session), or null.
 * Given `lock`, it first takes the member's lock for starting one, held to the end of the transaction, so two starts never both find none.
 */
async function liveSessionOf(client, userId, {lock = false} = {}) {
  if (lock) await client.query('select pg_advisory_xact_lock(hashtext($1))', [`benchmark-session:${userId}`]);
  return (await client.query(
    `select r.run_id, a.attempt_id, (r.harness_name = 'shell' and r.task_id is null) as free from benchmark_run r join benchmark_attempt a on a.run_id = r.run_id
      where r.user_id = $1 and r.session and r.interactive and r.canceled_at is null and a.state <> 'final' and not a.cancel_requested
      order by r.created_at desc limit 1`, [userId],
  )).rows[0] ?? null;
}

function runStatus(run, attempts) {
  if (run.canceled_at) return 'canceled';
  const current = [...latestByCase(attempts).values()];
  if (current.every(attempt => attempt.state === 'final')) return 'complete';
  return current.some(attempt => attempt.state === 'leased' || attempt.state === 'final') ? 'running' : 'queued';
}

/**
 * Benchmarks and the member's runs (migration 0052). Every read is as the
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
    model: row.model, endpoint_profile: row.endpoint_label, limits: row.limits, published_at: row.published_at,
    case_count: Number(row.case_count), answer_count: Number(row.answer_count), refuse_count: Number(row.refuse_count),
  });
  const BENCHMARK_SELECT = `select b.benchmark_id, b.name, b.plugin_id, b.plugin_version, b.model, b.endpoint_label, b.limits,
    b.digest, b.published_at, b.publisher_id, u.display_name as publisher_name, u.github_login as publisher_github,
    s.case_set_id, s.plugin_name, s.package_sha256, s.task_id, s.task, s.digest as case_set_digest,
    (select count(*) from benchmark_case_set_case c where c.case_set_id = s.case_set_id) as case_count,
    (select count(*) from benchmark_case_set_case c where c.case_set_id = s.case_set_id and c.kind = 'answer') as answer_count,
    (select count(*) from benchmark_case_set_case c where c.case_set_id = s.case_set_id and c.kind = 'refuse') as refuse_count
    from benchmark b join benchmark_case_set s on s.case_set_id = b.case_set_id join app_user u on u.id = b.publisher_id`;

  /** The run `row` as the API shows it. */
  async function runDetail(client, row) {
    const runId = row.run_id;
    const results = [];
    for (const [sql, values] of [
      ['select * from benchmark_run_case where run_id = $1 order by position', [runId]],
      ['select * from benchmark_attempt where run_id = $1 order by case_id, attempt_no', [runId]],
    ]) results.push((await client.query(sql, values)).rows);
    const [cases, attempts] = results;
    const latest = latestByCase(attempts);
    return {
      run_id: runId, status: runStatus(row, attempts), created_at: row.created_at, canceled_at: row.canceled_at,
      benchmark: {benchmark_id: row.benchmark_id, name: row.benchmark_name}, harness: {name: row.harness_name},
      model: row.model, endpoint_profile: row.endpoint_label,
      limits: row.limits, egress_hosts: row.task?.egress_hosts ?? null, unverified_egress: row.limits.internet_access === true,
      case_set: {
        case_set_id: row.case_set_id, name: row.benchmark_name, digest: row.case_set_digest, publisher: row.publisher,
        plugin: {id: row.plugin_id, name: row.plugin_name, version: row.version, sha256: row.package_sha256},
        task_id: row.task_id, task: row.task,
      },
      cases: cases.map(c => ({
        case_id: c.case_id, position: c.position, kind: c.kind, prompt: c.prompt, prompt_sha256: c.prompt_sha256, arguments: c.arguments, fixtures: fixturesView(c),
        expected_error: c.expected_error, content_digest: c.content_digest,
        latest_attempt_id: latest.get(c.case_id)?.attempt_id ?? null,
        attempts: attempts.filter(a => a.case_id === c.case_id).map(attemptView),
      })),
      score: runScore(cases.map(c => c.case_id), attempts),
      metrics: sumMetrics([...latest.values()].map(a => a.metrics)),
    };
  }

  /**
   * Keep the case set of `benchmark` (a validated publication) for its published plugin version, or reuse an identical one: its
   * cases, and their private references. Resolves to its id, the case set's digest.
   */
  async function keepCaseSet(client, userId, benchmark) {
    const version = (await client.query(
      'select entry from market_plugin_version where plugin_id = $1 and version = $2 and sha256 = $3', [benchmark.plugin_id, benchmark.version, benchmark.package_sha256],
    )).rows[0];
    if (!version) throw new BenchmarkError(404, 'unknown_plugin_version', `${benchmark.plugin_id} ${benchmark.version} with that sha256 is not published`);
    checkTaskAgainstEntry(version.entry, benchmark);
    const caseSetId = benchmark.case_set_digest;
    const caseSet = await client.query(
      `insert into benchmark_case_set (case_set_id, publisher_id, plugin_id, plugin_name, version, package_sha256, task_id, task, digest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $1) on conflict do nothing`,
      [caseSetId, userId, benchmark.plugin_id, benchmark.plugin_name, benchmark.version, benchmark.package_sha256, benchmark.task_id, stringifyJson(benchmark.task)],
    );
    if (caseSet.rowCount) {
      for (const [position, c] of benchmark.cases.entries()) {
        // A fixtures archive is kept once per digest, whichever cases of whichever benchmarks hold it.
        if (c.fixtures) await keepFixtures(client, userId, c.fixtures);
        await client.query(
          `insert into benchmark_case_set_case (case_set_id, case_id, position, kind, prompt, prompt_sha256, fixtures_sha256, fixtures_files, arguments, expected_error,
             reference_sha256, content_digest) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [caseSetId, c.case_id, position, c.kind, c.prompt, c.prompt_sha256, c.fixtures?.sha256 ?? null, c.fixtures ? JSON.stringify(c.fixtures.files) : null,
            stringifyJson(c.arguments), c.expected_error, c.reference_sha256, c.content_digest],
        );
        await client.query(
          'insert into benchmark_case_set_private (case_set_id, case_id, reference) values ($1, $2, $3)',
          [caseSetId, c.case_id, stringifyJson(benchmark.private[c.case_id])],
        );
      }
    }
    return caseSetId;
  }

  /** Keep fixtures archive `fixtures.archive` under its digest, charged to `userId` the first time. */
  async function keepFixtures(client, userId, fixtures) {
    // Under the member's storage lock, so a publication of theirs that keeps the same new archive at the same moment finds it kept, and is not charged it twice.
    await lockStorage(client, userId);
    if ((await client.query('select benchmark_fixtures_known($1) as known', [fixtures.sha256])).rows[0].known) return;
    await chargeStorage(client, userId, fixtures.archive.length);
    await client.query('insert into benchmark_fixtures (sha256, publisher_id, archive) values ($1, $2, $3) on conflict do nothing', [fixtures.sha256, userId, fixtures.archive]);
  }

  /** Copy the private reference of case `caseId` of case set `caseSetId` to run `runId`. */
  const keepRunPrivate = (client, runId, caseSetId, caseId) => client.query(
    `insert into benchmark_run_private (run_id, case_id, reference)
     select $1, case_id, reference from benchmark_case_set_private where case_set_id = $2 and case_id = $3`,
    [runId, caseSetId, caseId],
  );
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
    /** A benchmark with its case set's task and cases (public parts only: prompts, fixtures' digests and files, arguments), or null. */
    async benchmark(context, benchmarkId) {
      return member(context, async client => {
        const row = (await client.query(`${BENCHMARK_SELECT} where b.benchmark_id = $1`, [benchmarkId])).rows[0];
        if (!row) return null;
        const cases = (await client.query(
          `select case_id, position, kind, prompt, prompt_sha256, fixtures_sha256, fixtures_files, arguments, expected_error, content_digest
             from benchmark_case_set_case where case_set_id = $1 order by position`, [row.case_set_id],
        )).rows.map(({fixtures_sha256: sha256, fixtures_files: files, ...c}) => ({...c, fixtures: fixturesView({fixtures_sha256: sha256, fixtures_files: files})}));
        return {...benchmarkRow(row), task: row.task, cases};
      });
    },
    /**
     * Publish a benchmark as `userId`, for any published plugin version, creating its case set or reusing an identical one. A name is unique
     * per plugin version: the same benchmark again changes nothing, a different one under the name is refused (`benchmark_name_taken`) and
     * stores nothing. `benchmark` is the validated publication (`benchmarkPublication`). Resolves to `{created, benchmark_id}`.
     */
    async publishBenchmark(userId, benchmark) {
      return inTransaction(pool, {userId}, async client => {
        const caseSetId = await keepCaseSet(client, userId, benchmark);
        const benchmarkId = crypto.randomUUID();
        const inserted = await client.query(
          `insert into benchmark (benchmark_id, name, plugin_id, plugin_version, case_set_id, model, endpoint_label, limits, digest, publisher_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (plugin_id, plugin_version, name) do nothing`,
          [benchmarkId, benchmark.name, benchmark.plugin_id, benchmark.version, caseSetId, benchmark.model, benchmark.endpoint_profile, JSON.stringify(benchmark.limits),
            benchmark.digest, userId],
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

    /** Member `userId` as a case set's publisher: `{id, name, github}`. */
    async publisher(userId) {
      return inTransaction(pool, {userId}, client => publisherOf(client, userId));
    },

    /** The latest live worker for this endpoint, optionally restricted to one that has the agent. */
    async capabilities(userId, label, {agent} = {}) {
      return inTransaction(pool, {system: true}, async client => (await client.query(
        `select capabilities from benchmark_worker_capability
          where user_id = $1 and endpoint_label = $2 and updated_at > now() - make_interval(secs => $3)
            and ($4::text is null or (capabilities->'installed_agents') ? $4)
          order by updated_at desc, worker_id limit 1`,
        [userId, label, CAPABILITY_WINDOW_S, agent ?? null],
      )).rows[0]?.capabilities ?? null);
    },
    /** One endpoint per label, with the union of its live workers' installed agents. */
    async endpoints(userId) {
      return inTransaction(pool, {system: true}, async client => {
        const rows = (await client.query(
          `select endpoint_label as label, capabilities, updated_at, updated_at + make_interval(secs => $1) as expires_at
             from benchmark_worker_capability where user_id = $2 and updated_at > now() - make_interval(secs => $1)
             order by endpoint_label, updated_at desc, worker_id`,
          [CAPABILITY_WINDOW_S, userId],
        )).rows;
        const endpoints = new Map();
        for (const row of rows) {
          if (!endpoints.has(row.label)) endpoints.set(row.label, {...row, capabilities: {...row.capabilities, installed_agents: []}});
          const agents = endpoints.get(row.label).capabilities.installed_agents;
          for (const agent of row.capabilities.installed_agents ?? []) if (!agents.includes(agent)) agents.push(agent);
        }
        return [...endpoints.values()].map(row => ({...row, capabilities: {...row.capabilities, installed_agents: row.capabilities.installed_agents.sort()}}));
      });
    },

    /** The caller's run submitted under `key`: `{run_id, request_digest}` or null. */
    async runByKey(context, key) {
      return member(context, async client => (await client.query(
        'select run_id, request_digest from benchmark_run where idempotency_key = $1', [key],
      )).rows[0] ?? null);
    },

    /**
     * Pin a run and queue one attempt per case, in one transaction: the package bytes, each case as the benchmark published it (its prompt,
     * fixtures' digest and files, arguments) and the case set's private references are in rows before any attempt is claimable. `request` is
     * the validated run request, `resolved` what it resolved to (`resolve` in benchmark/plan.js: its cases and limits) and `benchmark` the
     * benchmark it was resolved against; `session` marks a Terminal session, never a benchmark result, and `interactive` one whose member
     * works at its terminal; `free` a free-form Terminal session, with no package, task or case and one attempt of none. A session's one
     * attempt is `attempt_id` in the answer. One session someone is at runs per member, and nothing ends it but its member: an `interactive`
     * one while another runs is refused (`session_running`; the route joins a free-form start to the live one before it gets here). A
     * concurrent submission under the same key gets the first one's run: `{run_id, replayed}`.
     */
    async createRun(context, request, resolved, benchmark, {session = false, interactive = false, free = false, resumedFrom = null, startCli = null, resumeChat = null} = {}) {
      const {cases, limits} = resolved;
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
        // One session someone is at per member (any plugin, any workspace), which only its member ends: a second never replaces it.
        if (interactive && await liveSessionOf(client, context.userId, {lock: true})) {
          throw new BenchmarkError(409, 'session_running', 'Another session of yours started at the same moment: start again to open this in it');
        }
        const runId = crypto.randomUUID();
        const inserted = (await client.query(
          `insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest,
             model, endpoint_label, limits,
             benchmark_id, benchmark_name, harness_name, case_set_id, case_set_digest, publisher,
             plugin_id, plugin_name, version, package_sha256, task_id, task, session, interactive, resumed_from, start_cli, resume_chat)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
           on conflict (workspace_id, user_id, idempotency_key) do nothing returning run_id`,
          [runId, context.workspaceId, context.userId, request.idempotency_key, request.request_digest,
            benchmark.model, benchmark.endpoint_profile, JSON.stringify(limits),
            benchmark.benchmark_id, benchmark.name, request.harness, benchmark.case_set_id, benchmark.case_set_digest, JSON.stringify(benchmark.publisher),
            benchmark.plugin.id, benchmark.plugin.name, benchmark.plugin.version, benchmark.plugin.sha256, benchmark.task_id, free ? null : stringifyJson(benchmark.task),
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
          await client.query(
            `insert into benchmark_run_case (run_id, case_id, position, kind, prompt, prompt_sha256, fixtures_sha256, fixtures_files, arguments, expected_error, content_digest)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [runId, c.case_id, c.position, c.kind, c.prompt, c.prompt_sha256, c.fixtures?.sha256 ?? null, c.fixtures ? JSON.stringify(c.fixtures.files) : null,
              stringifyJson(c.arguments), c.expected_error, c.content_digest],
          );
          await keepRunPrivate(client, runId, benchmark.case_set_id, c.case_id);
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

    /** The caller's own runs as run summaries, newest first; a Harness tab session is not a benchmark result, so it is not listed. */
    async listRuns(context, {limit, before, beforeId = null}) {
      await sweep();
      return member(context, async client => (await client.query(
        `select s.*, r.archived_at from benchmark_run_summary s join benchmark_run r on r.run_id = s.run_id
          where not r.session and ($1::timestamptz is null
            or date_trunc('milliseconds', s.created_at) < $1
            or ($3::uuid is not null and date_trunc('milliseconds', s.created_at) = $1 and s.run_id > $3))
          order by date_trunc('milliseconds', s.created_at) desc, s.run_id limit $2`, [before, limit, beforeId],
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
          `select a.*, c.kind, c.content_digest, c.prompt, c.prompt_sha256
             from benchmark_attempt a left join benchmark_run_case c on c.run_id = a.run_id and c.case_id = a.case_id
            where a.attempt_id = $1`, [attemptId],
        )).rows[0];
        return row ? {...attemptView(row), kind: row.kind, content_digest: row.content_digest, prompt: row.prompt, prompt_sha256: row.prompt_sha256} : null;
      });
    },
    /** Committed events after `after` (of the `sources` given, else of all), at most `limit`, and the attempt's seal: null for an attempt the caller cannot see. */
    async events(context, attemptId, after, limit, sources = null) {
      return member(context, async client => {
        const attempt = (await client.query('select sealed, final_cursor, next_cursor - 1 as high_water from benchmark_attempt where attempt_id = $1', [attemptId])).rows[0];
        if (!attempt) return null;
        // The page ends at `limit` events or once its data passes MAX_EVENT_PAGE_BYTES, whichever comes first (it always holds one).
        const rows = (await client.query(
          `select cursor, event_id, source, kind, sequence, occurred_ns, data, payload_sha256s, received_at from (
             select cursor, event_id, source, kind, sequence, occurred_ns::text as occurred_ns, data, payload_sha256s, received_at,
               sum(octet_length(data::text)) over (order by cursor) - octet_length(data::text) as before_bytes
               from benchmark_event where attempt_id = $1 and cursor > $2 and ($5::text[] is null or source = any($5)) order by cursor limit $3) page
            where before_bytes < $4 order by cursor`, [attemptId, after, limit, MAX_EVENT_PAGE_BYTES, sources],
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
             select *, sum(octet_length(attributes::text) + octet_length(name) + 512) over (order by order_ns nulls last, id) - octet_length(attributes::text) - octet_length(name) - 512 as before_bytes from (
               -- Counted before the limit (a window runs before it), so a read the limit cut says so.
               select span_id as id, kind, name, parent_id as parent, scope, status, start_ns::text, end_ns::text, start_ns as order_ns, provenance, target, attributes,
                   count(*) over () as fetched
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

    /** Archive run `runId` (`archived` true) or bring it back (false): `{archived}`. Archiving again keeps its first time. */
    async archive(context, runId, archived) {
      return ownRunWrite(context, runId, async client => {
        await client.query('update benchmark_run set archived_at = case when $2 then coalesce(archived_at, now()) end where run_id = $1', [runId, archived]);
        return {archived};
      });
    },

    /**
     * Cancel a run: its queued attempts end canceled at once, and a leased attempt is told at its
     * next renewal. `{canceled_attempts, signaled_attempts}`; canceling again changes nothing.
     */
    async cancel(context, runId) {
      return ownRunWrite(context, runId, async client => {
        // `no key update` leaves a worker error's retry (an attempt inserted under a key share of the run) free to insert while this holds
        // the run. The leased attempts come first: one that is being ended as a worker error holds its row, so this waits for its retry to be
        // queued and the queued update that follows cancels it.
        await client.query('select run_id from benchmark_run where run_id = $1 for no key update', [runId]);
        await client.query('update benchmark_run set canceled_at = coalesce(canceled_at, now()) where run_id = $1', [runId]);
        const leased = await client.query(
          "update benchmark_attempt set cancel_requested = true where run_id = $1 and state = 'leased'", [runId]);
        const queued = await client.query(
          `update benchmark_attempt set state = 'final', execution_status = 'canceled', finalized_at = now(), sealed = true,
             final_cursor = next_cursor - 1 where run_id = $1 and state = 'queued'`, [runId]);
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
     * The caller's own Harness tab sessions (runs with `session`; with `attemptId`, any attempt of theirs, a benchmark case's too, which runs the same
     * path and keeps the same terminal output, chats and files), newest first, each attempt with its model calls (the gateway's
     * spans), the processes the process record shows (with `atCalls`, only those running when one of its model calls started, or all
     * of them when it made none: what names its agents, or its main command), and each call's settled cost (null while it is not): of
     * plugin `pluginId`, or only attempt `attemptId`.
     */
    async terminalRows(context, {pluginId = null, attemptId = null, atCalls = false}) {
      await sweep();
      return member(context, async client => (await client.query(
        `select a.attempt_id, a.state, a.finalized_at, a.resumable, a.chats, r.resumed_from, r.archived_chats, r.harness_name, r.task_id, r.created_at,
           coalesce((select json_agg(json_build_object('call_id', s.attributes->>'call_id', 'status', s.status, 'client', s.attributes->>'client', 'run', s.attributes->>'run',
               'prompt', s.attributes->>'prompt', 'start_ns', s.start_ns::text, 'end_ns', s.end_ns::text, 'usage', s.attributes->'usage') order by s.start_ns)
              from benchmark_span s where s.attempt_id = a.attempt_id and s.kind = 'model_call'), '[]') as calls,
           coalesce((select json_agg(json_build_object('span_id', s.span_id, 'parent_id', s.parent_id, 'argv', s.attributes->'argv',
               'cwd', s.attributes->>'cwd', 'title', s.attributes->>'title', 'verdict', s.attributes->>'verdict', 'run', s.attributes->>'run', 'start_ns', s.start_ns::text,
               'end_ns', s.end_ns::text) order by s.start_ns nulls first)
              from benchmark_span s where s.attempt_id = a.attempt_id and s.kind = 'process'
               and (not $3::boolean or not exists (select 1 from benchmark_span c where c.attempt_id = a.attempt_id and c.kind = 'model_call')
                 or exists (select 1 from benchmark_span c where c.attempt_id = a.attempt_id and c.kind = 'model_call'
                   and s.start_ns <= c.start_ns and (s.end_ns is null or s.end_ns >= c.start_ns)))), '[]') as processes,
           coalesce((select jsonb_object_agg(d.call_id, d.cost_usd::float8) from benchmark_admission d
              where d.attempt_id = a.attempt_id and d.status = 'settled'), '{}') as costs
           from benchmark_run r join benchmark_attempt a on a.run_id = r.run_id
          where r.user_id = $4 and (r.session or $2::uuid is not null) and ($1::text is null or r.plugin_id = $1) and ($2::uuid is null or a.attempt_id = $2)
          order by r.created_at desc, a.attempt_no desc`, [pluginId, attemptId, atCalls, context.userId],
      )).rows);
    },
    /** The member's session someone is at that still runs, on any plugin: `{run_id, attempt_id, free}`, or null (liveSessionOf). */
    async liveSession(context) {
      await sweep();
      return member(context, client => liveSessionOf(client, context.userId));
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
  });
}

module.exports = {createPostgresBenchmark};
