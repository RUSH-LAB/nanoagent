import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {actionPayloads, conditionRows, deltaText, estimateText, fieldDiffs, isEqualRow, rowActionIds, rowTitle, visibleRows} from '../../../../src/components/Benchmark/compare.js';

const action = (id, kind, target, extra = {}) => ({action_id: id, kind, target, input: {}, output: {}, ...extra});
const same = (index, id = `m:${index}`) => ({index, status: 'same', a: [action(id, 'tool', 'read')], b: [action(id, 'tool', 'read')], input_diff: [], output_diff: [], status_diff: null, sequence_changed: false, concurrency_changed: false, duration_delta_ns: 5, token_delta: null, cost_delta: null});
const rows = [
  same(0),
  {...same(1), status: 'changed', input_diff: [{path: '$.argv[2]', a: './...', b: './pkg', a_present: true, b_present: true}]},
  {...same(2), status: 'only_b', a: []},
  {...same(3), output_diff: {unknown: 'output redacted'}},
  {...same(4), sequence_changed: true},
  {...same(5), token_delta: 12},
  {...same(6), token_delta: {unknown: 'usage not recorded'}},
];

describe('benchmark compare display', () => {
  it('counts a row as equal only when nothing differs and nothing is unknown', () => {
    assert.deepEqual(rows.map(isEqualRow), [true, false, false, false, false, false, true]);
  });

  it('reads the cost delta, a Decimal sent as text, by its value: "0.0000" is no difference', () => {
    assert.deepEqual([{...same(0), cost_delta: '0.0000'}, {...same(1), cost_delta: '0'}, {...same(2), cost_delta: '0.0012'}].map(isEqualRow), [true, true, false]);
  });

  it('Show differences collapses the equal rows, keeping each row\'s index in the full list', () => {
    assert.deepEqual(visibleRows(rows, true).map(row => row.index), [1, 2, 3, 4, 5]);
    assert.equal(visibleRows(rows, false).length, 7);
  });

  it('places First action difference in the visible list, and says when it is not shown or there is none', () => {
    const shown = visibleRows(rows, true);
  });

  it('titles a row by its action and finds the actions to mark in each timeline', () => {
    assert.equal(rowTitle(rows[2]), 'tool: read');
    assert.deepEqual(rowActionIds({a: [action('m:1', 'tool', 'x')], b: [action('m:2', 'tool', 'x'), action('m:3', 'tool', 'x')]}), {a: ['m:1'], b: ['m:2', 'm:3']});
  });

  it('lists flagged differences, then unknowns, before conditions that agree', () => {
    const header = {
      conditions_a: {model: 'm1', provider: null, dialect: 'chat_completions', coverage: 'complete', reference_tokens_per_second: 100},
      conditions_b: {model: 'm2', provider: 'p', dialect: 'chat_completions', coverage: 'complete', reference_tokens_per_second: 100},
      condition_differences: [{name: 'model'}], unknown_fields: ['provider'],
    };
    const list = conditionRows(header);
    assert.deepEqual(list.slice(0, 2).map(row => [row.name, row.state]), [['model', 'different'], ['provider', 'unknown']]);
    assert.equal(list.find(row => row.name === 'provider').a, 'Unknown');
    assert.ok(list.slice(2).every(row => row.state === 'same'));
  });

  it('reads the conditions: policy, internet access, egress hosts and limits as recorded', () => {
    const header = {
      conditions_a: {policy: 'coding', internet_access: true, egress_hosts: null, limits: [['max_model_calls', 50], ['wall_time_ms', 600000]]},
      conditions_b: {policy: 'task_tools', internet_access: false, egress_hosts: ['a.com', 'b.com'], limits: [['max_model_calls', 20]]},
      condition_differences: [{name: 'policy'}, {name: 'limits'}], unknown_fields: [],
    };
    const byName = Object.fromEntries(conditionRows(header).map(row => [row.name, row]));
    assert.deepEqual([byName.policy.a, byName.policy.b], ['coding', 'task_tools']);
    assert.deepEqual([byName.internet_access.a, byName.internet_access.b], ['true', 'false']);
    assert.deepEqual([byName.egress_hosts.a, byName.egress_hosts.b], ['Unknown', 'a.com, b.com']);
    assert.deepEqual([byName.limits.a, byName.limits.b], ['max_model_calls=50, wall_time_ms=600000', 'max_model_calls=20']);
    assert.deepEqual(conditionRows(header).slice(0, 2).map(row => row.name).sort(), ['limits', 'policy']);
    assert.equal(byName.budgets, undefined, 'budgets are limits now');
  });

  it('shows the estimate difference only under the same method, otherwise why it is withheld', () => {
    assert.equal(estimateText({estimate_withheld: 'reference rate differs', estimate_delta_ns: null}), 'Withheld: reference rate differs');
    assert.equal(estimateText({estimate_withheld: null, estimate_delta_ns: -1500000000}), '-1.500 s (B relative to A)');
    assert.equal(estimateText({estimate_withheld: null, estimate_delta_ns: null}), 'Unknown');
  });

  it('formats deltas and field-level differences, with Unknown for evidence that is missing', () => {
    assert.equal(deltaText(3), '+3');
    assert.equal(deltaText(-2500000, 'ms'), '-2.500 ms');
    assert.equal(deltaText({unknown: 'no usage'}), 'Unknown (no usage)');
    assert.equal(deltaText(null), '');
    assert.deepEqual(fieldDiffs([{path: '$.x', a: 1, b: null, a_present: true, b_present: false}]).fields, [{path: '$.x', a: '1', b: 'absent'}]);
    assert.equal(fieldDiffs({unknown: 'redacted'}).unknown, 'redacted');
  });

  it('finds the payloads an action records to open in an inspector', () => {
    const sha = 'a'.repeat(64);
    assert.deepEqual(actionPayloads(action('x', 'command', 'go', {input: {request_sha256: sha}, output: {stdout_sha256: sha, stderr_sha256: null}})).map(item => item.label), ['input request', 'output stdout']);
    assert.deepEqual(actionPayloads(null), []);
  });
});
