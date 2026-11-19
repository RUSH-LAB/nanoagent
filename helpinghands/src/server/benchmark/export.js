'use strict';

/**
 * The trace export (routes/trace-export.js), pure so it is tested without a database: one JSON object per run or chat, which the route
 * writes as a line of JSON Lines. A run (a Harness tab Terminal session, a Harness tab or `nanoagent harness` session, a scored run)
 * carries its attempts, each with every model call (its request and response bodies, from the attempt's payloads, and the response's
 * text), what each call cost (accounting), its events (the processes it ran and their exits among them), spans and links, and what
 * each of its terminals wrote. A chat (a plugin page's NanoAgent session) carries its turns, each with what its model saw and did, and
 * its calls.
 */
const {REFERENCE_LABELS} = require('./harness');
const {runScore} = require('./rules');

/** The `data:` payloads of a server-sent event stream, in order. */
function sseData(text) {
  return text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(line[5] === ' ' ? 6 : 5)).join('\n')).filter(data => data && data !== '[DONE]').map(data => JSON.parse(data));
}

/** The text a streamed response wrote, by its dialect (as nanoagent.uploaded.dialects assembles it). */
function streamText(dialect, stream) {
  const chunks = sseData(stream);
  if (dialect === 'chat_completions') {
    const byChoice = new Map();
    for (const chunk of chunks) {
      for (const [position, choice] of (chunk.choices ?? []).entries()) {
        const content = choice.delta?.content;
        if (content) byChoice.set(choice.index ?? position, (byChoice.get(choice.index ?? position) ?? '') + content);
      }
    }
    return [...byChoice.keys()].sort((a, b) => a - b).map(index => byChoice.get(index)).join('');
  }
  if (dialect === 'responses') return chunks.filter(event => event.type === 'response.output_text.delta').map(event => event.delta ?? '').join('');
  if (dialect === 'anthropic_messages') {
    return chunks.filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta').map(event => event.delta.text ?? '').join('');
  }
  throw new Error(`No response text for dialect ${dialect}`);
}

/** The text a whole JSON response body holds, by its dialect. */
function bodyText(dialect, body) {
  if (dialect === 'chat_completions') return (body.choices ?? []).map(choice => choice.message?.content).filter(text => typeof text === 'string').join('');
  if (dialect === 'responses') {
    return (body.output ?? []).filter(item => item.type === 'message')
      .flatMap(item => (item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '')).join('');
  }
  if (dialect === 'anthropic_messages') return (body.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
  throw new Error(`No response text for dialect ${dialect}`);
}

/**
 * A stored payload as the export carries it: `{sha256, redaction, body}`, the body parsed as JSON (`json`) or as text, a truncated one
 * always as text. Throws for a sha256 the attempt did not store.
 */
function payloadOf(payloads, sha256, json) {
  const stored = payloads.get(sha256);
  if (!stored) throw new Error(`Payload ${sha256} is not stored`);
  const text = stored.data.toString('utf8');
  return {sha256, redaction: stored.redaction, body: json && stored.redaction !== 'truncated' ? JSON.parse(text) : text};
}

/**
 * Every model call of an attempt, in the order its first event came, from its gateway events (`model_call.*`, by `call_id`) and stored
 * payloads (`Map<sha256, {data, redaction}>`): what was asked (the request body the harness sent), what came back (the JSON body, or
 * the event stream as text), the response's text, its usage and timing, and why it was rejected when it was.
 */
function modelCalls(events, payloads) {
  const calls = new Map();
  for (const event of events) {
    if (!event.kind.startsWith('model_call.') || !event.data.call_id) continue;
    if (!calls.has(event.data.call_id)) calls.set(event.data.call_id, {});
    calls.get(event.data.call_id)[event.kind.slice('model_call.'.length)] = event.data;
  }
  return [...calls].map(([callId, {admitted, dispatched, response, rejected}]) => {
    const dialect = admitted?.dialect ?? response?.dialect ?? rejected?.dialect ?? null;
    const submitted = admitted?.submitted_request_sha256 ?? rejected?.submitted_request_sha256 ?? null;
    let body = null;
    let text = null;
    if (response?.response_payload_sha256) {
      body = payloadOf(payloads, response.response_payload_sha256, true);
      text = body.redaction === 'truncated' ? null : bodyText(dialect, body.body);
    } else if (response?.stream_payload_sha256) {
      body = payloadOf(payloads, response.stream_payload_sha256, false);
      text = body.redaction === 'truncated' ? null : streamText(dialect, body.body);
    }
    return {
      call_id: callId, dialect,
      model: {requested: admitted?.model ?? response?.requested_model ?? null, resolved: response?.resolved_model ?? null, provider: response?.provider ?? null},
      url: dispatched?.url ?? null,
      request: submitted ? payloadOf(payloads, submitted, true) : null,
      response: body, response_text: text,
      status: rejected ? 'rejected' : response ? response.terminal : 'pending',
      http_status: response?.http_status ?? rejected?.http_status ?? null, finish_reason: response?.finish_reason ?? null,
      usage: response?.usage ?? null,
      timing_ns: response ? {dispatched: response.dispatched_ns, first_byte: response.first_byte_ns, completed: response.completed_ns} : null,
      error: response?.error ?? (rejected ? {code: rejected.code, message: rejected.message} : null),
    };
  });
}

/** An attempt as the export carries it, from its row and what it recorded. */
function attemptLine(attempt, {events, payloads, spans, links, accounting, terminals}) {
  return {
    attempt_id: attempt.attempt_id, case_id: attempt.case_id, attempt_no: attempt.attempt_no, rerun_of: attempt.rerun_of, state: attempt.state,
    created_at: attempt.created_at, claimed_at: attempt.claimed_at, ended_at: attempt.finalized_at,
    outcome: attempt.execution_status ? {status: attempt.execution_status, reason: attempt.execution_reason} : null,
    verdict: attempt.verdict, explanation: attempt.explanation, verifier_error: attempt.verifier_error, metrics: attempt.metrics,
    chats: attempt.chats, model_calls: modelCalls(events, payloads), accounting, events, spans, links,
    terminals: terminals.map(({terminal, data}) => ({terminal, text: data.toString('utf8')})),
  };
}

/** What a run is: a free-form Terminal session, a session of a harness at a task (the Harness tab, `nanoagent harness`, `rush score`), or a benchmark run. */
const runKind = run => (!run.session ? 'benchmark' : run.harness_name === 'shell' && run.task_id === null ? 'terminal' : 'session');

/** One run's line: the run, who ran it, its harness by its CLI command, its score when it has cases (null for a free-form Terminal session), and each attempt. */
function runLine(run, attempts, caseIds) {
  return {
    type: 'run', kind: runKind(run), run_id: run.run_id, workspace_id: run.workspace_id,
    member: {id: run.user_id, name: run.user_name, github: run.user_github},
    plugin: {id: run.plugin_id, name: run.plugin_name, version: run.version}, task_id: run.task_id,
    benchmark: {id: run.benchmark_id, name: run.benchmark_name},
    harness: {name: REFERENCE_LABELS[run.harness_name] ?? run.harness_name, version: run.harness_version}, agent: run.start_cli,
    model: run.model, policy: run.policy, interactive: run.interactive, resumed_from: run.resumed_from,
    created_at: run.created_at, canceled_at: run.canceled_at,
    score: caseIds.length ? runScore(caseIds, attempts.map(({row}) => row)) : null,
    attempts: attempts.map(({row, recorded}) => attemptLine(row, recorded)),
  };
}

/** One NanoAgent chat's line: the session, who held it, each turn with what its model saw and did (an ATIF trajectory), and its calls. */
function chatLine(session, turns, calls) {
  return {
    type: 'chat', kind: 'nanoagent', session_id: session.id, workspace_id: session.workspace_id,
    member: {id: session.user_id, name: session.user_name, github: session.user_github},
    plugin: {id: session.plugin_id}, harness: {name: 'nanoagent'}, title: session.title,
    created_at: session.created_at, updated_at: session.updated_at, archived_at: session.archived_at,
    turns, calls,
  };
}

module.exports = {chatLine, runLine, streamText};
