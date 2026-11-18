import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {attemptsComparable, caseOutcomeChanged, orderedCases, configRows, costText, diffChanged, diffLines, egressSides, fieldLabel, latencyText, pairedVerdicts, sideCells, tokensText, valueText} from '../../../../src/components/Benchmark/runCompare.js';

const config = [
  {field: 'case_set_id', a: 'cs@u', b: 'cs@u', differs: false},
  {field: 'case_set_digest', a: 'a'.repeat(64), b: 'b'.repeat(64), differs: true},
  {field: 'policy', a: 'coding', b: 'task_tools', differs: true},
  {field: 'model', a: 'm', b: 'm', differs: false},
  {field: 'limits.internet_access', a: true, b: false, differs: true},
  {field: 'limits.max_cost_usd', a: 0.1, b: 0.1, differs: false},
  {field: 'egress_hosts', a: null, b: ['x.com', 'y.com'], differs: true},
  {field: 'selection', a: ['c1', 'c2'], b: ['c1'], differs: true},
];
const side = (over = {}) => ({case_id: 'c1', attempt_id: 'att', outcome: 'answered', execution_reason: null, verdict: 'pass', explanation: null, verifier_error: null, tokens: {total: 1234, input: 1000, output: 234}, cost_usd: 0.000123456, uncertain_cost: false, latency_ms: 4200, ...over});

describe('run comparison display', () => {
  it('labels each setting, writes each value for people, and says where egress does not apply', () => {
    assert.deepEqual(['policy', 'limits.max_cost_usd', 'limits.internet_access', 'prompt_source', 'novel'].map(fieldLabel), ['Participant policy', 'Cost (USD)', 'Internet access', 'Prompt source', 'novel']);
    assert.equal(valueText('egress_hosts', null), 'Not applicable (coding)');
    assert.equal(valueText('egress_hosts', []), 'None');
    assert.equal(valueText('egress_hosts', ['x.com', 'y.com']), 'x.com, y.com');
    assert.equal(valueText('limits.internet_access', true), 'on');
    assert.equal(valueText('policy', 'task_tools'), 'Task tools');
    assert.equal(valueText('case_set_digest', 'a'.repeat(64)), 'a'.repeat(12));
    assert.equal(valueText('selection', ['c1', 'c2']), 'c1, c2');
  });

  it('lists the differing settings first, or only those, each group in the server\'s order', () => {
    assert.deepEqual(configRows(config).map(row => row.field), ['case_set_digest', 'policy', 'limits.internet_access', 'egress_hosts', 'selection', 'case_set_id', 'model', 'limits.max_cost_usd']);
    assert.deepEqual(configRows(config, true).map(row => row.field), ['case_set_digest', 'policy', 'limits.internet_access', 'egress_hosts', 'selection']);
    assert.ok(configRows(config, true).every(row => row.differs));
  });

  it('marks a prompt diff as the lines of a unified diff, and says when nothing changed', () => {
    const parts = [{type: 'same', text: 'one\n'}, {type: 'removed', text: 'two\nthree\n'}, {type: 'added', text: 'four'}, {type: 'same', text: ''}];
    assert.deepEqual(diffLines(parts).map(item => item.line), ['  one', '- two', '- three', '+ four']);
    assert.equal(diffChanged(parts), true);
    assert.equal(diffChanged([{type: 'same', text: 'x'}]), false);
    assert.equal(diffChanged(undefined), false);
    assert.deepEqual(diffLines(undefined), []);
  });

  it('reads one side of a shared case: outcome, verdict with its explanation, tokens, cost and latency', () => {
    assert.deepEqual(sideCells(side()), {outcome: 'Answered', verdict: 'Pass', explanation: '', tokens: '1,234', cost: '$0.000123', latency: '4,200 ms'});
    const failed = sideCells(side({outcome: 'refused', verdict: 'fail', explanation: 'refused_answer_case'}));
    assert.deepEqual([failed.outcome, failed.verdict, failed.explanation], ['Refused', 'Fail', 'The harness refused a case that has an answer.']);
    assert.equal(sideCells(side({verdict: null, verifier_error: 'crash'})).verdict, 'Verifier error');
  });

  it('never shows an unsettled cost as zero', () => {
    assert.equal(costText(side({cost_usd: null})), 'Unknown');
    assert.equal(costText(side({cost_usd: null, uncertain_cost: true})), 'Uncertain');
    assert.equal(costText(side({cost_usd: 0.05, uncertain_cost: true})), '$0.05 (uncertain)');
    assert.equal(latencyText(side({latency_ms: null})), 'Unknown');
    assert.equal(tokensText(side({tokens: {total: null}})), 'Unknown');
  });

  it('offers the action-by-action comparison only when both attempts are finished', () => {
    assert.equal(attemptsComparable({a: side(), b: side({attempt_id: 'b'})}), true);
    assert.equal(attemptsComparable({a: side(), b: side({outcome: 'leased'})}), false);
    assert.equal(attemptsComparable({a: side(), b: side({outcome: 'queued'})}), false);
    assert.equal(attemptsComparable({a: side({attempt_id: null}), b: side()}), false);
  });

  it('brings changed case outcomes forward without losing the original order', () => {
    const same = {a: side(), b: side()};
    const changed = {a: side(), b: side({verdict: 'fail'})};
    const unknown = {a: side({verdict: null}), b: side({verdict: null})};
    assert.equal(caseOutcomeChanged(changed), true);
    assert.equal(caseOutcomeChanged(same), false);
    assert.deepEqual(orderedCases([same, changed, unknown]), [changed, same, unknown]);
  });

  it('names the runs whose internet access makes their egress unverified', () => {
    assert.deepEqual(egressSides({a: true, b: false}), ['A']);
    assert.deepEqual(egressSides({a: true, b: true}), ['A', 'B']);
    assert.deepEqual(egressSides({a: false, b: false}), []);
  });

  it('counts paired pass and fail verdicts without treating unknown outcomes as failures', () => {
    const cases = [['pass', 'pass'], ['pass', 'fail'], ['fail', 'pass'], ['fail', 'fail'], [null, 'fail'], ['pass', null]]
      .map(([a, b]) => ({a: side({verdict: a}), b: side({verdict: b})}));
    assert.deepEqual(pairedVerdicts(cases), {bothPassed: 1, onlyAPassed: 1, onlyBPassed: 1, bothFailed: 1, unpaired: 2});
  });
});
