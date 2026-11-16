import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const {
  canonicalJson, normalizeInstructions, pythonFormat, pythonJson, renderCoding, renderTaskTools, DEFAULT_CODING_TEMPLATE, RENDERER_VERSION, sha256Hex,
} = require('../../../src/server/benchmark/prompt.js');
const {DEFAULT_LIMITS, LIMIT_FIELDS, capabilitiesOf, effectiveLimits, exceeded, limitOverrides} = require('../../../src/server/benchmark/limits.js');
const {checkWorkers, resolve, changedParts} = require('../../../src/server/benchmark/plan.js');
const {overBudget, runScore, sumMetrics} = require('../../../src/server/benchmark/rules.js');
const {parseJson, stringifyJson} = require('../../../src/server/benchmark/json.js');
const {benchmarkPublication, claimBody, finalizeBody, previewBody, runBody} = require('../../../src/server/benchmark/validate.js');

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const PARITY = JSON.parse(readFileSync(fixture('benchmark-prompt-parity.json'), 'utf8'));
const STEP2_CONFIG = fileURLToPath(new URL('../../../../nanoagent/examples/benchmark/configs/step2_single_run.yaml', import.meta.url));

describe('benchmark prompt renderer', () => {
  it('is named rush.prompt.v1', () => assert.equal(RENDERER_VERSION, 'rush.prompt.v1'));

  it('keeps its default coding template equal to the plugin benchmark config\'s prompt', () => {
    assert.equal(DEFAULT_CODING_TEMPLATE, yaml.load(readFileSync(STEP2_CONFIG, 'utf8')).prompt);
  });

  // The fixtures are what Python's real task_prompt, decide_prompt and str.format produced (fixtures/benchmark_prompt_parity.py).
  for (const [index, recorded] of PARITY.entries()) {
    // The task and arguments are read the way the server reads a publication, so a number keeps the spelling Python wrote.
    const sample = {...recorded, ...parseJson(recorded.input_json)};
    describe(`parity with Python, sample ${index + 1} (${sample.kind})`, () => {
      const task = sample.task;

      it('renders the coding prompt as other_work formats it', () => {
        const prompt = renderCoding(DEFAULT_CODING_TEMPLATE, {task, context: sample.context, args: sample.arguments});
        assert.equal(prompt.system, null);
        assert.equal(prompt.user, sample.coding);
        assert.equal(prompt.sha256, sha256Hex(canonicalJson({system: null, user: sample.coding})));
      });

      it('renders a custom template with Python str.format semantics', () => {
        assert.equal(renderCoding(sample.custom_template, {task, context: sample.context, args: sample.arguments}).user, sample.custom_coding);
      });

      it('renders the task tools prompt as task_prompt or decide_prompt builds it', () => {
        const prompt = renderTaskTools({pluginName: sample.plugin_name, task, instructions: task.instructions, args: sample.arguments});
        assert.equal(prompt.system, sample.task_tools.system);
        assert.equal(prompt.user, sample.task_tools.user);
      });
    });
  }

  it('puts the run\'s instructions in place of the task\'s in the task tools prompt', () => {
    const [recorded] = PARITY;
    const sample = {...recorded, ...parseJson(recorded.input_json)};
    const prompt = renderTaskTools({pluginName: sample.plugin_name, task: sample.task, instructions: 'Custom steps', args: sample.arguments});
    assert.equal(prompt.system, sample.task_tools.system.replace(sample.task.instructions, 'Custom steps'));
  });

  it('formats like Python: braces escape, an unknown placeholder or a stray brace is an error', () => {
    assert.equal(pythonFormat('{{a}} {x}', {x: '1'}), '{a} 1');
    assert.throws(() => pythonFormat('{nope}', {x: '1'}), {code: 'invalid_template'});
    assert.throws(() => pythonFormat('{}', {x: '1'}), {code: 'invalid_template'});
    assert.throws(() => pythonFormat('{x!r}', {x: '1'}), {code: 'invalid_template'});
    assert.throws(() => pythonFormat('{x:>3}', {x: '1'}), {code: 'invalid_template'});
    assert.throws(() => pythonFormat('{x.y}', {x: '1'}), {code: 'invalid_template'});
    assert.throws(() => pythonFormat('a } b', {x: '1'}), {code: 'invalid_template'});
    assert.throws(() => pythonFormat('a { b', {x: '1'}), {code: 'invalid_template'});
  });

  it('prints JSON as Python\'s json.dumps(indent=2) does: key order kept, non-ASCII escaped in lowercase', () => {
    assert.equal(pythonJson({b: 1, a: ['é', {}], c: []}), '{\n  "b": 1,\n  "a": [\n    "\\u00e9",\n    {}\n  ],\n  "c": []\n}');
    assert.equal(pythonJson({s: '😀'}), '{\n  "s": "\\ud83d\\ude00"\n}');
  });

  it('prints a number as the spelling it was read with, and a JavaScript number as Python\'s repr would', () => {
    assert.equal(pythonJson(parseJson('[1.0, 1e-05, 1E5, -0.0, 12345678901234567890, 7, -0]')), '[\n  1.0,\n  1e-05,\n  1E5,\n  -0.0,\n  12345678901234567890,\n  7,\n  0\n]');
    assert.equal(pythonJson([0.1, 1e-7, 0.0001, 1.5e16, 1e22, 2 ** 60, 123456789.5, 3]), '[\n  0.1,\n  1e-07,\n  0.0001,\n  1.5e+16,\n  1e+22,\n  1.152921504606847e+18,\n  123456789.5,\n  3\n]');
    assert.equal(stringifyJson(parseJson('{"a":1.0,"b":[1e-05,12345678901234567890,2]}')), '{"a":1.0,"b":[1e-05,12345678901234567890,2]}');
    assert.equal(JSON.stringify(new Date(0)), stringifyJson(new Date(0)), 'plain values are written as JSON.stringify writes them');
    assert.equal(canonicalJson(parseJson('{"b":1.0,"a":[2.50]}')), '{"a":[2.50],"b":1.0}');
    assert.notEqual(canonicalJson(parseJson('{"a":1.0}')), canonicalJson(parseJson('{"a":1}')));
  });

  it('strips what Python strips, not what trim strips', () => {
    const prompt = renderCoding('{context}', {task: {description: '', input_schema: {}, output_schema: {}}, context: '\x1c\x85 \n\u00a0 a b \u3000\n\ufeff', args: {}});
    assert.equal(prompt.user, 'a b \u3000\n\ufeff');
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

  it('normalizes CRLF and CR to LF and nothing else, and refuses blank text', () => {
    assert.equal(normalizeInstructions('a\r\nb\rc\n  d \t'), 'a\nb\nc\n  d \t');
    assert.throws(() => normalizeInstructions(' \r\n\t'), {code: 'empty_instructions'});
    assert.throws(() => normalizeInstructions(''), {code: 'empty_instructions'});
  });

  it('hashes the exact UTF-8 text', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('benchmark limits', () => {
  it('defaults to today\'s per-attempt budgets and worker sandbox limits, internet on', () => {
    assert.deepEqual(DEFAULT_LIMITS, {
      wall_time_ms: 600000, max_model_calls: 50, max_output_tokens_per_call: 4096, max_cost_usd: 1.5, concurrency: 4,
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
    assert.equal(claimBody({worker_id: 'w', endpoint_profile: {mode: 'm', label: 'l'}, capabilities: {...DEFAULT_LIMITS, models: ['vendor/model']}}).label, 'l');
  });

  it('wants the models a worker prices, as a non-empty list of names', () => {
    for (const models of [undefined, [], [''], [1], 'vendor/model']) {
      assert.throws(() => capabilitiesOf({...DEFAULT_LIMITS, models}), {code: 'invalid_request', message: /models/});
    }
    assert.deepEqual(capabilitiesOf({...DEFAULT_LIMITS, models: ['a/b', 'a/b', 'c/d']}).models, ['a/b', 'c/d']);
  });
});

const TASK = {
  kind: 'agent', egress_hosts: ['api.example.com'], description: 'Sum', instructions: 'Add them', input_schema: {type: 'object'}, output_schema: {type: 'object', properties: {sum: {type: 'number'}}},
  tools: [{name: 'read', description: 'Reads', input_schema: {type: 'object'}, output_schema: {type: 'object'}, writes: false}],
};
const publication = (extra = {}) => ({
  name: 'sums-1', plugin_id: 'p', plugin_name: 'Plugin P', version: '1', package_sha256: 'a'.repeat(64), task_id: 't', task: structuredClone(TASK), context: 'Numbers only',
  cases: [
    {case_id: 'a1', kind: 'answer', arguments: {x: 1}}, {case_id: 'r1', kind: 'refuse', arguments: {x: 'bad'}, expected_error: 'x must be a number'},
    {case_id: 'a2', kind: 'answer', arguments: {x: 2}}, {case_id: 'r2', kind: 'refuse', arguments: {x: null}, expected_error: 'x is required'},
  ],
  private: {a1: {sum: 1}, r1: 'x must be a number', a2: null, r2: 'x is required'},
  model: 'vendor/model', endpoint_profile: 'mock',
  ...extra,
});
const published = (extra, mutate) => {
  const body = publication(extra);
  mutate?.(body);
  return benchmarkPublication(body);
};
/** A benchmark as the repository reads it: the publication's public parts. */
const benchmarkFor = (body = publication(), extra = {}) => {
  const made = benchmarkPublication(body);
  return {
    benchmark_id: '00000000-0000-4000-8000-000000000001', name: made.name, plugin: {id: made.plugin_id, name: made.plugin_name, version: made.version, sha256: made.package_sha256},
    task: made.task, context: made.context, model: made.model, endpoint_profile: made.endpoint_profile, limits: made.limits, coding_template: made.coding_template,
    task_instructions: made.task_instructions, digest: made.digest, cases: made.cases.map(({reference_sha256: _ref, ...c}) => c), ...extra,
  };
};

describe('benchmark publication', () => {
  it('derives per-case content digests from kind, arguments, expected error and the reference digest', () => {
    const {cases} = published();
    const reference = sha256Hex(canonicalJson({sum: 1}));
    assert.equal(cases[0].reference_sha256, reference);
    assert.equal(cases[0].content_digest, sha256Hex(canonicalJson({kind: 'answer', arguments: {x: 1}, expected_error: null, reference_sha256: reference})));
    assert.equal(cases[2].reference_sha256, sha256Hex('null'), 'a task judged without a reference pins JSON null');
    assert.equal(cases[1].content_digest, sha256Hex(canonicalJson({
      kind: 'refuse', arguments: {x: 'bad'}, expected_error: 'x must be a number', reference_sha256: sha256Hex(canonicalJson('x must be a number')),
    })));
  });

  it('gives the case set a digest that changes with a reference, the task, the context or the package, and not with the run configuration', () => {
    const first = published().case_set_digest;
    assert.equal(published().case_set_digest, first);
    assert.notEqual(published({}, body => { body.private.a1.sum = 2; }).case_set_digest, first);
    assert.notEqual(published({}, body => { body.task.instructions = 'Other'; }).case_set_digest, first);
    assert.notEqual(published({context: 'More'}).case_set_digest, first);
    assert.notEqual(published({package_sha256: 'b'.repeat(64)}).case_set_digest, first);
    assert.equal(published({model: 'other/model'}).case_set_digest, first);
  });

  it('gives the benchmark a digest of the case set and the pinned configuration', () => {
    const first = published();
    assert.equal(first.digest, sha256Hex(canonicalJson({
      case_set_digest: first.case_set_digest, model: 'vendor/model', endpoint_profile: 'mock', limits: DEFAULT_LIMITS,
      coding_template: DEFAULT_CODING_TEMPLATE, task_instructions: 'Add them',
    })));
    assert.equal(published().digest, first.digest);
    for (const extra of [{model: 'other/model'}, {endpoint_profile: 'real'}, {limits: {max_model_calls: 3}}, {coding_template: 'Do {description}'}, {task_instructions: 'Other steps'}]) {
      assert.notEqual(published(extra).digest, first.digest, JSON.stringify(extra));
    }
    assert.equal(published({limits: {internet_access: false}}).limits.internet_access, false);
  });

  it('reads limits from a body whose numbers keep their spelling, and pins the defaults for what is null', () => {
    const body = parseJson(JSON.stringify(publication({limits: {max_cost_usd: null, cpus: 0.5}})).replace('"cpus":0.5', '"cpus":0.50'));
    const made = benchmarkPublication(body);
    assert.deepEqual([made.limits.cpus, made.limits.max_cost_usd], [0.5, DEFAULT_LIMITS.max_cost_usd]);
  });

  it('pins both prompts as text: the defaults when none is given, normalized text otherwise', () => {
    const made = published();
    assert.deepEqual([made.coding_template, made.task_instructions], [DEFAULT_CODING_TEMPLATE, 'Add them']);
    const own = published({coding_template: 'a\r\nb {description}', task_instructions: 'Use\r\nread'});
    assert.deepEqual([own.coding_template, own.task_instructions], ['a\nb {description}', 'Use\nread']);
    assert.throws(() => published({coding_template: '{bogus}'}), {code: 'invalid_template'});
    assert.throws(() => published({coding_template: ' '}), {code: 'empty_template'});
    assert.throws(() => published({task_instructions: ''}), {code: 'empty_instructions'});
  });

  it('refuses an object key of digits only in what a prompt prints, which JavaScript would reorder', () => {
    for (const mutate of [body => { body.cases[0].arguments = {'2': 1, a: 2}; }, body => { body.task.input_schema = {properties: {'10': {}}}; }]) {
      assert.throws(() => published({}, mutate), {code: 'unsupported_key'});
    }
    assert.doesNotThrow(() => published({}, body => { body.cases[0].arguments = {x: 1, '007': 2, '-1': 3}; }));
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
    refused(body => { delete body.model; });
    refused(body => { delete body.endpoint_profile; });
    refused(body => { body.limits = {nope: 1}; });
    refused(body => { body.limits = {memory_mb: 0}; });
  });
});

const capabilities = {...DEFAULT_LIMITS, concurrency: 8, models: ['vendor/model']};

describe('benchmark run resolution', () => {
  it('renders every case of the benchmark under the coding policy with its pinned template, pinning prompt text, model and limits', () => {
    const {plan, cases, digest} = resolve({benchmark: benchmarkFor(), policy: 'coding', capabilities});
    assert.deepEqual(cases.map(c => c.case_id), ['a1', 'r1', 'a2', 'r2']);
    assert.deepEqual([plan.prompt.source, plan.prompt.text, plan.policy, plan.model, plan.endpoint_profile], ['benchmark', DEFAULT_CODING_TEMPLATE, 'coding', 'vendor/model', 'mock']);
    assert.equal(cases[0].prompt.user, renderCoding(DEFAULT_CODING_TEMPLATE, {task: TASK, context: 'Numbers only', args: {x: 1}}).user);
    assert.equal(cases[0].prompt.system, null);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(plan.limits, DEFAULT_LIMITS);
    assert.equal(plan.egress_hosts, null, 'no tool container under coding');
  });

  it('renders the benchmark\'s own template', () => {
    const benchmark = benchmarkFor(publication({coding_template: 'Do {description}: {arguments}'}));
    const {cases} = resolve({benchmark, policy: 'coding', capabilities});
    assert.equal(cases[0].prompt.user, 'Do Sum: {\n  "x": 1\n}');
  });

  it('renders the task tools policy from the benchmark\'s instructions', () => {
    const byDefault = resolve({benchmark: benchmarkFor(), policy: 'task_tools', capabilities});
    assert.equal(byDefault.plan.prompt.text, 'Add them');
    assert.deepEqual(byDefault.plan.egress_hosts, ['api.example.com']);
    assert.equal(byDefault.cases[0].prompt.user, 'Task input:\n{\n  "x": 1\n}');
    const custom = resolve({benchmark: benchmarkFor(publication({task_instructions: 'Use read'})), policy: 'task_tools', capabilities});
    assert.match(custom.cases[0].prompt.system, /Task: Sum\.\nUse read\n\nWhen the task is done, call submit with its result\.$/);
  });

  it('puts the whole decide prompt in the system message', () => {
    const {cases} = resolve({benchmark: benchmarkFor(publication({task: {...TASK, kind: 'decide'}})), policy: 'task_tools', capabilities});
    assert.equal(cases[0].prompt.user, null);
    assert.match(cases[0].prompt.system, /^You decide one task worked with the Plugin P plugin's tools\./);
  });

  it('refuses limits beyond the workers\' and an endpoint no worker advertised for', () => {
    const big = benchmarkFor(publication({limits: {memory_mb: 4096}}));
    assert.throws(() => resolve({benchmark: big, policy: 'coding', capabilities}), {code: 'limit_exceeds_worker'});
    assert.throws(() => resolve({benchmark: benchmarkFor(), policy: 'coding', capabilities: null}), {code: 'worker_unavailable', status: 409});
    assert.throws(() => checkWorkers(DEFAULT_LIMITS, 'vendor/model', {...capabilities, internet_access: false}, 'mock'), {code: 'limit_exceeds_worker'});
    assert.doesNotThrow(() => checkWorkers({...DEFAULT_LIMITS, memory_mb: 512}, 'vendor/model', capabilities, 'mock'));
  });

  it('refuses a model no worker of the endpoint prices, naming what they price', () => {
    const unpriced = benchmarkFor(publication({model: 'other/model'}));
    assert.throws(() => resolve({benchmark: unpriced, policy: 'coding', capabilities}), {code: 'unknown_model', status: 400, extra: {model: 'other/model', models: ['vendor/model']}});
    assert.throws(() => checkWorkers(DEFAULT_LIMITS, 'other/model', capabilities, 'mock'), {code: 'unknown_model', message: /vendor\/model/});
  });

  it('digests a plan from what it pins, so a changed prompt or policy is stale', () => {
    const base = resolve({benchmark: benchmarkFor(), policy: 'coding', capabilities});
    assert.equal(resolve({benchmark: benchmarkFor(), policy: 'coding', capabilities}).digest, base.digest);
    const other = resolve({benchmark: benchmarkFor(), policy: 'task_tools', capabilities});
    assert.notEqual(other.digest, base.digest);
    assert.deepEqual(changedParts(base.plan, other.plan).sort(), ['cases', 'egress_hosts', 'policy', 'prompt']);
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

  it('takes exactly a benchmark and a policy to preview, and refuses anything else', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    assert.deepEqual(previewBody({benchmark_id: id, policy: 'task_tools'}), {benchmark_id: id, policy: 'task_tools'});
    for (const extra of [{model: 'm'}, {limits: {}}, {dialects: ['responses']}, {prompt: {}}, {endpoint_profile: 'mock'}, {selection: {}}]) {
      assert.throws(() => previewBody({benchmark_id: id, policy: 'coding', ...extra}), {code: 'invalid_request'});
    }
    assert.throws(() => previewBody({benchmark_id: 'x', policy: 'coding'}), {code: 'invalid_request'});
    assert.throws(() => previewBody({benchmark_id: id, policy: 'other'}), {code: 'invalid_request'});
    assert.throws(() => previewBody({policy: 'coding'}), {code: 'invalid_request'});
  });

  it('digests a run request independent of key order, and wants all five fields and no other', () => {
    const body = {
      benchmark_id: '00000000-0000-4000-8000-000000000001', policy: 'coding', idempotency_key: 'k', preview_id: '00000000-0000-4000-8000-000000000000', source_sha256: 'a'.repeat(64),
    };
    assert.equal(runBody(body).request_digest, runBody({...Object.fromEntries(Object.entries(body).reverse())}).request_digest);
    assert.notEqual(runBody({...body, policy: 'task_tools'}).request_digest, runBody(body).request_digest);
    for (const field of Object.keys(body)) assert.throws(() => runBody({...body, [field]: undefined}), {code: 'invalid_request'}, field);
    for (const extra of [{model: 'm'}, {dialects: ['responses']}, {limits: {}}]) assert.throws(() => runBody({...body, ...extra}), {code: 'invalid_request'});
  });
});
