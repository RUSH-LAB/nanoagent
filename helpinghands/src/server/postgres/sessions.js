'use strict';
const crypto = require('crypto');
const {withRequestContext} = require('./client');
const {appendTurn, latestTurns} = require('../fs/chats');

// How many of a session's latest turns its page is given (as many as a prompt
// sends NanoAgent, routes/ai.js); its chat file keeps every one.
const CHAT_TURNS = 12;
const TURN_MAX = 10000;
// The most of each thought, and of each task's thinking and writing, a turn keeps.
const ACTIVITY_MAX = 50000;

class SessionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
  }
}

/**
 * Plugin sessions (migration 0015): one member's sittings with one plugin's
 * page, each with the conversation so far, kept as a chat folder in the
 * member's home (fs/chats.js, migration 0046), and the calls they made, from
 * ai_usage, with what each cost and how long it took. A session the member
 * archived (migration 0025) is listed as archived until they restore it or
 * chat in it again. A session answers one message at a time, its run kept
 * (migration 0028) from its message until its turn, answered or not, is in the
 * chat (app-runs.js).
 * Row-level security keeps every session to its own member and workspace.
 */
function createPostgresSessions({pool, fs}) {
  const run = (context, operation) => withRequestContext(pool, context, operation);
  // In one transaction with the file system, as `client` for the session tables and `tree` for its chat.
  const withChat = (context, operation) => fs.transaction(context, tree => operation({query: tree.query}, tree));
  const session = row => ({
    id: row.id,
    pluginId: row.plugin_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    runs: row.runs,
    cost: Number(row.cost),
    ttftS: row.ttft_s == null ? null : Number(row.ttft_s),
    running: row.running,
  });
  const SUMMARY = `s.id, s.plugin_id, s.title, s.created_at, s.updated_at, s.archived_at,
    count(u.id)::int as runs, coalesce(sum(u.cost_usd), 0) as cost, avg(u.ttft_s) as ttft_s,
    exists(select 1 from plugin_run r where r.session_id = s.id) as running
    from plugin_session s left join ai_usage u on u.session_id = s.id`;
  const pluginRun = row => ({
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    sessionId: row.session_id,
    pluginId: row.plugin_id,
    prompt: row.prompt,
    install: row.install,
    folder: row.folder,
    sent: row.sent,
    ran: row.ran,
    startedAt: row.started_at,
  });

  async function owned(client, pluginId, id) {
    const row = (await client.query(
      `select ${SUMMARY} where s.id = $1 and s.plugin_id = $2 group by s.id`, [id, pluginId],
    )).rows[0];
    if (!row) throw new SessionError(404, `No session ${id} for ${pluginId}`);
    return row;
  }

  return Object.freeze({
    /** The caller's sessions with `pluginId`, the latest first. */
    async list(context, pluginId) {
      return run(context, async client => (await client.query(
        `select ${SUMMARY} where s.plugin_id = $1 group by s.id order by s.updated_at desc`, [pluginId],
      )).rows.map(session));
    },

    async create(context, pluginId) {
      return run(context, async client => {
        const id = crypto.randomUUID();
        await client.query(
          'insert into plugin_session(id, workspace_id, user_id, plugin_id) values ($1, $2, $3, $4)',
          [id, context.workspaceId, context.userId, pluginId],
        );
        return {...session(await owned(client, pluginId, id)), chat: [], running: null};
      });
    },

    /** One session with its conversation, the message it is still answering, `{prompt}` or null, and every call it made. */
    async get(context, pluginId, id) {
      return withChat(context, async (client, tree) => {
        const summary = session(await owned(client, pluginId, id));
        const {chat_file: chatFile} = (await client.query('select chat_file from plugin_session where id = $1', [id])).rows[0];
        const chat = await latestTurns(tree, chatFile, CHAT_TURNS);
        const going = (await client.query('select prompt from plugin_run where session_id = $1', [id])).rows[0];
        const calls = (await client.query(
          `select at, kind, task, model, cost_usd, estimated, input_tokens, output_tokens, ttft_s, generation_s, duration_s
             from ai_usage where session_id = $1 order by at`, [id],
        )).rows;
        return {
          ...summary,
          chat,
          running: going ? {prompt: going.prompt} : null,
          calls: calls.map(row => ({
            at: row.at,
            kind: row.kind,
            task: row.task,
            model: row.model,
            cost: Number(row.cost_usd),
            estimated: row.estimated,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            ttftS: row.ttft_s,
            generationS: row.generation_s,
            durationS: row.duration_s,
          })),
        };
      });
    },

    /** Archive the caller's session `id` with `pluginId`, or with `archived` false restore it. */
    async archive(context, pluginId, id, archived) {
      return run(context, async client => {
        await owned(client, pluginId, id);
        await client.query(
          `update plugin_session set archived_at = case when $2 then coalesce(archived_at, now()) end where id = $1`,
          [id, archived],
        );
        return session(await owned(client, pluginId, id));
      });
    },

    /** Throws unless `id` is the caller's session with `pluginId`. */
    async assertOwned(context, pluginId, id) {
      await run(context, client => owned(client, pluginId, id));
    },

    /**
     * Start the run `id` of the caller's session `id` with `pluginId`, its message
     * `prompt`, on the install `install`; refuses a session already answering one.
     */
    async startRun(context, pluginId, sessionId, {id, prompt, install}) {
      return run(context, async client => {
        await owned(client, pluginId, sessionId);
        try {
          await client.query(
            `insert into plugin_run(id, workspace_id, user_id, session_id, plugin_id, prompt, install)
               values ($1, $2, $3, $4, $5, $6, $7)`,
            [id, context.workspaceId, context.userId, sessionId, pluginId, prompt, install],
          );
        } catch (error) {
          if (error.code === '23505') throw new SessionError(409, 'This session is still answering a message');
          throw error;
        }
      });
    },

    /** Keep where the run `id` works on the member's computer: its `folder`, and the revisions `sent` into it. */
    async setRunFolder(context, id, {folder, sent}) {
      await run(context, client => client.query(
        'update plugin_run set folder = $2, sent = $3::jsonb where id = $1', [id, folder, JSON.stringify(sent)],
      ));
    },

    /** Note that the run `id` got far enough to cost something. */
    async markRunRan(context, id) {
      await run(context, client => client.query('update plugin_run set ran = true where id = $1', [id]));
    },

    /** The caller's runs going on, in every workspace. */
    async runs(context) {
      return run(context, async client => (await client.query(
        'select * from plugin_run where user_id = $1 order by started_at', [context.userId],
      )).rows.map(pluginRun));
    },

    /**
     * End the run `runId`: its `turn` (`{prompt, answer, tools, activity, graph,
     * trajectory, error}`, `error` null when it was answered) joins its
     * session's chat file, with the upload version it ran on (null for
     * NanoAgent's own), and an archived session is restored: the turn kept, as
     * the page shows it, or false when it had ended already.
     */
    async endRun(context, runId, turn) {
      return withChat(context, async (client, tree) => {
        const ended = (await client.query(
          'delete from plugin_run where id = $1 returning session_id, plugin_id, install', [runId],
        )).rows[0];
        if (!ended) return false;
        const id = ended.session_id;
        const version = (await client.query(
          'select version from market_plugin_version where plugin_id = $1 and sha256 = $2', [ended.plugin_id, ended.install],
        )).rows[0]?.version ?? null;
        const stored = (await client.query(
          'select title, chat_file, created_at from plugin_session where id = $1 for update', [id],
        )).rows[0];
        const kept = {
          prompt: turn.prompt.slice(0, TURN_MAX),
          answer: turn.answer.slice(0, TURN_MAX),
          tools: turn.tools,
          activity: turn.activity.map(entry => (entry.kind === 'thought'
            ? {kind: 'thought', text: entry.text.slice(0, ACTIVITY_MAX)}
            : {...entry, thinking: entry.thinking.slice(0, ACTIVITY_MAX), text: entry.text.slice(0, ACTIVITY_MAX)})),
          error: turn.error === null ? null : turn.error.slice(0, TURN_MAX),
          version,
        };
        // An untitled session is named for its first question.
        const title = stored.title || turn.prompt.split('\n')[0].slice(0, 80);
        const chatFile = await appendTurn(tree, {
          chatFile: stored.chat_file, userId: context.userId, pluginId: ended.plugin_id, sessionId: id, title, at: stored.created_at,
        }, kept, {graph: turn.graph, trajectory: turn.trajectory});
        await client.query(
          'update plugin_session set chat_file = $2, updated_at = now(), archived_at = null, title = $3 where id = $1',
          [id, chatFile, title],
        );
        return {...kept, graph: turn.graph};
      });
    },
  });
}

module.exports = {createPostgresSessions, SessionError, CHAT_TURNS};
