import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import {migratedDatabase, as} from './fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresSessions, CHAT_TURNS} = require('../../../src/server/postgres/sessions.js');
const {createPostgresTenancy} = require('../../../src/server/postgres/tenancy.js');
const {createPostgresMarket} = require('../../../src/server/postgres/market.js');
const {createPostgresFs} = require('../../../src/server/fs/store.js');

describe('plugin sessions over PostgreSQL', () => {
  let db;
  let sessions;
  let tenancy;
  let market;
  let fs;

  before(async () => {
    let pool;
    ({db, pool} = await migratedDatabase());
    tenancy = createPostgresTenancy({pool});
    fs = createPostgresFs({pool});
    sessions = createPostgresSessions({pool, fs});
    market = createPostgresMarket({pool});
  });
  after(async () => db?.close());

  /** One message answered in the session: its run started and ended with `turn`. */
  async function answered(context, pluginId, sessionId, turn) {
    const id = crypto.randomUUID();
    await sessions.startRun(context, pluginId, sessionId, {id, prompt: turn.prompt, install: 'a'.repeat(64)});
    return sessions.endRun(context, id, {error: null, activity: [], ...turn});
  }

  it('starts a session and keeps the latest turns of its conversation', async () => {
    const started = await sessions.create(as('alice'), 'arxiv-source');
    assert.equal(started.title, '');
    assert.deepEqual(started.chat, []);
    for (let turn = 0; turn < CHAT_TURNS + 2; turn += 1) {
      await answered(as('alice'), 'arxiv-source', started.id, {prompt: `paper ${turn}\nplease`, answer: `ok ${turn}`, tools: [{name: 'download_source', arguments: {turn}, output: '{}', isError: false}]});
    }
    const read = await sessions.get(as('alice'), 'arxiv-source', started.id);
    assert.equal(read.chat.length, CHAT_TURNS);
    assert.equal(read.chat.at(-1).answer, `ok ${CHAT_TURNS + 1}`);
    assert.deepEqual(read.chat.at(-1).tools, [{name: 'download_source', arguments: {turn: CHAT_TURNS + 1}, output: '{}', isError: false}]);
    // Named for its first question.
    assert.equal(read.title, 'paper 0');
    // Its chat file keeps every turn.
    const day = new Date(started.createdAt).toISOString().slice(0, 10).replaceAll('-', '_');
    const file = await fs.read(as('alice'), `home/alice/plugins/arxiv-source/chats/${day}_paper_0/chat.json`);
    assert.equal(JSON.parse(file.body.toString()).turns.length, CHAT_TURNS + 2);
  });

  it('keeps a chat as a folder in its member\'s home, with each turn\'s graph and trajectory, following the folder', async () => {
    const started = await sessions.create(as('alice'), 'echo');
    const graph = {nodes: [{id: 'n'}], edges: []};
    const trajectory = {schema_version: 'ATIF-v1.8', session_id: 's', agent: {}, steps: [], final_metrics: {}};
    await answered(as('alice'), 'echo', started.id, {prompt: 'one/two', answer: 'a', tools: [], graph, trajectory});
    const day = new Date(started.createdAt).toISOString().slice(0, 10).replaceAll('-', '_');
    const folder = `home/alice/plugins/echo/chats/${day}_one_two`;
    assert.deepEqual(JSON.parse((await fs.read(as('alice'), `${folder}/turns/001/graph.json`)).body.toString()), graph);
    assert.deepEqual(JSON.parse((await fs.read(as('alice'), `${folder}/turns/001/messages.json`)).body.toString()), trajectory);
    assert.equal(await fs.stat(as('bob'), `${folder}/chat.json`), null);
    // The member renames the folder; the session follows it.
    await fs.move(as('alice'), folder, 'home/alice/plugins/echo/chats/kept');
    await answered(as('alice'), 'echo', started.id, {prompt: 'three', answer: 'b', tools: []});
    const read = await sessions.get(as('alice'), 'echo', started.id);
    assert.deepEqual(read.chat.map(turn => [turn.answer, turn.graph]), [['a', graph], ['b', null]]);
    // Deleting the chat file deletes the chat; the next turn starts another folder.
    await fs.remove(as('alice'), 'home/alice/plugins/echo/chats/kept/chat.json');
    assert.deepEqual((await sessions.get(as('alice'), 'echo', started.id)).chat, []);
    await answered(as('alice'), 'echo', started.id, {prompt: 'four', answer: 'c', tools: []});
    assert.ok(await fs.stat(as('alice'), `${folder}/chat.json`));
  });

  it('keeps what the agent did on the way to each answer, each thought and task cut to 50000 characters', async () => {
    const started = await sessions.create(as('alice'), 'arxiv-source');
    const long = 'x'.repeat(60000);
    await answered(as('alice'), 'arxiv-source', started.id, {prompt: 'find it', answer: 'found', tools: [], activity: [
      {kind: 'thought', text: long},
      {kind: 'task', name: 'search_papers', steps: [{name: 'fetch', isError: false}], thinking: long, text: 'done'},
    ]});
    const [turn] = (await sessions.get(as('alice'), 'arxiv-source', started.id)).chat;
    assert.deepEqual(turn.activity, [
      {kind: 'thought', text: 'x'.repeat(50000)},
      {kind: 'task', name: 'search_papers', steps: [{name: 'fetch', isError: false}], thinking: 'x'.repeat(50000), text: 'done'},
    ]);
  });

  it('keeps each session to its own member and plugin', async () => {
    const mine = await sessions.create(as('alice'), 'echo');
    await assert.rejects(sessions.get(as('bob'), 'echo', mine.id), error => error.status === 404);
    await assert.rejects(sessions.assertOwned(as('alice'), 'arxiv-source', mine.id), error => error.status === 404);
    await assert.rejects(answered(as('alice', 'other'), 'echo', mine.id, {prompt: 'p', answer: 'a', tools: []}), error => error.status === 404);
    assert.deepEqual((await sessions.list(as('bob'), 'echo')), []);
  });

  it('lists every call a session made, with what it cost and how long it took', async () => {
    const started = await sessions.create(as('alice'), 'bibtex-check');
    // A single-task run, as RUSH recorded them before NanoAgent 0.4.0.
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

  it('answers one message at a time, keeping the run until its turn, answered or not, is in the chat', async () => {
    const started = await sessions.create(as('alice'), 'bibtex-check');
    await sessions.startRun(as('alice'), 'bibtex-check', started.id, {id: 'run-a', prompt: 'check refs.bib', install: 'b'.repeat(64)});
    await assert.rejects(
      sessions.startRun(as('alice'), 'bibtex-check', started.id, {id: 'run-b', prompt: 'again', install: 'b'.repeat(64)}),
      error => error.status === 409 && error.message === 'This session is still answering a message',
    );
    assert.deepEqual((await sessions.get(as('alice'), 'bibtex-check', started.id)).running, {prompt: 'check refs.bib'});
    assert.equal((await sessions.list(as('alice'), 'bibtex-check'))[0].running, true);
    await sessions.setRunFolder(as('alice'), 'run-a', {folder: 'f1', sent: {'refs.bib': {rev: 2, contentHash: 'h'}}});
    await sessions.markRunRan(as('alice'), 'run-a');
    // Its member reads it from any workspace, as a RUSH started since does; nobody else does.
    const [run] = await sessions.runs({userId: 'alice', workspaceId: null});
    assert.deepEqual({...run, startedAt: undefined}, {
      id: 'run-a', workspaceId: 'lab', userId: 'alice', sessionId: started.id, pluginId: 'bibtex-check', prompt: 'check refs.bib',
      install: 'b'.repeat(64), folder: 'f1', sent: {'refs.bib': {rev: 2, contentHash: 'h'}}, ran: true, startedAt: undefined,
    });
    assert.deepEqual(await sessions.runs({userId: 'bob', workspaceId: null}), []);
    assert.equal(await sessions.endRun(as('bob'), 'run-a', {prompt: 'x', answer: '', tools: [], activity: [], error: 'x'}), false);
    assert.equal((await sessions.endRun(as('alice'), 'run-a', {prompt: 'check refs.bib', answer: '', tools: [], activity: [], error: 'RUSH Lab stopped while answering'})).error, 'RUSH Lab stopped while answering');
    assert.equal(await sessions.endRun(as('alice'), 'run-a', {prompt: 'check refs.bib', answer: '', tools: [], activity: [], error: 'twice'}), false);
    const read = await sessions.get(as('alice'), 'bibtex-check', started.id);
    assert.equal(read.running, null);
    assert.deepEqual(read.chat, [{prompt: 'check refs.bib', answer: '', tools: [], activity: [], error: 'RUSH Lab stopped while answering', version: null, graph: null}]);
  });

  it('keeps with each turn the upload version it ran on', async () => {
    const entry = {id: 'notes', name: 'Notes', version: '1.0.0', sha256: 'a'.repeat(64), size: 1};
    await market.publish('alice', entry, Buffer.from('x'), null);
    await market.publish('alice', {...entry, version: '1.1.0', sha256: 'e'.repeat(64)}, Buffer.from('y'), null);
    const started = await sessions.create(as('bob'), 'notes');
    // `answered` runs the install 'a'…: 1.0.0, though 1.1.0 is the latest.
    assert.equal((await answered(as('bob'), 'notes', started.id, {prompt: 'hi', answer: 'hello', tools: []})).version, '1.0.0');
    assert.equal((await sessions.get(as('bob'), 'notes', started.id)).chat[0].version, '1.0.0');
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
    await answered(as('alice'), 'nasdaq-drawdown', started.id, {prompt: 'again', answer: 'ok', tools: []});
    assert.equal((await sessions.get(as('alice'), 'nasdaq-drawdown', started.id)).archivedAt, null);
    await assert.rejects(sessions.archive(as('bob'), 'nasdaq-drawdown', started.id, true), error => error.status === 404);
  });
});
