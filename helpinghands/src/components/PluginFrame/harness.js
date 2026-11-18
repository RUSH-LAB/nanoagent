import {attemptStatus, explanationText, verdictText} from './attempt.js';
import {workerNotice} from './worker.js';

/**
 * A session of a plugin page's Harness tab, on the host's side: the run RUSH queued for it (POST /api/benchmark/sessions) is a
 * benchmark run of one case whose harness runs on a terminal the member works in. What the harness writes there reaches the page
 * as it comes (`harness.output`, from GET attempts/{id}/terminal), what the member types and the terminal's size go back
 * (`harnessInput`, POST attempts/{id}/terminal), and once the attempt is sealed the page gets its outcome (`harness.outcome`): the
 * verifier's verdict, tokens, time and cost.
 */

const BASE = '/api/benchmark';
const RETRY_MS = 1500;

/** The outcome the page shows of the sealed `attempt`, with what its model calls cost (`accounting`'s totals). */
export function harnessOutcome(attempt, accounting) {
  const metrics = attempt.metrics ?? {};
  return {
    status: attemptStatus(attempt),
    // A free-form Terminal session has no case: it ends, unscored.
    ended: attempt.execution?.status === 'ended',
    // An answer, or a refusal, is what the verifier scores; a harness that ended without one has nothing to score.
    scored: ['answered', 'refused'].includes(attempt.execution?.status),
    reason: attempt.execution?.reason ?? null,
    verdict: verdictText(attempt),
    explanation: explanationText(attempt.explanation),
    inputTokens: metrics.input_tokens ?? null,
    outputTokens: metrics.output_tokens ?? null,
    elapsedMs: metrics.elapsed_ms ?? null,
    cost: accounting.totals.settled_usd,
  };
}

/** Text the page's terminal sent (a JS string of what was typed) as the base64 of its UTF-8 bytes. */
export function typedBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Send the attempt's terminal `input`: `{data}`, what the member typed, or `{rows, cols}`, its new size. `request(path, init)`
 * fetches a RUSH API path.
 */
export async function harnessInput({attemptId, request, input}) {
  const body = input.data === undefined ? {rows: input.rows, cols: input.cols} : {data: typedBase64(input.data)};
  const response = await request(`${BASE}/attempts/${attemptId}/terminal`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `The terminal did not take the input (${response.status})`);
}

/**
 * Wait until the member's benchmark worker is ready (GET /api/runner/status), telling the page what it prepares meanwhile
 * (`emit('harness.preparing', {done, total})`, the bytes of the images it pulls as it starts), so a session is queued only for a
 * worker that can take it. One that cannot start (no key, unsupported, failed, RUSH Lab not connected) fails with why.
 */
export async function awaitWorker({request, emit, signal, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  while (!signal.aborted) {
    const response = await request('/api/runner/status', {signal});
    const status = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(status.error || `Could not read your benchmark worker's state (${response.status})`);
    const notice = workerNotice(status);
    if (notice.tone === 'ok') return;
    if (notice.tone === 'bad') throw new Error(notice.text);
    emit('harness.preparing', status.worker?.progress ?? {done: 0, total: 0});
    await sleep(RETRY_MS);
  }
}

/**
 * Follow the attempt `attemptId` of a Harness tab session until it is sealed or `signal` aborts, telling the page each chunk of
 * its terminal's output (`emit('harness.output', {data})`, data in base64), then its outcome (`emit('harness.outcome', outcome)`).
 * A stream that ends or drops is opened again from the byte it reached. `request(path, init)` fetches a RUSH API path; `read(response,
 * onFrame)` reads a stream's frames.
 */
export async function followHarness({attemptId, request, read, emit, signal, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const json = async path => {
    const response = await request(path);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not read ${path} (${response.status})`);
    return data;
  };
  let offset = 0;
  let sealed = false;
  while (!sealed && !signal.aborted) {
    let failed = false;
    try {
      const response = await request(`${BASE}/attempts/${attemptId}/terminal?from=${offset}`, {signal, headers: {Accept: 'text/event-stream'}});
      if (response.status === 404) throw new Error('The session\'s attempt is gone');
      failed = !response.ok;
      if (response.ok) {
        await read(response, frame => {
          if (frame.event === 'sealed') sealed = true;
          if (frame.event !== 'output' || frame.data.offset !== offset) return;
          offset += atob(frame.data.data).length;
          emit('harness.output', {data: frame.data.data});
        });
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error.message === 'The session\'s attempt is gone') throw error;
      failed = true;
    }
    // A stream that ended before the seal is opened again from where it reached, at once unless it failed.
    if (failed && !signal.aborted) await sleep(RETRY_MS);
  }
  if (signal.aborted) return;
  const [{attempt}, accounting] = await Promise.all([json(`${BASE}/attempts/${attemptId}`), json(`${BASE}/attempts/${attemptId}/accounting`)]);
  emit('harness.outcome', harnessOutcome(attempt, accounting));
}
