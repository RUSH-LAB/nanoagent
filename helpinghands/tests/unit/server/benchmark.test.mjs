import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';

const require = createRequire(import.meta.url);
const {canonicalJson, sha256Hex} = require('../../../src/server/benchmark/prompt.js');
const {RUN_ENDPOINT, RUN_MODEL, DEFAULT_LIMITS, LIMIT_FIELDS, capabilitiesOf, effectiveLimits, exceeded, limitOverrides} = require('../../../src/server/benchmark/limits.js');
const {checkWorkers, resolve} = require('../../../src/server/benchmark/plan.js');
const {overBudget, runScore, sumMetrics} = require('../../../src/server/benchmark/rules.js');
const {parseJson, stringifyJson} = require('../../../src/server/benchmark/json.js');
const {benchmarkPublication, claimBody, finalizeBody, runBody} = require('../../../src/server/benchmark/validate.js');

describe('benchmark JSON', () => {
  it('prints a number as the spelling it was read with', () => {
    assert.equal(stringifyJson(parseJson('{"a":1.0,"b":[1e-05,12345678901234567890,2]}')), '{"a":1.0,"b":[1e-05,12345678901234567890,2]}');
    assert.equal(JSON.stringify(new Date(0)), stringifyJson(new Date(0)), 'plain values are written as JSON.stringify writes them');
    assert.equal(canonicalJson(parseJson('{"b":1.0,"a":[2.50]}')), '{"a":[2.50],"b":1.0}');
    assert.notEqual(canonicalJson(parseJson('{"a":1.0}')), canonicalJson(parseJson('{"a":1}')));
  });

  it('keeps empty containers compact and orders canonical keys by code point, not UTF-16 unit', () => {
    assert.equal(canonicalJson({b: [], a: {}}, 2), '{\n  "a": {},\n  "b": []\n}');
    assert.equal(canonicalJson({'😀': 1, '￿': 2}), '{"￿":2,"😀":1}');
  });

  it('rejects what JSON cannot hold', () => {
    assert.throws(() => canonicalJson({a: Infinity}), {code: 'invalid_json_value'});
    assert.throws(() => canonicalJson({a: '\ud800'}), {code: 'invalid_json_value'});
    assert.throws(() => canonicalJson({a: undefined}), {code: 'invalid_json_value'});
  });

  it('hashes the exact UTF-8 text', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('benchmark limits', () => {
  it('defaults to today\'s per-attempt budgets and worker sandbox limits, internet on', () => {
    assert.deepEqual(DEFAULT_LIMITS, {
      wall_time_ms: 600000, max_model_calls: 50, max_output_tokens_per_call: 32768, max_cost_usd: 1.5,
      cpus: 1, memory_mb: 1024, pids: 256, workspace_bytes: 268435456, workspace_files: 20000, tmp_bytes: 67108864, build_wall_ms: 600000,
      build_memory_mb: 3072, build_output_bytes: 1073741824, build_files: 100000, build_tmp_bytes: 536870912, internet_access: true,
    });
  });

  it('overlays overrides on the defaults, treating null as the default, and refuses unknown or invalid limits', () => {
    assert.deepEqual(effectiveLimits(limitOverrides({max_model_calls: 3, internet_access: false, cpus: null})), {...DEFAULT_LIMITS, max_model_calls: 3, internet_access: false});
    assert.throws(() => limitOverrides({nope: 1}), {code: 'invalid_request'});
    assert.throws(() => limitOverrides({wall_time_ms: 0}), {code: 'invalid_request'});
    assert.throws(() => limitOverrides({pids: 1.5}), {code: 'invalid_request'});
    assert.throws(() => limitOverrides({internet_access: 'yes'}), {code: 'invalid_request'});
    assert.throws(() => limitOverrides({cpus: 0}), {code: 'invalid_request'});
    assert.deepEqual(limitOverrides({cpus: 0.5, max_cost_usd: 0}), {cpus: 0.5, max_cost_usd: 0});
  });

  it('checks limits against what a worker advertises, internet access included', () => {
    const caps = {...DEFAULT_LIMITS, internet_access: false};
    assert.deepEqual(exceeded(DEFAULT_LIMITS, caps), [{field: 'internet_access', limit: true, max: false}]);
    assert.deepEqual(exceeded({...DEFAULT_LIMITS, internet_access: false, memory_mb: 2048}, caps), [{field: 'memory_mb', limit: 2048, max: 1024}]);
    assert.deepEqual(exceeded({...DEFAULT_LIMITS, internet_access: false}, caps), []);
  });

  it('bounds the build and the workspace snapshot by limits of their own, each checked against the worker', () => {
    const overrides = limitOverrides({build_memory_mb: 2048, build_output_bytes: 2 ** 31, build_files: 200000, build_tmp_bytes: 2 ** 30, workspace_files: 5});
    assert.deepEqual(overrides, {build_memory_mb: 2048, build_output_bytes: 2 ** 31, build_files: 200000, build_tmp_bytes: 2 ** 30, workspace_files: 5});
    assert.throws(() => limitOverrides({build_files: 0}), {code: 'invalid_request', message: /build_files/});
    const caps = {...DEFAULT_LIMITS, internet_access: true};
    for (const field of ['build_memory_mb', 'build_output_bytes', 'build_files', 'build_tmp_bytes', 'workspace_files']) {
      assert.deepEqual(exceeded({...DEFAULT_LIMITS, [field]: DEFAULT_LIMITS[field] + 1}, caps), [{field, limit: DEFAULT_LIMITS[field] + 1, max: DEFAULT_LIMITS[field]}]);
    }
  });

  it('wants every limit in the capabilities a worker sends', () => {
    assert.deepEqual(Object.keys(capabilitiesOf({...DEFAULT_LIMITS, models: ['vendor/model']})), [...LIMIT_FIELDS, 'models']);
    const {pids, ...missing} = {...DEFAULT_LIMITS, models: ['vendor/model']};
    assert.throws(() => capabilitiesOf(missing), {code: 'invalid_request', message: /pids/});
    assert.throws(() => claimBody({worker_id: 'w', endpoint_profile: {mode: 'm', label: 'l'}}), {code: 'invalid_request'});
    assert.equal(claimBody({worker_id: 'w', endpoint_profile: {mode: 'm', label: 'l'}, capabilities: {...DEFAULT_LIMITS, models: ['vendor/model']}, interactive: false}).label, 'l');
    assert.throws(() => claimBody({worker_id: 'w', endpoint_profile: {mode: 'm', label: 'l'}, capabilities: {...DEFAULT_LIMITS, models: ['vendor/model']}}), {code: 'invalid_request'});
  });

  it('wants the models a worker prices, as a non-empty list of names', () => {
    for (const models of [undefined, [], [''], [1], 'vendor/model']) {
      assert.throws(() => capabilitiesOf({...DEFAULT_LIMITS, models}), {code: 'invalid_request', message: /models/});
    }
    assert.deepEqual(capabilitiesOf({...DEFAULT_LIMITS, models: ['a/b', 'a/b', 'c/d']}).models, ['a/b', 'c/d']);
  });
});

const TASK = {
  kind: 'agent', egress_hosts: ['api.example.com'], description: 'Sum', input_schema: {type: 'object'}, output_schema: {type: 'object', properties: {sum: {type: 'number'}}},
  tools: [{name: 'read', description: 'Reads', input_schema: {type: 'object'}, output_schema: {type: 'object'}, writes: false}],
};
const ARCHIVE = gzipSync(Buffer.from('a tar, as far as the server can tell'));
const FIXTURES = {sha256: sha256Hex(ARCHIVE), files: {'inputs/a.csv': 'b'.repeat(64)}, archive: ARCHIVE.toString('base64')};
const publication = (extra = {}) => ({
  name: 'sums-1', plugin_id: 'p', plugin_name: 'Plugin P', version: '1', package_sha256: 'a'.repeat(64), task_id: 't', task: structuredClone(TASK),
  cases: [
    {case_id: 'a1', kind: 'answer', prompt: 'Add x: 1', arguments: {x: 1}, fixtures: structuredClone(FIXTURES), expected_error: null},
    {case_id: 'r1', kind: 'refuse', prompt: 'Add x: bad', arguments: {x: 'bad'}, fixtures: null, expected_error: 'x must be a number'},
    {case_id: 'a2', kind: 'answer', prompt: 'Add x: 2', arguments: {x: 2}, fixtures: null, expected_error: null},
    {case_id: 'r2', kind: 'refuse', prompt: 'Add x: nothing', arguments: {x: null}, fixtures: null, expected_error: 'x is required'},
  ],
  private: {a1: {sum: 1}, r1: 'x must be a number', a2: null, r2: 'x is required'},
  ...extra,
});
const published = (extra, mutate) => {
  const body = publication(extra);
  mutate?.(body);
  return benchmarkPublication(body);
};
/** A benchmark as the repository reads it: the publication's public parts, a case's fixtures as `{sha256, files}`. */
const benchmarkFor = (body = publication(), extra = {}) => {
  const made = benchmarkPublication(body);
  return {
    benchmark_id: '00000000-0000-4000-8000-000000000001', name: made.name, plugin: {id: made.plugin_id, name: made.plugin_name, version: made.version, sha256: made.package_sha256},
    task: made.task, model: made.model, endpoint_profile: made.endpoint_profile, limits: made.limits, digest: made.digest,
    cases: made.cases.map(({reference_sha256: _ref, fixtures, ...c}) => ({...c, fixtures: fixtures && {sha256: fixtures.sha256, files: fixtures.files}})), ...extra,
  };
};

describe('benchmark publication', () => {
  it('derives per-case content digests from kind, prompt, arguments, fixtures digest and files, expected error and the reference digest', () => {
    const {cases} = published();
    const reference = sha256Hex(canonicalJson({sum: 1}));
    assert.equal(cases[0].reference_sha256, reference);
    assert.equal(cases[0].prompt_sha256, sha256Hex('Add x: 1'));
    assert.equal(cases[0].content_digest, sha256Hex(canonicalJson({
      kind: 'answer', prompt: 'Add x: 1', arguments: {x: 1}, fixtures_sha256: FIXTURES.sha256, fixtures_files: FIXTURES.files, expected_error: null, reference_sha256: reference,
    })));
    assert.equal(cases[2].reference_sha256, sha256Hex('null'), 'a task judged without a reference pins JSON null');
    assert.equal(cases[1].content_digest, sha256Hex(canonicalJson({
      kind: 'refuse', prompt: 'Add x: bad', arguments: {x: 'bad'}, fixtures_sha256: null, fixtures_files: null, expected_error: 'x must be a number', reference_sha256: sha256Hex(canonicalJson('x must be a number')),
    })));
  });

  it('keeps the prompt byte for byte and the archive as bytes whose digest it checked', () => {
    const made = published({}, body => { body.cases[2].prompt = 'a\r\n  b\tc'; });
    assert.equal(made.cases[2].prompt, 'a\r\n  b\tc');
    assert.ok(Buffer.isBuffer(made.cases[0].fixtures.archive));
    assert.equal(sha256Hex(made.cases[0].fixtures.archive), FIXTURES.sha256);
    assert.deepEqual(made.cases[0].fixtures.files, FIXTURES.files);
    assert.equal(made.cases[1].fixtures, null);
  });

  it('gives the case set a digest that changes with a prompt, a fixture, a reference, the task or the package, and not with the run configuration', () => {
    const first = published().case_set_digest;
    assert.equal(published().case_set_digest, first);
    assert.notEqual(published({}, body => { body.private.a1.sum = 2; }).case_set_digest, first);
    assert.notEqual(published({}, body => { body.cases[2].prompt = 'Add 2'; }).case_set_digest, first);
    assert.notEqual(published({}, body => { body.cases[2].fixtures = structuredClone(FIXTURES); }).case_set_digest, first);
    // The same archive with another file list (which the worker would refuse on unpacking) never shares the case set of the right one.
    assert.notEqual(published({}, body => { body.cases[0].fixtures.files = {'other.csv': 'd'.repeat(64)}; }).case_set_digest, first);
    assert.notEqual(published({}, body => { body.task.description = 'Other'; }).case_set_digest, first);
    assert.notEqual(published({package_sha256: 'b'.repeat(64)}).case_set_digest, first);
    assert.equal(published({limits: {max_model_calls: 3}}).case_set_digest, first);
  });

  it('gives the benchmark a digest of the case set and the pinned configuration', () => {
    const first = published();
    assert.equal(first.digest, sha256Hex(canonicalJson({case_set_digest: first.case_set_digest, model: RUN_MODEL, endpoint_profile: RUN_ENDPOINT, limits: DEFAULT_LIMITS})));
    assert.equal(published().digest, first.digest);
    for (const extra of [{limits: {max_model_calls: 3}}]) {
      assert.notEqual(published(extra).digest, first.digest, JSON.stringify(extra));
    }
    assert.equal(published({limits: {internet_access: false}}).limits.internet_access, false);
  });

  it('reads limits from a body whose numbers keep their spelling, and pins the defaults for what is null', () => {
    const body = parseJson(JSON.stringify(publication({limits: {max_cost_usd: null, cpus: 0.5}})).replace('"cpus":0.5', '"cpus":0.50'));
    const made = benchmarkPublication(body);
    assert.deepEqual([made.limits.cpus, made.limits.max_cost_usd], [0.5, DEFAULT_LIMITS.max_cost_usd]);
  });

  it('refuses the old shape, naming the field: context, a coding template, task instructions, a case without a prompt', () => {
    const refusal = (mutate, message) => assert.throws(() => published({}, mutate), {code: 'invalid_request', message});
    refusal(body => { body.context = 'Numbers only'; }, /context is no longer a field/);
    refusal(body => { body.coding_template = 'Do {description}'; }, /coding_template is no longer a field/);
    refusal(body => { body.task_instructions = 'Add them'; }, /task_instructions is no longer a field/);
    refusal(body => { body.task.instructions = 'Add them'; }, /task\.instructions is no longer a field/);
    refusal(body => { delete body.cases[0].prompt; }, /Case a1's prompt/);
    refusal(body => { body.cases[0].context = 'x'; }, /Case a1 has context, which is no field of a case/);
    refusal(body => { delete body.cases[0].fixtures; }, /Case a1's fixtures/);
    refusal(body => { body.cases[0].prompt = '  \n'; }, /Case a1's prompt/);
  });

  it('checks a case\'s fixtures: the archive\'s digest, its size and its files\' paths and digests', () => {
    const refusal = (mutate, expected) => assert.throws(() => published({}, body => mutate(body.cases[0].fixtures)), expected);
    refusal(fixtures => { fixtures.sha256 = 'c'.repeat(64); }, {code: 'invalid_request', message: /does not hash to its sha256/});
    refusal(fixtures => { fixtures.sha256 = 'XYZ'; }, {code: 'invalid_request', message: /SHA-256/});
    refusal(fixtures => { fixtures.archive = '%%%%'; }, {code: 'invalid_request', message: /as base64/});
    refusal(fixtures => { fixtures.archive = ''; }, {code: 'invalid_request', message: /as base64|empty/});
    refusal(fixtures => { fixtures.extra = 1; }, {code: 'invalid_request', message: /extra, which is no field/});
    for (const path of ['../a', 'a/../b', '/abs/a', 'a//b', './a', 'a/.', 'a\\b', '']) {
      refusal(fixtures => { fixtures.files = {[path]: 'b'.repeat(64)}; }, {code: 'invalid_request', message: /relative POSIX path/});
    }
    refusal(fixtures => { fixtures.files = {'a.csv': 'nothex'}; }, {code: 'invalid_request', message: /digest of a\.csv/});
    refusal(fixtures => { fixtures.files = ['a.csv']; }, {code: 'invalid_request', message: /files must be an object/});
    assert.doesNotThrow(() => published({}, body => { body.cases[0].fixtures.files = {'a/b/c.txt': 'b'.repeat(64), 'dir/.hidden': 'b'.repeat(64)}; }));
  });

  it('refuses fixtures over 8 MiB decoded with fixtures_too_large, without decoding them', () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
    const fixtures = {sha256: sha256Hex(big), files: {}, archive: big.toString('base64')};
    assert.throws(() => published({}, body => { body.cases[0].fixtures = fixtures; }), {code: 'fixtures_too_large', status: 400});
    const edge = Buffer.alloc(8 * 1024 * 1024, 1);
    assert.doesNotThrow(() => published({}, body => { body.cases[0].fixtures = {sha256: sha256Hex(edge), files: {}, archive: edge.toString('base64')}; }));
  });

  it('keeps no scoring mode, scale, weights, explanations, tool policy, toolchains or hooks anywhere', () => {
    const made = benchmarkPublication(publication({scoring: 'plugin_hooks', scale: {min: 0, max: 1}, weights: {}, explanations: {}, tool_policy: {}, toolchains: ['python'], plugin_hooks: {}}));
    const text = JSON.stringify(made);
    for (const word of ['scoring', 'scale', 'weights', 'explanations', 'tool_policy', 'toolchains', 'hooks']) assert.ok(!text.includes(`"${word}"`), word);
  });

  it('refuses what cannot be a benchmark', () => {
    const refused = mutate => assert.throws(() => benchmarkPublication((() => { const body = publication(); mutate(body); return body; })()), {code: 'invalid_request'});
    refused(body => { delete body.private.a1; });
    refused(body => { body.private.extra = {}; });
    refused(body => { body.cases[0].kind = 'maybe'; });
    refused(body => { delete body.cases[1].expected_error; });
    refused(body => { body.cases[0].expected_error = 'no'; });
    refused(body => { body.private.r1 = {not: 'a string'}; });
    refused(body => { body.private.a1 = 'a string'; });
    refused(body => { body.cases[1].case_id = 'a1'; });
    refused(body => { body.cases = []; });
    refused(body => { body.task.kind = 'other'; });
    refused(body => { body.task.egress_hosts = ['b.com', 'a.com']; });
    refused(body => { delete body.task.egress_hosts; });
    refused(body => { body.name = 'Bad Name'; });
    refused(body => { delete body.plugin_name; });
    refused(body => { body.model = 'other/model'; });
    refused(body => { body.endpoint_profile = 'other'; });
    refused(body => { body.limits = {nope: 1}; });
    refused(body => { body.limits = {memory_mb: 0}; });
  });
});

const capabilities = {...DEFAULT_LIMITS, models: [RUN_MODEL]};

describe('benchmark run resolution', () => {
  it('takes every case of the benchmark in its order, with the benchmark\'s limits', () => {
    const {cases, limits} = resolve({benchmark: benchmarkFor(), capabilities});
    assert.deepEqual(cases.map(c => [c.case_id, c.position]), [['a1', 0], ['r1', 1], ['a2', 2], ['r2', 3]]);
    assert.equal(cases[0].prompt, 'Add x: 1');
    assert.deepEqual(cases[0].fixtures, {sha256: FIXTURES.sha256, files: FIXTURES.files});
    assert.deepEqual(limits, DEFAULT_LIMITS);
  });

  it('refuses limits beyond the workers\' and an endpoint no worker advertised for', () => {
    const big = benchmarkFor(publication({limits: {memory_mb: 4096}}));
    assert.throws(() => resolve({benchmark: big, capabilities}), {code: 'limit_exceeds_worker'});
    assert.throws(() => resolve({benchmark: benchmarkFor(), capabilities: null}), {code: 'worker_unavailable', status: 409});
    assert.throws(() => checkWorkers(DEFAULT_LIMITS, RUN_MODEL, {...capabilities, internet_access: false}, 'mock'), {code: 'limit_exceeds_worker'});
    assert.doesNotThrow(() => checkWorkers({...DEFAULT_LIMITS, memory_mb: 512}, RUN_MODEL, capabilities, 'mock'));
  });

  it('has no concurrency of a run\'s own: a request that sends one is refused as an unknown limit, naming where it is set', () => {
    assert.ok(!LIMIT_FIELDS.includes('concurrency'));
    assert.throws(() => limitOverrides({concurrency: 4}), {code: 'invalid_request', message: /limits\.concurrency is not a limit.*local runner/});
    assert.throws(() => benchmarkPublication(publication({limits: {concurrency: 4}})), {code: 'invalid_request', message: /limits\.concurrency/});
  });

  it('refuses a model no worker of the endpoint prices, naming what they price', () => {
    const unpriced = benchmarkFor(publication(), {model: 'other/model'});
    assert.throws(() => resolve({benchmark: unpriced, capabilities}), {code: 'unknown_model', status: 400, extra: {model: 'other/model', models: [RUN_MODEL]}});
    assert.throws(() => checkWorkers(DEFAULT_LIMITS, 'other/model', capabilities, 'mock'), {code: 'unknown_model', message: /deepseek/});
  });
});

const attempt = (case_id, attempt_no, state, verdict = null, extra = {}) => ({attempt_id: `${case_id}${attempt_no}`, case_id, attempt_no, state, verdict, ...extra});

describe('benchmark run score and budgets', () => {
  it('scores passed over scored from each case\'s newest attempt', () => {
    const score = runScore(['a', 'b', 'c'], [attempt('a', 1, 'final', 'fail'), attempt('a', 2, 'final', 'pass'), attempt('b', 1, 'final', 'fail'), attempt('c', 1, 'final', 'pass')]);
    assert.deepEqual([score.value, score.passed, score.scored, score.total, score.complete, score.unscored], [2 / 3, 2, 3, 3, true, 0]);
  });

  it('leaves cases without a verdict out of the score, and says why when none was scored', () => {
    const partial = runScore(['a', 'b', 'c'], [attempt('a', 1, 'final', 'pass'), attempt('b', 1, 'final', null), attempt('c', 1, 'leased')]);
    assert.deepEqual([partial.value, partial.scored, partial.unscored, partial.complete, partial.unavailable_reason], [1, 1, 2, false, null]);
    assert.equal(runScore(['a'], [attempt('a', 1, 'queued')]).unavailable_reason, 'scoring_pending');
    assert.equal(runScore(['a'], [attempt('a', 1, 'final', null)]).unavailable_reason, 'no_scored_cases');
    const failed = runScore(['a'], [attempt('a', 1, 'final', null, {verifier_error: 'boom'})]);
    assert.deepEqual([failed.value, failed.unavailable_reason, failed.verifier_errors], [null, 'verifier_error', 1]);
  });

  it('does not grade a run with a case in a worker error, and counts a retry in flight as the case\'s attempt instead', () => {
    const errored = attempt('b', 3, 'final', null, {execution_status: 'worker_error'});
    const graded = runScore(['a', 'b'], [attempt('a', 1, 'final', 'pass'), errored]);
    assert.deepEqual([graded.value, graded.unavailable_reason, graded.complete], [null, 'worker_error', true]);
    const retrying = runScore(['a', 'b'], [attempt('a', 1, 'final', 'pass'), attempt('b', 1, 'final', null, {execution_status: 'worker_error'}), attempt('b', 2, 'queued')]);
    assert.deepEqual([retrying.value, retrying.unavailable_reason, retrying.complete], [1, null, false]);
  });

  it('sums metrics and counts the attempts that did not report a field', () => {
    const sums = sumMetrics([{total_tokens: 3, elapsed_ms: 10}, {total_tokens: 4}, null]);
    assert.deepEqual(sums.total_tokens, {total: 7, missing_attempts: 1});
    assert.deepEqual(sums.elapsed_ms, {total: 10, missing_attempts: 2});
  });

  it('counts an attempt with a call that did not report a token field as missing it, keeping its known subtotal', () => {
    const partial = {total_tokens: 5, input_tokens: 4, missing_calls: {total: 1, input: 0}, elapsed_ms: 10};
    const sums = sumMetrics([partial, {total_tokens: 3, input_tokens: 2, missing_calls: {total: 0, input: 0}}]);
    assert.deepEqual(sums.total_tokens, {total: 8, missing_attempts: 1});
    assert.deepEqual(sums.input_tokens, {total: 6, missing_attempts: 0});
    assert.deepEqual(sums.elapsed_ms, {total: 10, missing_attempts: 1});
  });

  it('names the first exhausted budget', () => {
    const base = {reserve: 1, callsAdmitted: 0, maxCalls: 2, attemptCommitted: 0, maxCost: 5, memberCommitted: 0, memberCap: 5, workspaceCommitted: 0, workspaceCap: 5};
    assert.equal(overBudget(base), null);
    assert.equal(overBudget({...base, callsAdmitted: 2}), 'calls');
    assert.equal(overBudget({...base, attemptCommitted: 4.5}), 'attempt');
    assert.equal(overBudget({...base, memberCommitted: 4.5}), 'member');
    assert.equal(overBudget({...base, workspaceCommitted: 4.5}), 'workspace');
    assert.equal(overBudget({...base, attemptCommitted: 4, memberCommitted: 4}), null);
  });
});

describe('benchmark request validation', () => {
  const base = {fence: 1, execution: {status: 'answered'}, coverage: {}, metrics: {}, final_cursor_expected: 0};

  it('allows a pass or fail verdict only for results the verifier saw, and a verifier error only for a delivered answer or refusal', () => {
    assert.equal(finalizeBody({...base, verdict: 'pass'}).final.verdict, 'pass');
    assert.equal(finalizeBody({...base, execution: {status: 'execution_failed'}, verdict: 'fail'}).final.verdict, 'fail');
    assert.equal(finalizeBody({...base, verifier_error: 'boom'}).final.verifier_error, 'boom');
    assert.equal(finalizeBody(base).final.verdict, null);
    assert.throws(() => finalizeBody({...base, verdict: 'correct'}), {code: 'invalid_request'});
    // An explanation code comes only with a fail verdict, and is one of the verifier's.
    assert.equal(finalizeBody({...base, verdict: 'fail', explanation: 'invalid_answer'}).final.explanation, 'invalid_answer');
    assert.equal(finalizeBody({...base, verdict: 'fail'}).final.explanation, null);
    assert.throws(() => finalizeBody({...base, verdict: 'pass', explanation: 'invalid_answer'}), {code: 'invalid_request'});
    assert.throws(() => finalizeBody({...base, verdict: 'fail', explanation: 'because'}), {code: 'invalid_request'});
    assert.throws(() => finalizeBody({...base, verdict: 'pass', verifier_error: 'boom'}), {code: 'invalid_request'});
    assert.throws(() => finalizeBody({...base, execution: {status: 'canceled'}, verdict: 'pass'}), {code: 'verdict_not_allowed'});
    assert.throws(() => finalizeBody({...base, execution: {status: 'execution_failed'}, verifier_error: 'boom'}), {code: 'verdict_not_allowed'});
  });

  it('keeps the verifier\'s checks, names and statuses only, with the verdict they explain', () => {
    const checks = [{name: 'outcome_exists', status: 'passed'}, {name: 'schema_valid', status: 'failed'}, {name: 'values_match', status: 'skipped'}];
    assert.deepEqual(finalizeBody({...base, verdict: 'fail', checks}).final.checks, checks);
    assert.equal(finalizeBody({...base, verdict: 'pass'}).final.checks, null);
    assert.throws(() => finalizeBody({...base, checks}), {code: 'invalid_request', message: /checks come only with a verdict/});
    assert.throws(() => finalizeBody({...base, verdict: 'fail', checks: [{name: 'a', status: 'maybe'}]}), {code: 'invalid_request', message: /status/});
    assert.throws(() => finalizeBody({...base, verdict: 'fail', checks: [{name: 'a', status: 'passed', message: 'm'}]}), {code: 'invalid_request', message: /message/});
    assert.throws(() => finalizeBody({...base, verdict: 'fail', checks: [{status: 'passed'}]}), {code: 'invalid_request'});
    assert.throws(() => finalizeBody({...base, verdict: 'fail', checks: 'passed'}), {code: 'invalid_request'});
  });

  it('knows no build_failed attempt: a harness is never built', () => {
    assert.throws(() => finalizeBody({...base, execution: {status: 'build_failed'}}), {code: 'invalid_request'});
  });

  it('takes a benchmark, a harness and a key to run, and no case selection', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const body = {benchmark_id: id, harness: 'claude', idempotency_key: 'k'};
    assert.deepEqual(runBody(body), {...body, request_digest: runBody(body).request_digest});
    assert.equal(runBody({...body, harness: 'rush aider'}).harness, 'rush aider');
    for (const harness of ['claude-code', 'rush', 'rush ', 'rush a  b', 'shell', 'Claude', undefined, 1]) {
      assert.throws(() => runBody({...body, harness}), {code: 'unknown_harness', status: 400}, String(harness));
    }
    for (const bad of [{benchmark_id: 'x'}, {idempotency_key: ''}, {cases: ['a1']}, {interactive: true}]) {
      assert.throws(() => runBody({...body, ...bad}), {code: 'invalid_request'}, JSON.stringify(bad));
    }
  });

  it('digests a run request independent of key order, by what it names', () => {
    const body = {benchmark_id: '00000000-0000-4000-8000-000000000001', harness: 'claude', idempotency_key: 'k'};
    assert.equal(runBody(body).request_digest, runBody({...Object.fromEntries(Object.entries(body).reverse())}).request_digest);
    assert.notEqual(runBody({...body, harness: 'codex'}).request_digest, runBody(body).request_digest);
    for (const field of Object.keys(body)) assert.throws(() => runBody({...body, [field]: undefined}), {code: field === 'harness' ? 'unknown_harness' : 'invalid_request'}, field);
    // The policy, previews and sources are gone from a run.
    for (const extra of [{policy: 'coding'}, {preview_id: '00000000-0000-4000-8000-000000000000'}, {source_sha256: 'a'.repeat(64)}, {model: 'm'}, {limits: {}}]) {
      assert.throws(() => runBody({...body, ...extra}), {code: 'invalid_request'});
    }
  });
});
