'use strict';
const crypto = require('crypto');
const {withRequestContext} = require('./client');

// What one session may keep: the page's saved state, and the latest turns of
// its conversation (as many as a prompt sends NanoAgent, routes/ai.js).
const STATE_MAX_BYTES = 256 * 1024;
const TITLE_MAX = 200;
const CHAT_TURNS = 12;
const TURN_MAX = 10000;

class SessionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
  }
}

/**
 * Plugin sessions (migration 0015): one member's sittings with one plugin's
 * page, each with what the page saved and the conversation so far, and the
 * calls they made, from ai_usage, with what each cost and how long it took.
 * Row-level security keeps every session to its own member and workspace.
 */
function createPostgresSessions({pool}) {
  const run = (context, operation) => withRequestContext(pool, context, operation);
  const session = row => ({
    id: row.id,
    pluginId: row.plugin_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runs: row.runs,
    cost: Number(row.cost),
    ttftS: row.ttft_s == null ? null : Number(row.ttft_s),
  });
  const SUMMARY = `s.id, s.plugin_id, s.title, s.created_at, s.updated_at,
    count(u.id)::int as runs, coalesce(sum(u.cost_usd), 0) as cost, avg(u.ttft_s) as ttft_s
    from plugin_session s left join ai_usage u on u.session_id = s.id`;

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
        return {...session(await owned(client, pluginId, id)), state: null, chat: []};
      });
    },

    /** One session with its saved state, its conversation, and every call it made. */
    async get(context, pluginId, id) {
      return run(context, async client => {
        const summary = session(await owned(client, pluginId, id));
        const {state, chat} = (await client.query('select state, chat from plugin_session where id = $1', [id])).rows[0];
        const calls = (await client.query(
          `select at, kind, task, model, cost_usd, estimated, input_tokens, output_tokens, ttft_s, generation_s, duration_s
             from ai_usage where session_id = $1 order by at`, [id],
        )).rows;
        return {
          ...summary,
          state,
          chat,
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

    /** Throws unless `id` is the caller's session with `pluginId`. */
    async assertOwned(context, pluginId, id) {
      await run(context, client => owned(client, pluginId, id));
    },

    /** Keep what the page saved, and its title when it gives one. */
    async save(context, pluginId, id, {state, title}) {
      const json = JSON.stringify(state ?? null);
      if (Buffer.byteLength(json) > STATE_MAX_BYTES) {
        throw new SessionError(413, `A session's state may hold ${STATE_MAX_BYTES / 1024} KB`);
      }
      if (title !== undefined && (typeof title !== 'string' || title.length > TITLE_MAX)) {
        throw new SessionError(400, `title must be a string of ${TITLE_MAX} characters or fewer`);
      }
      await run(context, async client => {
        await owned(client, pluginId, id);
        await client.query(
          'update plugin_session set state = $2::jsonb, title = coalesce($3, title), updated_at = now() where id = $1',
          [id, json, title ?? null],
        );
      });
    },

    /** Add a finished turn to the conversation, its tool calls whole, keeping the latest. */
    async addTurn(context, pluginId, id, {prompt, answer, tools}) {
      await run(context, async client => {
        await owned(client, pluginId, id);
        const {chat} = (await client.query('select chat from plugin_session where id = $1 for update', [id])).rows[0];
        const turns = [...chat, {prompt: prompt.slice(0, TURN_MAX), answer: answer.slice(0, TURN_MAX), tools}].slice(-CHAT_TURNS);
        // An untitled session is named for its first question.
        await client.query(
          `update plugin_session set chat = $2::jsonb, updated_at = now(),
             title = case when title = '' then $3 else title end where id = $1`,
          [id, JSON.stringify(turns), prompt.split('\n')[0].slice(0, 80)],
        );
      });
    },
  });
}

module.exports = {createPostgresSessions, SessionError, STATE_MAX_BYTES, CHAT_TURNS};
