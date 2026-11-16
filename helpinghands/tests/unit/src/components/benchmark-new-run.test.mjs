import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {harnessInstructions} from '../../../../src/components/Benchmark/harnessInstructions.js';
import {benchmarkCard, benchmarkGroups, egressText, harnessFacts, keyFor, previewBody, runBody, stalePart, staleReport} from '../../../../src/components/Benchmark/newRun.js';
import {describeError} from '../../../../src/components/Benchmark/publish.js';

const benchmark = (id, version, over = {}) => ({
  benchmark_id: id, name: `bench-${id}`, plugin: {id: 'p', name: 'P', version}, task_id: 'sum', task_kind: 'agent', publisher: {id: 'u1', name: 'Una', github: 'una'},
  model: 'vendor/model', case_count: 4, answer_count: 3, refuse_count: 1, run_count: 4, runner_count: 2, ...over,
});

describe('benchmark new run', () => {
  it('puts the selected task schemas in the harness instructions without the benchmark cases', () => {
    const generic = harnessInstructions();
    const detail = {name: 'b', plugin: {id: 'p', version: '1.0.0'}, task_id: 't', context: 'ctx', task: {input_schema: {required: ['selectedInput']}, output_schema: {required: ['selectedOutput']}}, cases: [{case_id: 'case-not-for-instructions'}]};
    const text = harnessInstructions(detail);
    assert.ok(text.endsWith(generic));
    assert.match(text, /selectedInput/);
    assert.match(text, /selectedOutput/);
    assert.doesNotMatch(text, /case-not-for-instructions/);
  });

  it('describes a benchmark on its card: name, task, creator, cases, model, runs and runners', () => {
    assert.deepEqual(benchmarkCard(benchmark('b1', '1.0.0')), {
      id: 'b1', name: 'bench-b1', task: 'sum', creator: 'Una (@una)', cases: '4 cases (3 answer, 1 refuse)', model: 'vendor/model', runs: '4 runs', runners: '2 runners',
    });
    const one = benchmarkCard(benchmark('b2', '1.0.0', {case_count: 1, answer_count: 1, refuse_count: 0, run_count: 1, runner_count: 1, publisher: {id: 'u2', name: 'Vic', github: null}}));
    assert.deepEqual([one.cases, one.runs, one.runners, one.creator], ['1 case (1 answer, 0 refuse)', '1 run', '1 runner', 'Vic']);
  });

  it('groups the cards by plugin version, the installed version first and the others as given', () => {
    const list = [benchmark('a', '0.3.0'), benchmark('b', '0.2.0'), benchmark('c', '0.3.0'), benchmark('d', '0.1.0')];
    const groups = benchmarkGroups(list, '0.2.0');
    assert.deepEqual(groups.map(group => [group.version, group.installed, group.cards.map(card => card.id)]), [
      ['0.2.0', true, ['b']], ['0.3.0', false, ['a', 'c']], ['0.1.0', false, ['d']],
    ]);
    assert.deepEqual(benchmarkGroups(list, '0.9.0').map(group => group.version), ['0.3.0', '0.2.0', '0.1.0']);
    assert.deepEqual(benchmarkGroups([], '0.2.0'), []);
  });

  it('previews a benchmark under a policy and nothing else, and names what is missing', () => {
    assert.deepEqual(previewBody({benchmarkId: 'b1', policy: 'coding'}), {body: {benchmark_id: 'b1', policy: 'coding'}});
    assert.equal(previewBody({benchmarkId: '', policy: 'coding'}).error, 'Choose a benchmark');
  });

  it('builds the run request from the preview\'s body, only policy and ZIP beside the benchmark, and names what is missing', () => {
    const setup = previewBody({benchmarkId: 'b1', policy: 'task_tools'}).body;
    const ready = {key: 'k', preview: 'p1', setup, source: 'sha'};
    assert.deepEqual(runBody(ready).body, {benchmark_id: 'b1', policy: 'task_tools', idempotency_key: 'k', preview_id: 'p1', source_sha256: 'sha'});
    assert.equal(runBody({...ready, setup: null}).error, 'Choose a benchmark first');
    assert.equal(runBody({...ready, source: undefined}).error, 'Upload a harness source ZIP or use a reference harness');
    assert.equal(runBody({...ready, preview: undefined}).error, 'Preview the run first');
  });

  it('echoes the harness identity the manifest declared', () => {
    assert.deepEqual(harnessFacts({source_sha256: 's', harness: {name: 'my-harness', version: '1.3', dialects: ['chat_completions', 'responses']}}),
      [['Name', 'my-harness'], ['Version', '1.3'], ['Dialects', 'chat_completions, responses']]);
  });

  it('shows a manifest refusal as the server worded it, and a taken harness version with what to do', () => {
    assert.deepEqual(describeError(Object.assign(new Error('harness.yaml is invalid: / must have required property name'), {details: {code: 'invalid_manifest'}})),
      {message: 'harness.yaml is invalid: / must have required property name', lines: []});
    const taken = describeError(Object.assign(new Error('x@2 is uploaded with different content'), {details: {code: 'harness_version_taken', harness: {name: 'x', version: '2'}, pinned_sha256: 'a'.repeat(64)}}));
    assert.deepEqual(taken.lines, ['x@2 was uploaded before with different content. Raise the version in harness.yaml.']);
  });

  it('keeps one idempotency key while the request is unchanged, and makes a new one when it changes', () => {
    let made = 0;
    const make = () => `key-${++made}`;
    const first = keyFor(null, {a: 1, idempotency_key: 'x'}, make);
    assert.equal(keyFor(first, {a: 1, idempotency_key: 'y'}, make), first);
    assert.equal(keyFor(first, {a: 2}, make).key, 'key-2');
  });

  it('reports a stale preview by the parts that changed, and anything else not at all', () => {
    const current = {cases: [{}], endpoint_profile: 'mock', policy: 'coding'};
    const report = staleReport({details: {code: 'stale_preview', stale: ['prompt', 'cases', 'novel'], current}});
    assert.deepEqual(report.stale, [{name: 'prompt', text: 'The prompt'}, {name: 'cases', text: 'The resolved cases'}, {name: 'novel', text: 'novel'}]);
    assert.equal(report.current, current);
    assert.equal(stalePart('benchmark_digest'), 'The benchmark');
    assert.equal(staleReport({details: {code: 'worker_unavailable'}}), null);
    assert.equal(staleReport(new Error('x')), null);
  });

  it('shows the worker limits a benchmark is over', () => {
    assert.deepEqual(describeError(Object.assign(new Error('Too much'), {details: {code: 'limit_exceeds_worker', exceeded: [{field: 'max_cost_usd', limit: 2, max: 1}, {field: 'internet_access', limit: true, max: false}]}})),
      {message: 'Too much', lines: ['Cost (USD): 2 is above the worker\'s 1', 'Internet access: true is above the worker\'s false']});
    assert.deepEqual(describeError(new Error('plain')), {message: 'plain', lines: []});
  });

  it('says what network a preview gives the tool container: its hosts, none, or not applicable under coding', () => {
    assert.equal(egressText({egress_hosts: null}), 'Not applicable: the coding policy has no tool container');
    assert.equal(egressText({egress_hosts: ['x.com', 'y.com']}), 'x.com, y.com');
    assert.equal(egressText({egress_hosts: []}), 'None');
  });
});
