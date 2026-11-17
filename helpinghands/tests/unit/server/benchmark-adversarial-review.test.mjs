import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, test} from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createPostgresBenchmarkWorker} = require('../../../src/server/postgres/benchmark-worker.js');
const {createPostgresBenchmark} = require('../../../src/server/postgres/benchmark.js');
const limits = require('../../../src/server/benchmark/limits.js');
const {benchmarkPublication, accountingBody, admissionBody, eventsBody, fenceOf, finalizeBody, settleBody, spansBody} = require('../../../src/server/benchmark/validate.js');
const {pythonFormat, renderTaskTools} = require('../../../src/server/benchmark/prompt.js');

const config = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};
const HEX = 'a'.repeat(64);

/** A pool whose clients record every statement, answering `answers[prefix]` rows for a statement starting with that prefix. */
function recordingPool(answers = {}) {
  const statements = [];
  return {
    statements,
    async connect() {
      return {
        async query(sql, values) {
          const text = String(sql.text ?? sql).replace(/\s+/g, ' ').trim();
          statements.push({text, params: sql.values ?? values ?? []});
          const key = Object.keys(answers).find(prefix => text.startsWith(prefix));
          return key ? {rows: answers[key], rowCount: answers[key].length} : {rows: [], rowCount: 0};
        },
        release() {},
      };
    },
  };
}

const publication = (extra = {}) => ({
  name: 'amp', plugin_id: 'p', plugin_name: 'p', version: '1.0.0', package_sha256: HEX, task_id: 't',
  task: {kind: 'agent', description: 'd', instructions: 'i', input_schema: {}, output_schema: {}, tools: [], egress_hosts: []},
  context: '', cases: [{case_id: 'c0', kind: 'answer', arguments: {a: 1}}], private: {c0: null}, model: 'm', endpoint_profile: 'e', ...extra,
});
const withCases = (count, blob, extra = {}) => {
  const cases = [{case_id: 'c0', kind: 'answer', arguments: {a: 1}}];
  for (let i = 1; i < count; i += 1) cases.push({case_id: `c${i}`, kind: 'answer', arguments: {blob}});
  return publication({cases, private: Object.fromEntries(cases.map(c => [c.case_id, null])), ...extra});
};

describe('prompt amplification', () => {
  test('the renderer stops a template that repeats {arguments} past the prompt cap, 400 prompt_too_long', () => {
    assert.throws(() => pythonFormat('{arguments}'.repeat(9000), {arguments: 'x'.repeat(20_000)}), {status: 400, code: 'prompt_too_long'});
    assert.equal(pythonFormat('{a}{a}', {a: 'x'.repeat(1000)}).length, 2000);
  });

  test('a task tools prompt past the cap is refused too', () => {
    const task = {kind: 'agent', description: 'd'};
    assert.throws(() => renderTaskTools({pluginName: 'p', task, instructions: 'i', args: {blob: 'x'.repeat(1_100_000)}}), {code: 'prompt_too_long'});
  });

  test('a benchmark whose later case amplifies is refused at publish, not at preview', () => {
    const body = withCases(3, 'x'.repeat(20_000), {coding_template: '{arguments}'.repeat(Math.floor(99_000 / 11))});
    assert.throws(() => benchmarkPublication(body), {status: 400, code: 'prompt_too_long'});
  });

  test('every case renders at publish under both policies: a later case the task tools policy cannot hold is refused', () => {
    assert.throws(() => benchmarkPublication(withCases(2, 'x'.repeat(1_100_000))), {code: 'prompt_too_long'});
  });

  test('the rendered prompts of all cases are capped together, 400 prompts_too_long', () => {
    assert.throws(() => benchmarkPublication(withCases(80, 'x'.repeat(450_000))), {status: 400, code: 'prompts_too_long'});
    assert.equal(benchmarkPublication(withCases(3, 'x'.repeat(450_000))).cases.length, 3);
  });
});

describe('what the worker API stores is bounded', () => {
  const big = bytes => ({pad: 'x'.repeat(bytes)});
  const rejects = (call, status = 413) => assert.throws(call, error => error.status === status);
  const event = data => ({event_id: 'e', source: 's', kind: 'k', sequence: 1, occurred_ns: '1', data});

  test('finalize bounds metrics and coverage', () => {
    const body = {fence: 1, execution: {status: 'answered'}, coverage: {}, metrics: {}, final_cursor_expected: 0};
    assert.equal(finalizeBody({...body, metrics: {total_tokens: 1}}).final.metrics.total_tokens, 1);
    rejects(() => finalizeBody({...body, metrics: big(limits.MAX_RESULT_BYTES)}));
    rejects(() => finalizeBody({...body, coverage: big(limits.MAX_RESULT_BYTES)}));
  });

  test('an event\'s data, a span\'s and a link\'s attributes and an accounting record each have a byte cap', () => {
    eventsBody({fence: 1, events: [event(big(1000))]});
    rejects(() => eventsBody({fence: 1, events: [event(big(limits.MAX_EVENT_DATA_BYTES))]}));
    rejects(() => spansBody({fence: 1, spans: [{id: 's', kind: 'k', name: 'n', start_ns: '1', end_ns: '2', attributes: big(limits.MAX_SPAN_ATTRIBUTES_BYTES)}]}));
    rejects(() => spansBody({fence: 1, links: [{kind: 'k', from: 'a', to: 'b', attributes: big(limits.MAX_LINK_ATTRIBUTES_BYTES)}]}));
    rejects(() => accountingBody({call_id: 'c', version: 1, record: big(limits.MAX_ACCOUNTING_RECORD_BYTES)}));
  });

  test('accounting versions are capped', () => {
    assert.equal(accountingBody({call_id: 'c', version: limits.MAX_ACCOUNTING_VERSION, record: {}}).version, limits.MAX_ACCOUNTING_VERSION);
    rejects(() => accountingBody({call_id: 'c', version: limits.MAX_ACCOUNTING_VERSION + 1, record: {}}), 400);
  });

  test('an attempt refuses events past its count cap, 413 too_many_events', async () => {
    const pool = recordingPool({
      'select a.*, r.canceled_at': [{fence: 1, state: 'leased', execution_status: null, lease_expires_at: new Date(), next_cursor: limits.MAX_ATTEMPT_EVENTS}],
      'select $1::timestamptz < now()': [{expired: false}],
    });
    const worker = createPostgresBenchmarkWorker({pool, config});
    const make = n => ({event_id: `e${n}`, source: 's', kind: 'k', sequence: n, occurred_ns: '1', data: {}, payload_sha256s: []});
    await assert.rejects(worker.appendEvents('u', 'a', 1, [make(1), make(2)]), {status: 413, code: 'too_many_events'});
    assert.ok(!pool.statements.some(s => s.text.startsWith('insert into benchmark_event')));
  });

  test('an attempt refuses spans and links past their count caps, 413 too_many_spans', async () => {
    const answers = {
      'select a.*, r.canceled_at': [{fence: 1, state: 'leased', execution_status: null, lease_expires_at: new Date(), next_cursor: 1}],
      'select $1::timestamptz < now()': [{expired: false}],
    };
    const span = {id: 's', kind: 'k', name: 'n', parent: null, scope: null, status: null, start_ns: '1', end_ns: '2', provenance: null, target: null, attributes: {}};
    const link = {kind: 'k', from: 'a', to: 'b', method: null, attributes: {}};
    for (const [held, spans, links] of [[{spans: limits.MAX_ATTEMPT_SPANS, links: 0}, [span], []], [{spans: 0, links: limits.MAX_ATTEMPT_LINKS}, [], [link]]]) {
      const pool = recordingPool({...answers, 'select (select count(*) from benchmark_span': [held]});
      await assert.rejects(createPostgresBenchmarkWorker({pool, config}).putSpans('u', 'a', 1, spans, links), {status: 413, code: 'too_many_spans'});
    }
  });

  test('span and link attributes are checked after the merge too', async () => {
    const pool = recordingPool({
      'select a.*, r.canceled_at': [{fence: 1, state: 'leased', execution_status: null, lease_expires_at: new Date(), next_cursor: 1}],
      'select $1::timestamptz < now()': [{expired: false}],
      'select (select count(*) from benchmark_span': [{spans: 0, links: 0}],
      'select 1 from benchmark_span': [{'?column?': 1}],
    });
    await assert.rejects(createPostgresBenchmarkWorker({pool, config}).putSpans('u', 'a', 1, [], []), {status: 413, code: 'too_large'});
  });
});

describe('the events page and the links read are bounded', () => {
  test('the events query ends the page at a byte total and has_more follows the high-water cursor', async () => {
    const pool = recordingPool({
      'select sealed': [{sealed: false, final_cursor: null, high_water: 40}],
      'select cursor, event_id': [{cursor: '1', sequence: '1', data: {}}, {cursor: '2', sequence: '2', data: {}}],
    });
    const page = await createPostgresBenchmark({pool}).events({userId: 'u', workspaceId: 'w'}, 'a', 0, 1000);
    const query = pool.statements.find(s => s.text.startsWith('select cursor, event_id'));
    assert.match(query.text, /sum\(octet_length\(data::text\)\) over \(order by cursor\)/);
    assert.deepEqual(query.params.slice(-1), [limits.MAX_EVENT_PAGE_BYTES]);
    assert.deepEqual([page.events.length, page.has_more], [2, true]);
  });

  test('the spans read limits its links', async () => {
    const pool = recordingPool({'select 1 from benchmark_attempt': [{}]});
    await createPostgresBenchmark({pool}).spans({userId: 'u', workspaceId: 'w'}, 'a', {kind: null, status: null, q: null, limit: 10});
    const links = pool.statements.find(s => s.text.includes('from benchmark_link'));
    assert.match(links.text, /limit \$2$/);
    assert.deepEqual(links.params, ['a', limits.MAX_ATTEMPT_LINKS]);
  });

  test('a member keeps their newest previews: saving one prunes the rest', async () => {
    const pool = recordingPool();
    await createPostgresBenchmark({pool}).savePreview({userId: 'u', workspaceId: 'w'}, {cases: []}, 'd');
    assert.ok(pool.statements.some(s => s.text.startsWith('delete from benchmark_preview where user_id = $1') && /offset 50\)$/.test(s.text)));
  });
});

describe('settling and numeric ranges', () => {
  const settling = (reserve, cost) => createPostgresBenchmarkWorker({
    config, pool: recordingPool({
      'select a.attempt_id, r.user_id': [{attempt_id: 'a', user_id: 'u', workspace_id: 'w'}],
      'select status, reserve_usd': [{status: 'reserved', reserve, cost: null, day: '2026-01-01'}],
    }),
  }).settle('u', 'a', 'call', {outcome: 'settled', costUsd: cost, provenance: {}});

  test('a settlement past twice the call\'s reserve is refused, 400 cost_exceeds_reserve, and charges no budget', async () => {
    await assert.rejects(settling(0.5, 99_999_999_999), {status: 400, code: 'cost_exceeds_reserve'});
  });

  test('an honest settlement, at or under the reserve and a little over it, is accepted', async () => {
    assert.equal((await settling(0.5, 0.5)).status, 'settled');
    assert.equal((await settling(0.5, 0.7)).status, 'settled');
    assert.equal((await settling(0.5, 0)).status, 'settled');
  });

  test('usd amounts, fences, versions and nanoseconds are kept within their columns, 400', () => {
    for (const usd of [1e12, 1e11 + 1, -1, Infinity, '1']) {
      assert.throws(() => settleBody({outcome: 'settled', cost_usd: usd, provenance: {}}), {status: 400});
      assert.throws(() => admissionBody({fence: 1, call_id: 'c', reserve_usd: usd}), {status: 400});
    }
    assert.equal(settleBody({outcome: 'settled', cost_usd: 1.5, provenance: {}}).costUsd, 1.5);
    assert.throws(() => fenceOf({fence: 2 ** 31}), {status: 400});
    assert.equal(fenceOf({fence: 2 ** 31 - 1}), 2 ** 31 - 1);
    for (const occurred of ['9999999999999999999', '-9999999999999999999', '9223372036854775808']) {
      assert.throws(() => eventsBody({fence: 1, events: [{event_id: 'e', source: 's', kind: 'k', sequence: 1, occurred_ns: occurred, data: {}}]}), {status: 400});
    }
    assert.equal(eventsBody({fence: 1, events: [{event_id: 'e', source: 's', kind: 'k', sequence: 1, occurred_ns: '9223372036854775807', data: {}}]}).events[0].occurred_ns, '9223372036854775807');
  });
});

describe('migration 0056', () => {
  const sql = fs.readFileSync(new URL('../../../src/server/postgres/migrations/0056_benchmark_shared_case_set.sql', import.meta.url), 'utf8');

  test('lets a shared case set outlive its first publisher', () => {
    assert.match(sql, /alter column publisher_id drop not null/);
    assert.match(sql, /foreign key \(publisher_id\) references app_user\(id\) on delete set null/);
  });
});
