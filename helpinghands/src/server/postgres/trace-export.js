'use strict';
const {inTransaction} = require('./benchmark-context');
const {sweepExpired} = require('./benchmark-sweep');
const {allTurns} = require('../fs/chats');
const {chatLine, runLine} = require('../benchmark/export');

// Who may read a run: its member, while still in its workspace, or a platform administrator (the same rule plugin_session_export keeps).
const READABLE = `(exists (select 1 from platform_admin pa where pa.user_id = request_user_id())
  or (r.user_id = request_user_id() and is_workspace_member(r.workspace_id)))`;

/**
 * What the trace export reads (routes/trace-export.js): the runs and chats it lists, oldest first, each read whole into its line
 * (benchmark/export.js). Runs are read as the system with the caller's id, so a platform administrator reads any member's, and a member
 * only their own (READABLE); chats are listed by plugin_session_export, which keeps the same rule, and each one's turns read as its member.
 */
function createPostgresTraceExport({pool, fs}) {
  const asCaller = (callerId, operation) => inTransaction(pool, {userId: callerId, system: true}, operation);

  async function runLineOf(client, runId) {
    const run = (await client.query(
      `select r.*, u.display_name as user_name, u.github_login as user_github from benchmark_run r join app_user u on u.id = r.user_id
        where r.run_id = $1 and ${READABLE}`, [runId],
    )).rows[0];
    if (!run) throw new Error(`Run ${runId} is gone, or no longer yours to read`);
    const caseIds = (await client.query('select case_id from benchmark_run_case where run_id = $1 order by position', [runId])).rows.map(row => row.case_id);
    const attempts = (await client.query('select * from benchmark_attempt where run_id = $1 order by created_at, attempt_no', [runId])).rows;
    const recorded = [];
    for (const row of attempts) recorded.push({row, recorded: await attemptRecord(client, row.attempt_id, row.workspace?.chunks ?? [])});
    return runLine(run, recorded, caseIds);
  }

  /** What attempt `attemptId` recorded: its payloads but the `workspace` chunks of its uploaded files, which the export links instead. */
  async function attemptRecord(client, attemptId, workspace) {
    const rows = async (sql) => (await client.query(sql, [attemptId])).rows;
    const events = (await rows(
      `select cursor, event_id, source, kind, sequence, occurred_ns::text as occurred_ns, data, payload_sha256s, received_at
         from benchmark_event where attempt_id = $1 order by cursor`,
    )).map(event => ({...event, cursor: Number(event.cursor), sequence: Number(event.sequence)}));
    const payloads = new Map((await client.query(
      'select sha256, redaction, data from benchmark_payload where attempt_id = $1 and sha256 <> all($2::text[])', [attemptId, workspace],
    )).rows.map(row => [row.sha256, row]));
    const spans = await rows(
      `select span_id as id, kind, name, parent_id as parent, scope, status, start_ns::text, end_ns::text, provenance, target, attributes
         from benchmark_span where attempt_id = $1 order by start_ns nulls last, span_id`,
    );
    const links = await rows('select kind, from_id as "from", to_id as "to", method, attributes from benchmark_link where attempt_id = $1 order by kind, from_id, to_id');
    const accounting = await rows(
      `select d.call_id, d.status, d.reserve_usd::float8 as reserve_usd, d.cost_usd::float8 as cost_usd, d.provenance, d.created_at, d.settled_at, a.version, a.record
         from benchmark_admission d left join lateral (select version, record from benchmark_accounting x
           where x.attempt_id = d.attempt_id and x.call_id = d.call_id order by version desc limit 1) a on true
        where d.attempt_id = $1 order by d.created_at, d.call_id`,
    );
    const terminals = await rows(
      `select terminal, string_agg(data, ''::bytea order by byte_offset) as data from benchmark_terminal
        where attempt_id = $1 group by terminal order by terminal`,
    );
    return {events, payloads, spans, links, accounting, terminals};
  }

  return Object.freeze({
    /** The ids of the runs caller `callerId` may read that match: of `member` (null: every member), `plugin`, created in [since, until). */
    async runIds(callerId, {member, plugin, since, until}) {
      await inTransaction(pool, {system: true}, sweepExpired);
      return asCaller(callerId, async client => (await client.query(
        `select r.run_id from benchmark_run r
          where ($1::text is null or r.user_id = $1) and ($2::text is null or r.plugin_id = $2)
            and ($3::timestamptz is null or r.created_at >= $3) and ($4::timestamptz is null or r.created_at < $4) and ${READABLE}
          order by r.created_at, r.run_id`, [member, plugin, since, until],
      )).rows.map(row => row.run_id));
    },
    /** Run `runId`'s line, read whole in one transaction. */
    async runLine(callerId, runId) {
      return asCaller(callerId, client => runLineOf(client, runId));
    },
    /**
     * Attempt `attemptId`'s uploaded files, if caller `callerId` may read its run: `{workspace, member}`, its `workspace` (`{sha256,
     * bytes, chunks}`) and whose it is; else null.
     */
    async workspace(callerId, attemptId) {
      return asCaller(callerId, async client => (await client.query(
        `select a.workspace, r.user_id as member from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id
          where a.attempt_id = $1 and a.workspace ? 'chunks' and ${READABLE}`, [attemptId],
      )).rows[0] ?? null);
    },
    /** One chunk of attempt `attemptId`'s uploaded files, read as `workspace` reads them. */
    async workspaceChunk(callerId, attemptId, sha256) {
      return asCaller(callerId, async client => (await client.query(
        `select p.data from benchmark_payload p join benchmark_attempt a on a.attempt_id = p.attempt_id join benchmark_run r on r.run_id = a.run_id
          where p.attempt_id = $1 and p.sha256 = $2 and ${READABLE}`, [attemptId, sha256],
      )).rows[0].data);
    },
    /** The NanoAgent chats caller `callerId` may read that match, as runIds takes them. */
    async chats(callerId, {member, plugin, since, until}) {
      return inTransaction(pool, {userId: callerId}, async client => (await client.query(
        'select * from plugin_session_export($1, $2, $3, $4)', [member, plugin, since, until],
      )).rows);
    },
    /** A chat's line (a row of `chats`): its turns and calls, read as its member. */
    async chatLine(chat) {
      return fs.transaction({userId: chat.user_id, workspaceId: chat.workspace_id}, async tree => {
        const turns = await allTurns(tree, chat.chat_file);
        const calls = (await tree.query(
          `select at, kind, task, model, cost_usd::float8 as cost_usd, estimated, input_tokens, output_tokens, ttft_s, generation_s, duration_s, model_s, tools_s
             from ai_usage where session_id = $1 order by at`, [chat.id],
        )).rows;
        return chatLine(chat, turns, calls);
      });
    },
  });
}

module.exports = {createPostgresTraceExport};
