import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {previewCaseFile, validBenchmarkName} from '../../../../src/components/Benchmarks/caseFolder.js';

const plugin = {id: 'sample', tasks: [{id: 'check'}]};
const yaml = `plugin: sample
task: check
cases:
  - prompt: Check file
    arguments: {file: data.csv}
    fixtures: fixtures/a
refuse:
  - prompt: Refuse input
    arguments: {file: bad}
    reference_error: invalid
`;

describe('case folder review', () => {
  it('shows ordered IDs, kinds, task, prompts and the actual files of each fixture', () => {
    const review = previewCaseFile(yaml, plugin, ['fixtures/a/data.csv', 'fixtures/ab/other.csv']);
    assert.equal(review.task, 'check');
    assert.deepEqual(review.cases.map(c => [c.case_id, c.kind, c.prompt, c.fixtureFiles]), [
      ['sample-01', 'answer', 'Check file', ['fixtures/a/data.csv']],
      ['sample-02', 'refuse', 'Refuse input', []],
    ]);
    assert.equal(review.cases[1].expected_error, 'invalid');
  });

  it('rejects malformed YAML, unknown tasks and missing fixtures before review', () => {
    assert.throws(() => previewCaseFile(yaml.replace(/refuse:[\s\S]*/, ''), plugin, []), /must have cases and refuse lists/);
    assert.throws(() => previewCaseFile('cases: [', plugin, []), /not valid YAML/);
    assert.throws(() => previewCaseFile(yaml.replace('task: check', 'task: other'), plugin, []), /Unknown task/);
    assert.throws(() => previewCaseFile(yaml, plugin, ['fixtures/ab/data.csv']), /fixture folder fixtures\/a has no uploaded files/);
    assert.throws(() => previewCaseFile(yaml.replace('arguments: {file: bad}', 'arguments: bad'), plugin, ['fixtures/a/data.csv']), /sample-02 needs a prompt and an arguments mapping/);
  });
});


describe('benchmark names', () => {
  it('accepts the publisher name format and length only', () => {
    for (const name of ['a', '0', 'a.b_c-d', 'a'.repeat(128)]) assert.equal(validBenchmarkName(name), true);
    for (const name of ['', '-a', '.a', 'A', 'a b', 'a'.repeat(129)]) assert.equal(validBenchmarkName(name), false);
  });
});
