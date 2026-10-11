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

  it('starts a session, saves its state, and keeps the latest turns of its conversation', async () => {
    const started = await sessions.create(as('alice'), 'chess-move');
    assert.equal(started.title, '');
    await sessions.save(as('alice'), 'chess-move', started.id, {state: {fen: 'start'}});
    for (let turn = 0; turn < CHAT_TURNS + 2; turn += 1) {
      await sessions.addTurn(as('alice'), 'chess-move', started.id, {prompt: `move ${turn}\nplease`, answer: `ok ${turn}`});
    }
    const read = await sessions.get(as('alice'), 'chess-move', started.id);
    assert.deepEqual(read.state, {fen: 'start'});
    assert.equal(read.chat.length, CHAT_TURNS);
    assert.equal(read.chat.at(-1).answer, `ok ${CHAT_TURNS + 1}`);
    // Named for its first question.
    assert.equal(read.title, 'move 0');
    await sessions.save(as('alice'), 'chess-move', started.id, {state: null, title: 'Opening'});
    assert.equal((await sessions.get(as('alice'), 'chess-move', started.id)).title, 'Opening');
  });

  it('keeps each session to its own member and plugin', async () => {
    const mine = await sessions.create(as('alice'), 'echo');
    await assert.rejects(sessions.get(as('bob'), 'echo', mine.id), error => error.status === 404);
    await assert.rejects(sessions.assertOwned(as('alice'), 'chess-move', mine.id), error => error.status === 404);
    await assert.rejects(sessions.save(as('alice', 'other'), 'echo', mine.id, {state: 1}), error => error.status === 404);
    assert.deepEqual((await sessions.list(as('bob'), 'echo')), []);
  });

  it('refuses state over the limit', async () => {
    const started = await sessions.create(as('alice'), 'echo');
    await assert.rejects(
      sessions.save(as('alice'), 'echo', started.id, {state: 'x'.repeat(300 * 1024)}),
      error => error.status === 413,
    );
  });

  it('lists every call a session made, with what it cost and how long it took', async () => {
    const started = await sessions.create(as('alice'), 'bibtex-check');
    await tenancy.recordAiUsage(as('alice'), {
      kind: 'task', model: 'm', cost: 0.012, usage: {prompt_tokens: 120, completion_tokens: 30},
      metrics: {ttft_s: 1.5, generation_s: 4, duration_s: 9}, pluginId: 'bibtex-check', sessionId: started.id, task: 'check-bibtex',
    });
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
});
