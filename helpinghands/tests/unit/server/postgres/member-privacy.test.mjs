/**
 * A member sees only their own work on a plugin page's Dashboard, even beside another member of the same workspace: alice and bob are
 * both in `lab`, and alice ran `rush aider` and chatted with nanoagent on plugin `p`. Every Dashboard read is the real repository's
 * SQL under the real row-level security, as bob and as alice.
 */
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {as, migratedDatabase, pgQuery} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresBenchmark} = require('../../../../src/server/postgres/benchmark.js');
const {createPostgresSessions} = require('../../../../src/server/postgres/sessions.js');
const {createPostgresTraceExport} = require('../../../../src/server/postgres/trace-export.js');
const {terminalChats, memberChats} = require('../../../../src/server/benchmark/terminal-sessions.js');

const RUN = '00000000-0000-4000-8000-0000000000a1';
const ATTEMPT = '00000000-0000-4000-8000-0000000000a2';
const SHA = createHash('sha256').update('x').digest('hex');
const S = 1_000_000_000n;
let db;
let repository;
let sessions;
let traces;

/** How the dashboard lists a member's Harness chats on plugin `p` (routes/benchmark.js terminal-sessions). */
const dashboardChats = async (user, options = {}) => memberChats((await repository.terminalRows(as(user), {pluginId: 'p', atCalls: true, ...options})).map(terminalChats));

describe('a plugin page\'s Dashboard, two members in one workspace', () => {
  before(async () => {
    const migrated = await migratedDatabase();
    db = migrated.db;
    // benchmark-context's `lossless` passes {text, values, types}; PGlite takes the text and values.
    const pool = {
      async connect() {
        const client = await migrated.pool.connect();
        const query = pgQuery(db);
        return {...client, query: (sql, values) => (typeof sql === 'string' ? query(sql, values) : query(sql.text, sql.values))};
      },
    };
    repository = createPostgresBenchmark({pool});
    sessions = createPostgresSessions({pool, fs: null});
    traces = createPostgresTraceExport({pool, fs: null});
    // Alice's Terminal session on plugin `p`: bash, and in it `rush aider`, which made a model call.
    await db.exec(`
      insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, model, endpoint_label,
          limits, benchmark_id, benchmark_name, harness_name, publisher, plugin_id, session, interactive)
        values ('${RUN}', 'lab', 'alice', 'k', '${SHA}', 'm', 'openrouter', '{}', '${RUN}', 'harness-session', 'shell', '{}', 'p', true, true);
      insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, execution_status, finalized_at, chats)
        values ('${ATTEMPT}', '${RUN}', null, 1, 'final', 'ended', now(), '[]');
      insert into benchmark_span (attempt_id, span_id, kind, name, parent_id, start_ns, end_ns, attributes) values
        ('${ATTEMPT}', 'p:1', 'process', 'bash', null, 0, null, '{"argv": ["bash", "--rcfile", "/harness/bashrc", "-i"], "cwd": "/rush/workspace"}'),
        ('${ATTEMPT}', 'p:2', 'process', 'rush', 'p:1', ${5n * S}, ${20n * S},
          '{"argv": ["python", "/harness/rush.py", "run", "aider"], "cwd": "/rush/workspace", "title": "list three ids"}'),
        ('${ATTEMPT}', 'c:1', 'model_call', 'call', null, ${8n * S}, ${9n * S}, '{"call_id": "c1", "usage": {"input": 100, "output": 10}}');
      insert into plugin_session (id, workspace_id, user_id, plugin_id, title) values ('s-alice', 'lab', 'alice', 'p', 'Sum');
    `);
  });

  after(async () => db?.close());

  it('shows alice her `rush aider` chip and row, and her nanoagent chat', async () => {
    const chats = await dashboardChats('alice');
    assert.deepEqual(chats.map(chat => [chat.agent, chat.title, chat.usage.inputTokens.sum]), [['aider', 'list three ids', 100]]);
    assert.deepEqual((await sessions.list(as('alice'), 'p')).map(session => session.id), ['s-alice']);
  });

  it('shows bob, in the same workspace, none of alice\'s chips, rows or totals, archived or not', async () => {
    assert.deepEqual(await dashboardChats('bob'), []);
    assert.deepEqual(await repository.terminalRows(as('bob'), {attemptId: ATTEMPT}), []);
    assert.deepEqual(await repository.terminalTranscripts(as('bob'), ATTEMPT), []);
    assert.equal(await repository.archiveChat(as('bob'), ATTEMPT, `aider:${ATTEMPT}/p:2`, true), false);
    assert.deepEqual(await sessions.list(as('bob'), 'p'), []);
    await assert.rejects(sessions.assertOwned(as('bob'), 'p', 's-alice'), /No session/);
  });

  it('exports bob none of alice\'s traces, and an administrator everyone\'s', async () => {
    assert.deepEqual(await traces.runIds('bob', {member: 'bob', plugin: 'p', since: null, until: null}), []);
    assert.deepEqual(await traces.runIds('bob', {member: null, plugin: 'p', since: null, until: null}), []);
    assert.deepEqual(await traces.chats('bob', {member: null, plugin: 'p', since: null, until: null}), []);
    assert.deepEqual(await traces.runIds('alice', {member: 'alice', plugin: 'p', since: null, until: null}), [RUN]);
    await db.exec("insert into platform_admin (user_id) values ('carol')");
    assert.deepEqual(await traces.runIds('carol', {member: null, plugin: 'p', since: null, until: null}), [RUN]);
    assert.deepEqual((await traces.chats('carol', {member: null, plugin: 'p', since: null, until: null})).map(chat => chat.id), ['s-alice']);
  });

  it('gives alice her running Terminal session, from any plugin, as the one every start joins, and bob none of it', async () => {
    assert.equal(await repository.liveSession(as('alice')), null);  // ended
    await db.exec(`update benchmark_attempt set state = 'leased', finalized_at = null where attempt_id = '${ATTEMPT}'`);
    assert.deepEqual(await repository.liveSession(as('alice')), {run_id: RUN, attempt_id: ATTEMPT, free: true});
    assert.equal(await repository.liveSession(as('bob')), null);
    await db.exec(`update benchmark_attempt set state = 'final', finalized_at = now() where attempt_id = '${ATTEMPT}'`);
  });
});
