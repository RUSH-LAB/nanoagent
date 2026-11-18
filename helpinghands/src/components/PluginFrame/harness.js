import {attemptStatus, explanationText, verdictText} from '../Benchmark/runs.js';
import {followStream} from '../Benchmark/sse.js';
import {traceMessages} from '../Benchmark/traceMessages.js';

/**
 * A session of a plugin page's Harness tab, on the host's side: the run RUSH queued for it (POST /api/benchmark/sessions) is a
 * benchmark run of one case, so its attempt is followed the way the Benchmark page follows one, through its event stream, and
 * each event the page shows becomes one step (`harness.step`): a model reply with its text and the tool calls it proposed, a
 * plugin tool the broker ran, a command, the harness starting and exiting, and its answer. Once the attempt is sealed the page
 * gets its outcome (`harness.outcome`): the verifier's verdict, tokens, time and cost.
 */

const BASE = '/api/benchmark';

/** A step's text from a stored payload, read as the trace does: `payload(sha)` resolves to its text. */
async function replyText(data, dialect, payload) {
  const sha = data.stream_payload_sha256 ?? data.response_payload_sha256;
  if (!sha) return '';
  const messages = traceMessages(await payload(sha), {dialect, response: true, stream: Boolean(data.stream_payload_sha256)});
  // The tool calls it lists are the step's own `calls`.
  return messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n\n');
}

/**
 * What the Harness tab shows of one of the attempt's events, or null for one it does not. `dialects` keeps each model call's
 * dialect from its admission, which its response is read by.
 */
export async function harnessStep({kind, data}, dialects, payload) {
  switch (kind) {
    case 'case.launched':
      return {kind: 'status', text: 'The harness started'};
    case 'case.exited':
      return {kind: 'status', text: 'The harness exited'};
    case 'model_call.admitted':
      dialects.set(data.call_id, data.dialect);
      return null;
    case 'model_call.response':
      return {
        kind: 'reply',
        text: await replyText(data, dialects.get(data.call_id), payload),
        calls: (data.proposals ?? []).map(proposal => ({name: proposal.name, arguments: proposal.raw_arguments})),
        error: data.error ?? null,
      };
    case 'model_call.rejected':
    case 'tool.rejected':
    case 'exec.rejected':
      return {kind: 'error', text: data.message};
    case 'tool.invoked':
      return {kind: 'tool', name: data.tool};
    case 'tool.completed':
      return {kind: 'tool-result', name: data.tool, ok: data.ok, error: data.error?.message ?? null};
    case 'exec.started':
      return {kind: 'command', argv: JSON.parse(await payload(data.command_sha256)).argv};
    case 'result.read':
      return {kind: 'result', outcome: data.outcome};
    default:
      return null;
  }
}

/** The outcome the page shows of the sealed `attempt`, with what its model calls cost (`accounting`'s totals). */
export function harnessOutcome(attempt, accounting) {
  const metrics = attempt.metrics ?? {};
  return {
    status: attemptStatus(attempt),
    reason: attempt.execution?.reason ?? null,
    verdict: verdictText(attempt),
    explanation: explanationText(attempt.explanation),
    inputTokens: metrics.input_tokens ?? null,
    outputTokens: metrics.output_tokens ?? null,
    elapsedMs: metrics.elapsed_ms ?? null,
    cost: accounting.totals.settled_usd,
  };
}

/**
 * Follow the attempt `attemptId` of a Harness tab session until it is sealed or `signal` aborts, telling the page each step
 * (`emit('harness.step', step)`), then its outcome (`emit('harness.outcome', outcome)`). `request(path, init)` fetches a RUSH API
 * path; `read(response, onFrame)` reads a stream's frames.
 */
export async function followHarness({attemptId, request, read, emit, signal}) {
  const json = async path => {
    const response = await request(path);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not read ${path} (${response.status})`);
    return data;
  };
  const payload = async sha => {
    const response = await request(`${BASE}/attempts/${attemptId}/payloads/${sha}`);
    if (!response.ok) throw new Error(`Could not read the payload ${sha.slice(0, 12)} (${response.status})`);
    return response.text();
  };
  const dialects = new Map();
  // Steps go out in the order their events came, each read in turn.
  let steps = Promise.resolve();
  await followStream({
    attemptId,
    open: (path, aborted) => request(path, {signal: aborted, headers: {Accept: 'text/event-stream'}}),
    read,
    signal,
    onFrame: frame => {
      if (frame.event !== 'event') return;
      steps = steps.then(async () => {
        const step = await harnessStep(frame.data, dialects, payload);
        if (step) emit('harness.step', step);
      });
    },
  });
  await steps;
  if (signal.aborted) return;
  const [{attempt}, accounting] = await Promise.all([json(`${BASE}/attempts/${attemptId}`), json(`${BASE}/attempts/${attemptId}/accounting`)]);
  emit('harness.outcome', harnessOutcome(attempt, accounting));
}
