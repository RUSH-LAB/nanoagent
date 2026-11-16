import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {harnessInstructions} from '../../../../src/components/Benchmark/harnessInstructions.js';
import {benchmarkCard, harnessFacts} from '../../../../src/components/Benchmark/newRun.js';
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

  it('shows the worker limits a benchmark is over', () => {
    assert.deepEqual(describeError(Object.assign(new Error('Too much'), {details: {code: 'limit_exceeds_worker', exceeded: [{field: 'max_cost_usd', limit: 2, max: 1}, {field: 'internet_access', limit: true, max: false}]}})),
      {message: 'Too much', lines: ['Cost (USD): 2 is above the worker\'s 1', 'Internet access: true is above the worker\'s false']});
    assert.deepEqual(describeError(new Error('plain')), {message: 'plain', lines: []});
  });


});
