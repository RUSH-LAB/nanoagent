import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, test} from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {compareRuns} = require('../../../src/server/benchmark/compare.js');
const {createPostgresBenchmarkWorker} = require('../../../src/server/postgres/benchmark-worker.js');
const {createPostgresBenchmark} = require('../../../src/server/postgres/benchmark.js');
const limits = require('../../../src/server/benchmark/limits.js');
const {accountingBody, eventsBody, finalizeBody, settleBody, spansBody, terminalBody, terminalLinkBody} = require('../../../src/server/benchmark/validate.js');

const config = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};

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
const storageAnswers = {'select coalesce(current_setting': [{prior: 'off'}], 'select (select coalesce(sum(octet_length(archive))': [{used: 0}]};

const runOf = (id, cases) => ({
  run_id: id, status: 'complete', created_at: null, benchmark: {benchmark_id: 'x'}, harness: {name: 'h'},
  case_set: {case_set_id: 'cs', name: 'n', digest: 'd', plugin: {sha256: 's'}, task_id: 't'},
  model: 'm', endpoint_profile: 'e', limits: limits.DEFAULT_LIMITS, egress_hosts: null, unverified_egress: false, score: {}, cases,
});
const caseOf = (n, prompt) => ({
  case_id: `c${n}`, position: n, kind: 'answer', content_digest: `d${n}`, attempts: [], latest_attempt_id: null, prompt, prompt_sha256: prompt,
});
const compare = (first, second) => {
  const runs = {a: first, b: second};
  return compareRuns({repository: {run: async (_, id) => runs[id], runCosts: async () => new Map()}, context: {}, a: 'a', b: 'b'});
};

describe('a comparison of runs with large differing prompts', () => {
  test('diffs 20,000 differing lines in well under a second, as one removed and one added part', async () => {
    const lines = text => Array.from({length: 20_000}, (_, n) => `${text}${n}`).join('\n');
    const started = Date.now();
    const result = await compare(runOf('a', [caseOf(0, lines('a'))].map(c => ({...c, content_digest: 'same'}))), runOf('b', [caseOf(0, lines('b'))].map(c => ({...c, content_digest: 'same'}))));
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(result.prompt_diff.rendered[0].text.map(part => part.type), ['removed', 'added']);
  });

  test('still diffs small prompts line by line', async () => {
    const same = c => ({...c, content_digest: 'same'});
    const result = await compare(runOf('a', [same(caseOf(0, 'one\ntwo'))]), runOf('b', [same(caseOf(0, 'one\nthree'))]));
    assert.deepEqual(result.prompt_diff.rendered[0].text.map(part => part.type), ['same', 'removed', 'added']);
  });

  test('diffs the prompts of only the first MAX_RENDERED_DIFFS shared cases line by line', async () => {
    const count = 60;
    const first = runOf('a', Array.from({length: count}, (_, n) => caseOf(n, `keep\nx${n}`)));
    const second = runOf('b', Array.from({length: count}, (_, n) => caseOf(n, `keep\ny${n}`)));
    const {rendered} = (await compare(first, second)).prompt_diff;
    const kinds = rendered.map(entry => entry.text.map(part => part.type).join());
    assert.equal(kinds.filter(kind => kind === 'same,removed,added').length, 50);
    assert.deepEqual(new Set(kinds.slice(50)), new Set(['removed,added']));
  });
});

describe('what the worker API stores is charged to the member', () => {
  const lease = {'select a.*, r.canceled_at': [{attempt_id: 'a', fence: 1, state: 'leased', lease_expires_at: new Date(Date.now() + 60_000), next_cursor: '1', user_id: 'u', workspace_id: 'w', limits: {}}],
    'select $1::timestamptz < now()': [{expired: false}], ...storageAnswers};
  const charged = pool => pool.statements.filter(s => s.text.startsWith('update benchmark_attempt set stored_bytes')).map(s => Number(s.params[1]));

  test('events: one charge per request, of their data bytes', async () => {
    const pool = recordingPool(lease);
    const events = [1, 2].map(n => ({event_id: `e${n}`, source: 's', kind: 'k', sequence: n, occurred_ns: '1', data: {pad: 'x'.repeat(100)}, payload_sha256s: []}));
    await createPostgresBenchmarkWorker({pool, config}).appendEvents('u', 'a', 1, events);
    assert.deepEqual(charged(pool), [2 * Buffer.byteLength(JSON.stringify({pad: 'x'.repeat(100)}))]);
  });

  test('spans and links: the attribute bytes', async () => {
    const pool = recordingPool({...lease, 'select (select count(*) from benchmark_span': [{spans: 0, links: 0}]});
    const attributes = {pad: 'x'.repeat(50)};
    await createPostgresBenchmarkWorker({pool, config}).putSpans('u', 'a', 1, [{id: 's', kind: 'k', name: 'n', attributes}], [{kind: 'k', from: 'a', to: 'b', attributes}]);
    assert.deepEqual(charged(pool), [2 * Buffer.byteLength(JSON.stringify(attributes))]);
  });

  test('accounting records and settle provenance', async () => {
    const accounting = recordingPool({
      'select 1 from benchmark_attempt': [{}], 'select 1 from benchmark_admission': [{}], 'insert into benchmark_accounting': [{}], ...storageAnswers,
    });
    await createPostgresBenchmarkWorker({pool: accounting, config}).putAccounting('u', 'a', 'call', 1, {pad: 'x'.repeat(40)});
    assert.deepEqual(charged(accounting), [Buffer.byteLength(JSON.stringify({pad: 'x'.repeat(40)}))]);
    const settling = recordingPool({
      'select a.attempt_id, r.user_id': [{attempt_id: 'a', user_id: 'u', workspace_id: 'w'}],
      'select status, reserve_usd': [{status: 'reserved', reserve: 1, cost: null, day: '2026-01-01'}], ...storageAnswers,
    });
    await createPostgresBenchmarkWorker({pool: settling, config}).settle('u', 'a', 'call', {outcome: 'uncertain', costUsd: null, provenance: {note: 'x'.repeat(30)}});
    assert.deepEqual(charged(settling), [Buffer.byteLength(JSON.stringify({note: 'x'.repeat(30)}))]);
  });

  test('a charge past the member\'s quota is refused, 413 storage_quota_exceeded', async () => {
    const pool = recordingPool({...lease, 'select (select coalesce(sum(octet_length(archive))': [{used: limits.MEMBER_STORAGE_BYTES}]});
    const event = {event_id: 'e', source: 's', kind: 'k', sequence: 1, occurred_ns: '1', data: {a: 1}, payload_sha256s: []};
    await assert.rejects(createPostgresBenchmarkWorker({pool, config}).appendEvents('u', 'a', 1, [event]), {status: 413, code: 'storage_quota_exceeded'});
  });
});

describe('request validation bounds', () => {
  test('a run allows at most MAX_MODEL_CALLS model calls per attempt, and the default stays valid', () => {
    assert.deepEqual(limits.limitOverrides({max_model_calls: limits.MAX_MODEL_CALLS}), {max_model_calls: limits.MAX_MODEL_CALLS});
    assert.throws(() => limits.limitOverrides({max_model_calls: limits.MAX_MODEL_CALLS + 1}), {status: 400, message: /at most 10000/});
    assert.ok(limits.DEFAULT_LIMITS.max_model_calls <= limits.MAX_MODEL_CALLS);
  });

  test('settle provenance is bounded like an accounting record', () => {
    assert.throws(() => settleBody({outcome: 'uncertain', provenance: {pad: 'x'.repeat(limits.MAX_ACCOUNTING_RECORD_BYTES)}}), {status: 413, code: 'too_large'});
    assert.deepEqual(settleBody({outcome: 'uncertain', provenance: {a: 1}}).provenance, {a: 1});
  });

  test('a NUL character anywhere in worker JSON is 400, and an escaped backslash before "u0000" is not one', () => {
    const nul = 'x\u0000y';
    const event = data => ({fence: 1, events: [{event_id: 'e', source: 's', kind: 'k', sequence: 1, occurred_ns: '1', data}]});
    const rejected = [
      () => eventsBody(event({a: nul})), () => eventsBody(event({[nul]: 1})),
      () => spansBody({fence: 1, spans: [{id: 's', kind: 'k', name: 'n', attributes: {a: nul}}]}),
      () => spansBody({fence: 1, links: [{kind: 'k', from: 'a', to: 'b', attributes: {a: nul}}]}),
      () => accountingBody({call_id: 'c', version: 1, record: {a: nul}}),
      () => settleBody({outcome: 'uncertain', provenance: {a: nul}}),
      () => finalizeBody({fence: 1, execution: {status: 'answered'}, coverage: {a: nul}, metrics: {}, final_cursor_expected: 0}),
      () => finalizeBody({fence: 1, execution: {status: 'answered'}, coverage: {}, metrics: {a: nul}, final_cursor_expected: 0}),
    ];
    for (const attempt of rejected) assert.throws(attempt, {status: 400, code: 'invalid_request'});
    assert.doesNotThrow(() => eventsBody(event({a: '\\u0000'})));
    assert.throws(() => eventsBody(event({a: '\\\u0000'})), {status: 400});
  });
});

describe('a session\'s terminals', () => {
  test('output and a close name one terminal, 0 to MAX_TERMINALS - 1, and a link is a port and a token', () => {
    const data = Buffer.from('hi').toString('base64');
    assert.deepEqual(terminalBody({fence: 1, terminal: 3, offset: 0, data}), {fence: 1, terminal: 3, offset: 0, data: Buffer.from('hi')});
    assert.deepEqual(terminalBody({fence: 1, terminal: 3, closed: true}), {fence: 1, terminal: 3, closed: true});
    assert.deepEqual(terminalLinkBody({fence: 1, port: 51234, token: 't0k'}), {fence: 1, port: 51234, token: 't0k'});
    for (const body of [{fence: 1, port: 0, token: 't'}, {fence: 1, port: 65536, token: 't'}, {fence: 1, port: 80, token: ''}, {port: 80, token: 't'}]) {
      assert.throws(() => terminalLinkBody(body), {status: 400, code: 'invalid_request'});
    }
    assert.throws(() => terminalBody({fence: 1, offset: 0, data}), {status: 400, code: 'invalid_request'});
    assert.throws(() => terminalBody({fence: 1, terminal: 0, closed: 'yes'}), {status: 400, code: 'invalid_request'});
  });
});

describe('bounded reads', () => {
  const context = {userId: 'u', workspaceId: 'w'};

  test('the spans read ends at a byte budget and answers truncated when it cut rows', async () => {
    const pool = recordingPool({
      'select 1 from benchmark_attempt': [{}],
      'select id, kind': [{id: 's1', fetched: '3'}, {id: 's2', fetched: '3'}],
      'select kind, "from"': [{kind: 'k', from: 'a', to: 'b', fetched: '1'}],
    });
    const result = await createPostgresBenchmark({pool}).spans(context, 'a', {kind: null, status: null, q: null, limit: 10});
    const query = pool.statements.find(s => s.text.startsWith('select id, kind'));
    assert.match(query.text, /where before_bytes < \$6/);
    assert.equal(query.params.at(-1), limits.MAX_TRACE_PAGE_BYTES);
    assert.deepEqual(result, {spans: [{id: 's1'}, {id: 's2'}], links: [{kind: 'k', from: 'a', to: 'b'}], truncated: true});
  });

  test('the spans read is not truncated when every fetched row fits, keeping the response shape', async () => {
    const pool = recordingPool({'select 1 from benchmark_attempt': [{}], 'select id, kind': [{id: 's1', fetched: '1'}]});
    const result = await createPostgresBenchmark({pool}).spans(context, 'a', {kind: null, status: null, q: null, limit: 10});
    assert.deepEqual(result, {spans: [{id: 's1'}], links: [], truncated: false});
  });

  test('a rerun past MAX_ATTEMPTS_PER_CASE is 409 too_many_attempts, and one under it is queued', async () => {
    const answers = attemptNo => ({
      'select 1 from benchmark_run': [{}], 'select run_id, canceled_at': [{run_id: 'r', canceled_at: null}],
      'select attempt_id, attempt_no, state': [{attempt_id: 'x', attempt_no: attemptNo, state: 'final'}],
    });
    const capped = createPostgresBenchmark({pool: recordingPool(answers(limits.MAX_ATTEMPTS_PER_CASE))});
    await assert.rejects(capped.rerun(context, 'r', 'c1'), {status: 409, code: 'too_many_attempts'});
    const open = await createPostgresBenchmark({pool: recordingPool(answers(limits.MAX_ATTEMPTS_PER_CASE - 1))}).rerun(context, 'r', 'c1');
    assert.equal(open.attempt_no, limits.MAX_ATTEMPTS_PER_CASE);
  });
});

describe('migration 0057', () => {
  const sql = fs.readFileSync(new URL('../../../src/server/postgres/migrations/0057_benchmark_bounded_reads.sql', import.meta.url), 'utf8');

  test('summarizes each case\'s newest attempt and the metric fields the sum reads, and counts stored evidence', () => {
    assert.match(sql, /select distinct on \(x\.case_id\) x\.\* from benchmark_attempt x[^)]*order by x\.case_id, x\.attempt_no desc/);
    for (const field of ['total_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'elapsed_ms', 'missing_calls']) {
      assert.ok(sql.includes(`a.metrics->'${field}'`), field);
    }
    assert.match(sql, /add column stored_bytes bigint not null default 0/);
  });
});
