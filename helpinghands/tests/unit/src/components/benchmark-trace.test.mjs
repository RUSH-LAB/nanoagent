import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {barOf, buildTrace, causalChain, causalFrom, filterRows, keepSelection, parallelWith, spanTiming, transcriptOf, waitsOf, EMPTY_FILTERS} from '../../../../src/components/Benchmark/traceModel.js';
import {describeSpan, payloadView, tokenClasses} from '../../../../src/components/Benchmark/inspector.js';
import {traceMessages} from '../../../../src/components/Benchmark/traceMessages.js';

const S = 1_000_000_000n;
const at = seconds => String(1_700_000_000n * S + BigInt(Math.round(seconds * 1000)) * (S / 1000n));
const span = (id, kind, parent, start, end, extra = {}) => ({id, kind, name: id, parent, scope: 'agent', status: 'ok', start_ns: at(start), end_ns: at(end), provenance: 'observed', target: null, attributes: {}, ...extra});

// Setup, then an 8 s model call m1 with a 5 s local command c1 in parallel, a proposal p1 that became tool t1.
const spans = [
  span('root', 'attempt', null, 0, 9),
  span('phase:harness', 'phase', 'root', 0.1, 8.4),
  span('m:m1', 'model_call', 'phase:harness', 0.1, 8.1, {attributes: {usage: {input: 400, output: 200, total: 600, cache_read: 0, cache_write: null, reasoning: null}}}),
  span('m:m1/call_1', 'proposal', 'm:m1', 8.1, 8.1, {name: 'validate'}),
  span('c:r1', 'command', 'phase:harness', 0.2, 5.2, {attributes: {argv: ['go', 'test', './pkg']}}),
  span('t:t1', 'tool', 'phase:harness', 8.2, 8.3, {name: 'validate', attributes: {adapted: true}}),
  span('h:sub', 'subagent', 'phase:harness', 1, 2, {provenance: 'harness_reported', scope: 'agent/sub'}),
  span('c:r2', 'command', 'phase:harness', 6, 7, {status: 'error'}),
];
const links = [
  {kind: 'proposal_invocation', from: 'm:m1/call_1', to: 't:t1', method: 'broker_cause', attributes: {}},
  {kind: 'result_delivery', from: 't:t1', to: 'm:m2', method: 'tool_result_call_id', attributes: {}},
  {kind: 'containment', from: 'x', to: 'y', method: 'tree', attributes: {}},
];

const model = buildTrace({spans, links});

describe('benchmark trace model', () => {

  it('leaves out the attempt span and the workspace snapshot, so the timeline is the harness phase alone', () => {
    const snapshotted = buildTrace({spans: [...spans, span('snapshot', 'snapshot', 'root', 8.6, 8.6)], links});
    assert.equal(snapshotted.byId.has('root'), false);
    assert.equal(snapshotted.byId.has('snapshot'), false);
    assert.deepEqual(snapshotted.window, {start: BigInt(at(0.1)), end: BigInt(at(8.4))});
  });

  it('nests the spans as tree rows in time order and places each bar in the window', () => {
    assert.deepEqual(model.rows.map(row => [row.id, row.depth]).slice(0, 4), [['phase:harness', 0], ['m:m1', 1], ['m:m1/call_1', 2], ['c:r1', 1]]);
    assert.deepEqual(barOf(model, model.byId.get('m:m1')), {left: 0, width: 96.385});
    assert.equal(barOf(model, {start_ns: null, end_ns: null}), null);
    assert.deepEqual(barOf(buildTrace({spans: [span('only', 'phase', null, 1, 1)]}), span('only', 'phase', null, 1, 1)), {left: 0, width: 100});
  });

  it('orders the transcript: model call, proposal, tools and commands, not structure', () => {
    assert.deepEqual(transcriptOf(model).map(item => item.id), ['m:m1', 'c:r1', 'c:r2', 'm:m1/call_1', 't:t1']);
  });

  it('shows elapsed time relative to the trace and distinguishes unfinished and untimed events', () => {
    assert.deepEqual(spanTiming(model, model.byId.get('m:m1')), {offset: 0, duration: 8000});
    assert.deepEqual(spanTiming(model, {start_ns: at(1), end_ns: null}), {offset: 900, duration: null});
    assert.equal(spanTiming(model, {start_ns: null}), null);
  });

  it('uses the same elapsed-time scale for timelines with different starts and lengths', () => {
    const shorter = buildTrace({spans: [span('other-start', 'phase', null, 20, 24), span('other', 'tool', 'other-start', 21, 23)]});
    assert.deepEqual(barOf(shorter, shorter.byId.get('other'), 10n * S), {left: 10, width: 20});
    assert.deepEqual(barOf(model, model.byId.get('m:m1'), 10n * S), {left: 0, width: 80});
  });

  it('marks the upstream wait and the local work that overlaps it, and nothing else', () => {
    const waits = waitsOf(model);
    assert.deepEqual([...waits.upstream], ['m:m1']);
    assert.deepEqual([...waits.overlapping.entries()], [['c:r1', ['m:m1']], ['c:r2', ['m:m1']]]);
    // t1 ran after the wait ended, so it does not overlap it.
    assert.equal(waits.overlapping.has('t:t1'), false);
  });

  it('finds parallel calls of the same kind and scope that overlap in time', () => {
    const parallel = buildTrace({spans: [span('a', 'tool', null, 0, 2), span('b', 'tool', null, 1, 3), span('c', 'tool', null, 3, 4), span('d', 'tool', null, 1, 3, {scope: 'agent/sub'})]});
    assert.deepEqual(parallelWith(parallel, 'a').map(item => item.id), ['b']);
  });

  it('follows causal links from a proposal to its invocation, and ignores other link kinds and links to unknown spans', () => {
    assert.deepEqual(causalFrom(model, 'm:m1/call_1').map(({otherId, direction}) => [otherId, direction]), [['t:t1', 'out']]);
    assert.deepEqual(causalFrom(model, 't:t1').map(({otherId, direction}) => [otherId, direction]), [['m:m1/call_1', 'in']]);
    assert.deepEqual([...causalChain(model, 't:t1')].sort(), ['m:m1/call_1', 't:t1']);
  });

  it('filters by kind, error, agent, provenance and text, keeping the ancestors of a match as context', () => {
    assert.equal(filterRows(model, EMPTY_FILTERS).length, spans.length - 1);
    const errors = filterRows(model, {...EMPTY_FILTERS, errorsOnly: true});
    assert.deepEqual(errors.map(row => [row.id, row.context]), [['phase:harness', true], ['c:r2', false]]);
    assert.deepEqual(filterRows(model, {...EMPTY_FILTERS, scope: 'agent/sub'}).filter(row => !row.context).map(row => row.id), ['h:sub']);
    assert.deepEqual(filterRows(model, {...EMPTY_FILTERS, provenance: 'harness_reported'}).filter(row => !row.context).map(row => row.id), ['h:sub']);
    assert.deepEqual(filterRows(model, {...EMPTY_FILTERS, kind: 'tool', q: 'VALIDATE'}).filter(row => !row.context).map(row => row.id), ['t:t1']);
    assert.deepEqual(filterRows(model, {...EMPTY_FILTERS, q: 'nothing like this'}), []);
  });

  it('keeps the selection while a later read still has the span, and clears it when the span is gone', () => {
    const later = buildTrace({spans: [...spans, span('c:r3', 'command', 'phase:harness', 8.5, 8.9)], links});
    assert.equal(keepSelection(later, 't:t1'), 't:t1');
    assert.equal(keepSelection(buildTrace({spans: spans.slice(0, 2)}), 't:t1'), null);
    assert.equal(keepSelection(later, null), null);
  });

  it('survives a span whose parent is itself or missing', () => {
    const odd = buildTrace({spans: [span('a', 'tool', 'a', 0, 1), span('b', 'tool', 'ghost', 0, 1)]});
    assert.deepEqual(odd.rows.map(row => row.id), ['a', 'b']);
  });
});

describe('benchmark inspector', () => {
  it('shows recorded model inputs, tool calls and streamed text alongside the raw payload', () => {
    const call = {choices: [{message: {content: null, tool_calls: [{function: {name: 'lookup', arguments: '{"id":1}'}}]}}]};
    assert.deepEqual(traceMessages(JSON.stringify(call), {dialect: 'chat_completions', response: true}), [{role: 'Tool call · lookup', text: '{"id":1}'}]);
    const request = {system: [{type: 'text', text: 'Rules'}], messages: [{role: 'user', content: 'Question'}]};
    assert.deepEqual(traceMessages(JSON.stringify(request), {dialect: 'anthropic_messages'}), [{role: 'system', text: 'Rules'}, {role: 'user', text: 'Question'}]);
    const response = ['hello', ' world'].map(delta => `data: ${JSON.stringify({type: 'response.output_text.delta', output_index: 0, delta})}\r\n\r\n`).join('');
    assert.deepEqual(traceMessages(response, {dialect: 'responses', response: true, stream: true}), [{role: 'assistant', text: 'hello world'}]);
    assert.deepEqual(traceMessages('non-JSON bytes', {dialect: 'chat_completions', response: true}), []);
  });
  it('shows a proposal and its observed invocation apart, with adaptation marked', () => {
    const tool = describeSpan(span('t', 'tool', null, 0, 1, {name: 'validate', attributes: {adapted: true, cause: {model_call_id: 'm1'}, arguments_sha256: 'a'.repeat(64), output_sha256: 'b'.repeat(64)}}));
    assert.equal(tool.title, 'Invocation: validate');
    assert.ok(tool.facts.some(fact => fact.label === 'Adapted from its proposal' && fact.value === 'true'));
    assert.deepEqual(tool.payloads.map(item => item.label), ['Observed arguments', 'Result']);
    assert.equal(describeSpan(span('p', 'proposal', null, 0, 0, {name: 'validate', attributes: {arguments: {path: 'x'}}})).title, 'Proposal: validate');
  });

  it('shows a command\'s argv, exit evidence and streams with their truncation', () => {
    const command = describeSpan(span('c', 'command', null, 0, 1, {attributes: {argv: ['go', 'test'], cwd: '/w', termination: {exit_code: 1}, stdout_sha256: 'a'.repeat(64), stderr_sha256: 'b'.repeat(64), stderr_truncated: true}}));
    assert.equal(command.title, 'Command: go test');
    assert.deepEqual(command.inline.map(item => item.label), ['argv', 'Exit']);
    assert.deepEqual(command.payloads.map(item => [item.label, item.note]), [['stdout', null], ['stderr', 'truncated']]);
  });

  it('lists a model call\'s token classes with Unknown for what it did not report, and labels harness-reported provenance', () => {
    const call = describeSpan(model.byId.get('m:m1'));
    assert.deepEqual(call.tokens.map(row => [row.label, row.value]), [['Input', 400], ['Output', 200], ['Total', 600], ['Cache read', 0], ['Cache write', null], ['Reasoning', null]]);
    assert.deepEqual(tokenClasses(null), []);
    const sub = describeSpan(model.byId.get('h:sub'));
    assert.match(sub.facts.find(fact => fact.label === 'Provenance').value, /the harness said so/);
  });

  it('shows a payload as text, pretty-printing JSON, cutting very large ones, and never as markup', () => {
    assert.equal(payloadView('{"a":1}').text, '{\n  "a": 1\n}');
    assert.equal(payloadView('<script>alert(1)</script>').text, '<script>alert(1)</script>');
    const big = payloadView('x'.repeat(250_000), 'truncated');
    assert.deepEqual([big.text.length, big.cut, big.redaction, big.length], [200_000, true, 'truncated', 250_000]);
  });
});
