import {attemptStatus, explanationText, verdictText} from './attempt.js';
import {workerNotice} from './worker.js';

/**
 * A session of a plugin page's Harness tab, on the host's side: the run RUSH queued for it (POST /api/benchmark/sessions) is a
 * benchmark run of one case whose harness runs on terminals the member works in (0 the first; a free-form session opens more, all in
 * its one VM). What each writes reaches the page as it comes (`harness.output`, from GET attempts/{id}/terminal), with that it ended
 * (`harness.closed`); what the member types, each terminal's size, and opening or closing one go back (`harnessInput`, POST
 * attempts/{id}/terminal), and once the attempt is sealed the page gets its outcome (`harness.outcome`): the verifier's verdict,
 * tokens, time and cost.
 */

const BASE = '/api/benchmark';
const RETRY_MS = 1500;
// A terminal with no output this long after it opened says what it waits on, from the attempt's state and the worker's.
const SILENT_MS = 4000;

/** What a session whose terminal has written nothing waits on, from its `attempt` and the worker's `status` (GET /api/runner/status). */
export function waitingText(attempt, status) {
  if (attempt.state === 'final') {
    return `The session ended: ${attemptStatus(attempt)}${attempt.execution?.reason ? ` (${attempt.execution.reason})` : ''}.`;
  }
  if (attempt.state === 'leased') return 'This computer\'s worker has the session and is starting its terminal…';
  const notice = workerNotice(status);
  if (notice && notice.tone !== 'ok') return notice.text;
  return 'Waiting for this computer\'s worker to start this session…';
}

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
 * Send terminal `input.terminal` of the attempt `input`: `{data}`, what the member typed; `{rows, cols}`, its new size, which opens
 * a terminal not yet open; or `{close: true}`. `request(path, init)` fetches a RUSH API path.
 */
export async function harnessInput({attemptId, request, input}) {
  const {terminal} = input;
  const body = input.close ? {terminal, close: true}
    : input.data === undefined ? {terminal, rows: input.rows, cols: input.cols} : {terminal, data: typedBase64(input.data)};
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

const reader = request => async path => {
  const response = await request(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Could not read ${path} (${response.status})`);
  return data;
};

/**
 * Follow terminal `terminal` of the attempt `attemptId` until the attempt is sealed or `signal` aborts, telling the page each chunk
 * of its output (`emit('harness.output', {terminal, data})`, data in base64) and that it ended (`emit('harness.closed', {terminal})`).
 * A stream that ends or drops is opened again from the byte it reached; `progress(offset)` hears each byte count it reaches.
 * `request(path, init)` fetches a RUSH API path; `read(response, onFrame)` reads a stream's frames.
 */
export async function followTerminal({attemptId, terminal, request, read, emit, signal, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), progress = () => {}}) {
  let offset = 0;
  let closed = false;
  let sealed = false;
  while (!sealed && !signal.aborted) {
    let failed = false;
    try {
      const response = await request(`${BASE}/attempts/${attemptId}/terminal?terminal=${terminal}&from=${offset}`, {signal, headers: {Accept: 'text/event-stream'}});
      if (response.status === 404) throw new Error('The session\'s attempt is gone');
      failed = !response.ok;
      if (response.ok) {
        await read(response, frame => {
          if (frame.event === 'sealed') sealed = true;
          if (frame.event === 'closed' && !closed) {
            closed = true;
            emit('harness.closed', {terminal});
          }
          if (frame.event !== 'output' || frame.data.offset !== offset) return;
          offset += atob(frame.data.data).length;
          progress(offset);
          emit('harness.output', {terminal, data: frame.data.data});
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
}

/**
 * Follow the attempt `attemptId` of a Harness tab session until it is sealed or `signal` aborts: its first terminal (followTerminal)
 * and every terminal the page opened (`opened`, the promises of their followTerminal, which the host adds to as the page opens them),
 * then tell its outcome (`emit('harness.outcome', outcome)`). `request(path, init)` fetches a RUSH API path; `read(response, onFrame)`
 * reads a stream's frames.
 */
export async function followHarness({attemptId, request, read, emit, signal, opened = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const json = reader(request);
  let offset = 0;
  let sealed = false;
  // Never a silent black screen: until the first byte, the terminal itself says what it waits on, each time that changes.
  (async () => {
    let said = null;
    await sleep(SILENT_MS);
    while (!offset && !sealed && !signal.aborted) {
      let text;
      try {
        const [{attempt}, status] = await Promise.all([json(`${BASE}/attempts/${attemptId}`), json('/api/runner/status')]);
        text = waitingText(attempt, status);
      } catch (error) {
        text = error.message;
      }
      if (offset || sealed || signal.aborted) return;
      if (text !== said) emit('harness.output', {terminal: 0, data: typedBase64(`\x1b[2m[RUSH] ${text}\x1b[0m\r\n`)});
      said = text;
      await sleep(RETRY_MS);
    }
  })();
  await followTerminal({attemptId, terminal: 0, request, read, emit, signal, sleep, progress: reached => (offset = reached)});
  // Every terminal's stream reaches the seal; the outcome comes after the last of their output.
  for (let count = -1; count !== opened.length;) {
    count = opened.length;
    await Promise.all(opened);
  }
  sealed = true;
  if (signal.aborted) return;
  const [{attempt}, accounting] = await Promise.all([json(`${BASE}/attempts/${attemptId}`), json(`${BASE}/attempts/${attemptId}/accounting`)]);
  emit('harness.outcome', harnessOutcome(attempt, accounting));
}
