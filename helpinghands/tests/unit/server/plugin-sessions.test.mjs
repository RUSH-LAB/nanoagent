import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {migratedDatabase, as} from './fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresSessions, CHAT_TURNS} = require('../../../src/server/postgres/sessions.js');
const {createPostgresTenancy} = require('../../../src/server/postgres/tenancy.js');

describe('plugin sessions over PostgreSQL', () => {
  let db;
  let sessions;
  let tenancy;

  before(async () => {
    let pool;
    ({db, pool} = await migratedDatabase());
    tenancy = createPostgresTenancy({pool});
    sessions = createPostgresSessions({pool});
  });
  after(async () => db?.close());

  it('starts a session and keeps the latest turns of its conversation', async () => {
    const started = await sessions.create(as('alice'), 'arxiv-source');
    assert.equal(started.title, '');
    assert.deepEqual(started.chat, []);
    for (let turn = 0; turn < CHAT_TURNS + 2; turn += 1) {
      await sessions.addTurn(as('alice'), 'arxiv-source', started.id, {prompt: `paper ${turn}\nplease`, answer: `ok ${turn}`, tools: [{name: 'download_source', arguments: {turn}, output: '{}', isError: false}]});
    }
    const read = await sessions.get(as('alice'), 'arxiv-source', started.id);
    assert.equal(read.chat.length, CHAT_TURNS);
    assert.equal(read.chat.at(-1).answer, `ok ${CHAT_TURNS + 1}`);
    assert.deepEqual(read.chat.at(-1).tools, [{name: 'download_source', arguments: {turn: CHAT_TURNS + 1}, output: '{}', isError: false}]);
    // Named for its first question.
    assert.equal(read.title, 'paper 0');
  });

  it('keeps each session to its own member and plugin', async () => {
    const mine = await sessions.create(as('alice'), 'echo');
    await assert.rejects(sessions.get(as('bob'), 'echo', mine.id), error => error.status === 404);
    await assert.rejects(sessions.assertOwned(as('alice'), 'arxiv-source', mine.id), error => error.status === 404);
    await assert.rejects(sessions.addTurn(as('alice', 'other'), 'echo', mine.id, {prompt: 'p', answer: 'a', tools: []}), error => error.status === 404);
    assert.deepEqual((await sessions.list(as('bob'), 'echo')), []);
  });

  it('lists every call a session made, with what it cost and how long it took', async () => {
    const started = await sessions.create(as('alice'), 'bibtex-check');
    // A single-task run, as Mochi recorded them before NanoAgent 0.4.0.
    await db.query(
      `insert into ai_usage(workspace_id, user_id, kind, model, cost_usd, input_tokens, output_tokens, estimated,
                            plugin_id, session_id, task, ttft_s, generation_s, duration_s)
       values ('lab', 'alice', 'task', 'm', 0.012, 120, 30, false, 'bibtex-check', $1, 'check-bibtex', 1.5, 4, 9)`,
      [started.id],
    );
    await tenancy.recordAiUsage(as('alice'), {
      kind: 'app', model: 'm', cost: 0.1, estimated: true, pluginId: 'bibtex-check', sessionId: started.id,
    });
    const read = await sessions.get(as('alice'), 'bibtex-check', started.id);
    assert.deepEqual(read.calls.map(({at: _, ...call}) => call), [
      {kind: 'task', task: 'check-bibtex', model: 'm', cost: 0.012, estimated: false, inputTokens: 120, outputTokens: 30, ttftS: 1.5, generationS: 4, durationS: 9},
      {kind: 'app', task: null, model: 'm', cost: 0.1, estimated: true, inputTokens: null, outputTokens: null, ttftS: null, generationS: null, durationS: null},
    ]);
    const [listed] = (await sessions.list(as('alice'), 'bibtex-check'));
    assert.equal(listed.runs, 2);
    assert.equal(listed.cost, 0.112);
    assert.equal(listed.ttftS, 1.5);
  });

  it('archives a session until it is restored or chatted in again', async () => {
    const started = await sessions.create(as('alice'), 'nasdaq-drawdown');
    assert.equal(started.archivedAt, null);
    const archived = await sessions.archive(as('alice'), 'nasdaq-drawdown', started.id, true);
    assert.ok(archived.archivedAt);
    // Archiving again keeps when it was first archived.
    assert.deepEqual((await sessions.archive(as('alice'), 'nasdaq-drawdown', started.id, true)).archivedAt, archived.archivedAt);
    assert.deepEqual((await sessions.list(as('alice'), 'nasdaq-drawdown')).map(one => one.archivedAt), [archived.archivedAt]);
    assert.equal((await sessions.archive(as('alice'), 'nasdaq-drawdown', started.id, false)).archivedAt, null);
    await sessions.archive(as('alice'), 'nasdaq-drawdown', started.id, true);
    await sessions.addTurn(as('alice'), 'nasdaq-drawdown', started.id, {prompt: 'again', answer: 'ok', tools: []});
    assert.equal((await sessions.get(as('alice'), 'nasdaq-drawdown', started.id)).archivedAt, null);
    await assert.rejects(sessions.archive(as('bob'), 'nasdaq-drawdown', started.id, true), error => error.status === 404);
  });
});
