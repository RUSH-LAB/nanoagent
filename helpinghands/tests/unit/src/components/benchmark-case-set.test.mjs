import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {caseSetView} from '../../../../src/components/Benchmark/caseSet.js';

const detail = {
  benchmark_id: 'b1', name: 'bench', task_id: 'sum', task_kind: 'agent', context: '  Units are metres.\n',
  task: {kind: 'agent', description: 'Add two numbers.', instructions: 'Add.'},
  cases: [
    {case_id: 'r1', position: 1, kind: 'refuse', arguments: {a: -1, b: 3}, expected_error: 'operands must be nonnegative', content_digest: 'd2'},
    {case_id: 'c1', position: 0, kind: 'answer', arguments: {a: 19, b: 23}, expected_error: null, content_digest: 'd1'},
  ],
};

describe('benchmark case set view', () => {
  it('shows the task, the context and each case\'s kind, input and expected error in the case set\'s order', () => {
    assert.deepEqual(caseSetView(detail), {
      task: {id: 'sum', kind: 'agent', description: 'Add two numbers.'},
      context: 'Units are metres.',
      cases: [
        {id: 'c1', kind: 'Answer', input: '{\n  "a": 19,\n  "b": 23\n}', expectedError: null},
        {id: 'r1', kind: 'Refuse', input: '{\n  "a": -1,\n  "b": 3\n}', expectedError: 'operands must be nonnegative'},
      ],
    });
  });

  it('shows no context as empty, a missing task as the summary\'s kind, and never a private reference', () => {
    const view = caseSetView({...detail, context: '', task: undefined, cases: [{...detail.cases[1], reference: 'secret', private: {c1: 1}}]});
    assert.equal(view.context, '');
    assert.deepEqual(view.task, {id: 'sum', kind: 'agent', description: ''});
    assert.doesNotMatch(JSON.stringify(view), /secret|private|reference/);
  });
});
