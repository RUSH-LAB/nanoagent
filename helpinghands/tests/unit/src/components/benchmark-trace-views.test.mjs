import {afterEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {actionSpans, buildTrace, traceErrors} from '../../../../src/components/BenchmarkTrace/traceModel.js';
import {packRows} from '../../../../src/components/BenchmarkTrace/packRows.js';
import {traceApi} from '../../../../src/components/BenchmarkTrace/api.js';
import {accountingCost} from '../../../../src/components/BenchmarkTrace/format.js';
import {replyPreview, transcriptRows} from '../../../../src/components/BenchmarkTrace/transcriptRows.js';

const S = 1_000_000_000n;
const at = seconds => String(1_700_000_000n * S + BigInt(Math.round(seconds * 1000)) * (S / 1000n));
const span = (id, kind, parent, start, end, extra = {}) => ({id, kind, name: id, parent, scope: 'agent', status: 'ok', start_ns: at(start), end_ns: at(end), provenance: 'observed', target: null, attributes: {}, ...extra});
const rowsOf = spans => Object.fromEntries(packRows(spans).bars.map(bar => [bar.span.id, bar.row]));

describe('timeline row packing', () => {
  it('moves bars up into the fewest rows they fit, and touching bars share a row', () => {
    assert.deepEqual(rowsOf([span('a', 'model_call', null, 0, 2), span('b', 'model_call', null, 1, 3), span('c', 'model_call', null, 2, 4), span('d', 'model_call', null, 3, 5)]), {a: 0, b: 1, c: 0, d: 1});
  });

  it('never puts a child above its parent, even where a higher row is free', () => {
    const rows = rowsOf([span('p', 'process', null, 0, 10), span('x', 'model_call', null, 0, 1), span('c', 'tool', 'p', 5, 6)]);
    assert.equal(rows.p, 0);
    assert.equal(rows.x, 1);
    assert.equal(rows.c, 1);
    assert.equal(rowsOf([span('q', 'process', null, 0, 1), span('k', 'tool', 'q', 5, 6)]).k, 1);
  });

  it('treats a span whose parent is missing or itself as a root, skips untimed spans, and survives cycles', () => {
    const untimed = span('u', 'tool', null, 0, 1, {start_ns: null, end_ns: null});
    const packed = packRows([span('a', 'tool', 'a', 0, 1), span('b', 'tool', 'ghost', 2, 3), untimed, span('c1', 'tool', 'c2', 4, 5), span('c2', 'tool', 'c1', 4, 5)]);
    assert.deepEqual(packed.bars.map(bar => bar.span.id).sort(), ['a', 'b', 'c1', 'c2']);
    assert.equal(packRows([]).rows, 0);
  });
});

describe('transcript rows', () => {
  const model = buildTrace({spans: [
    span('root', 'attempt', null, 0, 9),
    span('p:1', 'process', null, 0, 8, {attributes: {title: 'claude -p hi', argv: ['claude']}}),
    span('p:2', 'process', null, 1, 2, {attributes: {argv: ['python', 'x.py']}}),
    span('m:m1', 'model_call', 'p:1', 2, 4, {attributes: {call_id: 'm1', usage: {total: 600}}}),
    span('m:m1/call_1', 'proposal', 'm:m1', 4, 4),
    span('h:sub', 'subagent', 'p:1', 5, 6),
  ]});

  it('has one row per model call, proposal, tool, command and process in time order, named by title else argv', () => {
    const rows = transcriptRows(model);
    assert.deepEqual(rows.map(row => [row.id, row.name]), [['p:1', 'claude -p hi'], ['p:2', 'python x.py'], ['m:m1', 'm:m1'], ['m:m1/call_1', 'm:m1/call_1']]);
  });

  it('carries duration, tokens and cost, with null for what was not reported', () => {
    const [process, , call] = transcriptRows(model, new Map([['m1', 0.02]]));
    assert.deepEqual([call.duration, call.tokens, call.cost], [2000, 600, 0.02]);
    assert.deepEqual([process.tokens, process.cost], [null, null]);
  });

  it('previews a model call by the first line of its reply', () => {
    const reply = JSON.stringify({choices: [{message: {content: 'Done.\nMore text'}}]});
    assert.equal(replyPreview(reply, {dialect: 'chat_completions'}), 'Done.');
    assert.equal(replyPreview('not json', {dialect: 'chat_completions'}), '');
  });
});

describe('trace action visibility', () => {
  it('hides shell infrastructure and duplicate processes, keeping agent calls, nested work and failures', () => {
    const model = buildTrace({spans: [
      span('phase', 'phase', null, 0, 10),
      span('shell', 'process', 'phase', 0, 10, {attributes: {argv: ['python', '/harness/shell.py']}}),
      span('agent', 'process', 'shell', 0, 10),
      span('call', 'model_call', 'agent', 1, 8),
      span('command', 'command', 'agent', 2, 4),
      span('duplicate', 'process', 'command', 2, 4, {attributes: {linked_command: 'command'}}),
      span('work', 'process', 'agent', 3, 9),
      span('failure', 'process', 'agent', 4, 5, {status: 'error', attributes: {linked_command: 'command'}}),
    ]});
    assert.deepEqual(actionSpans(model).map(one => one.id), ['call', 'command', 'work', 'failure']);
    assert.deepEqual(transcriptRows(model).map(one => one.id), ['call', 'command', 'work', 'failure']);
    assert.ok(model.byId.has('shell'), 'raw evidence stays available for inspection');
  });

  it('does not hide a long-running leaf command or a standalone process', () => {
    const model = buildTrace({spans: [span('command', 'command', null, 0, 10), span('process', 'process', null, 0, 10)]});
    assert.deepEqual(actionSpans(model).map(one => one.id), ['command', 'process']);
  });

  it('omits the harness launched by shell.py but keeps its useful child commands', () => {
    const model = buildTrace({spans: [
      span('phase', 'phase', null, 0, 10),
      span('shell', 'process', 'phase', 0.01, 9.99, {attributes: {argv: ['python', '/harness/shell.py']}}),
      span('harness', 'process', 'shell', 0.05, 9.9, {attributes: {argv: ['codex', 'exec', 'the case prompt']}}),
      span('command', 'process', 'harness', 3, 4, {attributes: {argv: ['python', 'solve.py']}}),
      span('fork', 'process', 'command', 3, 3.1, {name: 'process 255'}),
    ]});
    assert.deepEqual(transcriptRows(model).map(one => one.name), ['python solve.py']);
  });
});

import {traceMessages} from '../../../../src/components/BenchmarkTrace/traceMessages.js';

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('data-shaped corrections', () => {
  it('draws an unfinished span to the end of the extent and takes the extent from the spans, not a session root', () => {
    const model = buildTrace({spans: [
      span('root', 'attempt', null, 0, 0.4, {status: 'partial'}),
      span('phase:harness', 'phase', 'root', 30, 30, {status: 'unfinished', end_ns: null}),
      span('proc', 'process_tree', 'phase:harness', 0, 0, {start_ns: null, end_ns: null}),
      span('m:1', 'model_call', 'phase:harness', 31, 33),
      span('p:1', 'process', 'phase:harness', 32, 32, {status: 'unfinished', end_ns: null}),
    ]});
    assert.deepEqual(model.window, {start: BigInt(at(30)), end: BigInt(at(33))});
    const bars = Object.fromEntries(packRows(model.spans.filter(s => s.kind !== 'phase'), model.window.end).bars.map(bar => [bar.span.id, bar.end]));
    assert.deepEqual(Object.keys(bars), ['m:1', 'p:1']);
    assert.equal(bars['p:1'], BigInt(at(33)));
  });

  it('joins cost from accounting by call_id and never reads it from usage', () => {
    const model = buildTrace({spans: [span('m:a', 'model_call', null, 0, 1, {attributes: {call_id: 'a', usage: {total: 5, cost_usd: 9}}}), span('m:b', 'model_call', null, 1, 2, {attributes: {call_id: 'b'}})]});
    assert.deepEqual(transcriptRows(model, new Map([['a', 0.01]])).map(row => row.cost), [0.01, null]);
  });

  it('parses a raw responses event stream for the messages and the preview, without being told it streamed', () => {
    const output = [{type: 'message', content: [{type: 'output_text', text: 'Splitting now.\nDone'}]}, {type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}'}];
    const sse = frame('response.created', {type: 'response.created', response: {id: 'r'}})
      + frame('response.output_text.delta', {type: 'response.output_text.delta', output_index: 0, delta: 'Splitting now.'})
      + frame('response.completed', {type: 'response.completed', response: {id: 'r', output}});
    assert.deepEqual(traceMessages(sse, {dialect: 'responses', response: true}), [{role: 'assistant', text: 'Splitting now.\nDone'}, {role: 'Tool call · exec_command', text: '{"cmd":"ls"}'}]);
    assert.equal(replyPreview(sse, {dialect: 'responses'}), 'Splitting now.');
    const deltasOnly = frame('response.output_text.delta', {type: 'response.output_text.delta', output_index: 0, delta: 'Hi'});
    assert.deepEqual(traceMessages(deltasOnly, {dialect: 'responses', response: true}), [{role: 'assistant', text: 'Hi'}]);
  });

  it('builds a model with no links, and no causal links to follow', async () => {
    const {causalFrom} = await import('../../../../src/components/BenchmarkTrace/traceModel.js');
    const model = buildTrace({spans: [span('m:1', 'model_call', null, 0, 1)], links: [{kind: 'process_lineage', from: 'x', to: 'y', method: 'clone', attributes: {}}]});
    assert.deepEqual(causalFrom(model, 'm:1'), []);
    assert.deepEqual(causalFrom(buildTrace({spans: [span('m:1', 'model_call', null, 0, 1)]}), 'm:1'), []);
  });
});

describe('streamed tool calls, as local model calls store them', () => {
  const data = payload => `data: ${JSON.stringify(payload)}\n\n`;

  // Trimmed from a stored anthropic_messages stream: a thinking block, a text block, then a tool_use block built from input_json_delta.
  it('renders an anthropic tool_use block from its input_json_delta pieces, and skips thinking', () => {
    const sse = frame('message_start', {type: 'message_start', message: {id: 'msg_1', content: []}})
      + frame('content_block_start', {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: '', signature: ''}})
      + frame('content_block_delta', {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'sqlite3 CLI may not be present'}})
      + frame('content_block_start', {type: 'content_block_start', index: 1, content_block: {type: 'text', text: '', citations: []}})
      + frame('content_block_delta', {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text: 'Python3 is available.'}})
      + frame('content_block_start', {type: 'content_block_start', index: 2, content_block: {type: 'tool_use', id: 'call_1', name: 'Write', input: {}}})
      + ['{', '"file_path": "/rush/workspace/build', '/build_f', 'ixtures.py', '"', '}'].map(partial_json => frame('content_block_delta', {type: 'content_block_delta', index: 2, delta: {type: 'input_json_delta', partial_json}})).join('')
      + frame('message_stop', {type: 'message_stop'});
    assert.deepEqual(traceMessages(sse, {dialect: 'anthropic_messages', response: true}), [
      {role: 'assistant', text: 'Python3 is available.'},
      {role: 'Tool call · Write', text: '{"file_path": "/rush/workspace/build/build_fixtures.py"}'},
    ]);
  });

  // Trimmed from a stored chat_completions stream: reasoning-only chunks, content chunks, then delta.tool_calls by index, then [DONE].
  it('accumulates chat-completions delta.tool_calls by index, and ignores reasoning chunks and [DONE]', () => {
    const chunk = delta => data({object: 'chat.completion.chunk', choices: [{index: 0, delta: {role: 'assistant', ...delta}, finish_reason: null}]});
    const sse = chunk({content: '', reasoning: 'Let me understand'})
      + chunk({content: "I'll start "}) + chunk({content: 'with a script.'})
      + chunk({content: null, tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: 'bash', arguments: ''}}]})
      + ['{', '"command": "cd', ' /rush', '/workspace"', '}'].map(args => chunk({content: null, tool_calls: [{index: 0, function: {arguments: args}}]})).join('')
      + chunk({content: null, tool_calls: [{index: 1, id: 'call_2', type: 'function', function: {name: 'read', arguments: '{"path":"a"}'}}]})
      + 'data: [DONE]\n\n';
    assert.deepEqual(traceMessages(sse, {dialect: 'chat_completions', response: true}), [
      {role: 'assistant', text: "I'll start with a script."},
      {role: 'Tool call · bash', text: '{"command": "cd /rush/workspace"}'},
      {role: 'Tool call · read', text: '{"path":"a"}'},
    ]);
    assert.equal(replyPreview(sse, {dialect: 'chat_completions'}), "I'll start with a script.");
  });
});

describe('trace cost', () => {
  const call = status => ({call_id: status, admission: {status, cost_usd: status === 'settled' ? 0.01 : null}});
  it('marks a cost with calls still reserved or uncertain as a lower bound, and never shows an unknown cost as a number', () => {
    assert.equal(accountingCost({totals: {settled_usd: 0.02}, calls: [call('settled'), call('settled')]}), '$0.02');
    assert.equal(accountingCost({totals: {settled_usd: 0.02}, calls: [call('settled'), call('uncertain')]}), '$0.02+');
    assert.equal(accountingCost({totals: {settled_usd: null}, calls: [call('reserved')]}), '–');
    assert.equal(accountingCost(null), '–');
  });
});

describe('trace read errors', () => {
  const good = {data: {}, error: null};
  it('is an error for a trace that was never read, and says nothing while one is read', () => {
    assert.deepEqual(traceErrors({data: null, error: 'gone'}, good), {error: 'gone', refreshError: null});
    assert.deepEqual(traceErrors(good, {data: null, error: 'cut'}), {error: 'cut', refreshError: null});
    assert.deepEqual(traceErrors({data: null, error: null}, good), {error: null, refreshError: null});
  });

  it('keeps the last good trace when a read again fails, and names the failure beside it', () => {
    assert.deepEqual(traceErrors(good, {data: {}, error: 'poll failed'}), {error: null, refreshError: 'poll failed'});
    assert.deepEqual(traceErrors({data: {}, error: 'attempt poll failed'}, {data: {}, error: 'spans poll failed'}), {error: null, refreshError: 'attempt poll failed'});
  });
});

describe('payload addresses', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });
  it('encodes the payload hash in the address', async () => {
    let asked;
    globalThis.fetch = async url => { asked = String(url); return new Response('text', {headers: {'X-Rush-Redaction': 'none'}}); };
    await traceApi.payload('a1', 'x/../y?z');
    assert.match(asked, /\/attempts\/a1\/payloads\/x%2F\.\.%2Fy%3Fz$/);
  });
});
