import {attemptStatus} from './attempt.js';
import {workerNotice} from './worker.js';

/**
 * A session of a plugin page's Harness tab, on the host's side: the run RUSH queued for it (POST /api/benchmark/sessions for the
 * free-form Terminal) is a run whose harness runs on terminals the member works in (0 the first; it opens more, all in
 * its one VM), on the member's own computer. The page reaches them there, not through RUSH: RUSH says where the session's worker
 * serves them (GET attempts/{id}/terminal-link, to the session's member alone), and RUSH Lab, whose window the page is in, links the
 * page to it (`openLink`). What each terminal writes reaches the page over the link as it comes (`harness.output`), with that it ended
 * (`harness.closed`); what the member types, each terminal's size, and opening or closing one go back over it (`linkLine`). Once the
 * attempt is sealed the page gets its outcome (`harness.outcome`): tokens, time and cost.
 */

const BASE = '/api/benchmark';
const RETRY_MS = 1500;
// How often a session whose link ended is read until it is sealed, for its outcome.
const SEAL_POLL_MS = 250;
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
    ended: attempt.execution?.status === 'ended',
    reason: attempt.execution?.reason ?? null,
    inputTokens: metrics.input_tokens ?? null,
    outputTokens: metrics.output_tokens ?? null,
    elapsedMs: metrics.elapsed_ms ?? null,
    cost: accounting.totals.settled_usd,
    // Why a Terminal session's files did not go to RUSH when it ended, or null.
    uploadError: attempt.workspace?.error ?? null,
  };
}

/** Text the page's terminal sent (a JS string of what was typed) as the base64 of its UTF-8 bytes. */
export function typedBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The line the link carries for the page's `input` to terminal `input.terminal`: `{data}` typed, `{rows, cols}`, or `{close: true}`;
 * or `{reopen, rows, cols}`, a chat to open in the next terminal.
 */
export function linkLine(input) {
  const {terminal} = input;
  if (input.reopen) return {reopen: input.reopen, rows: input.rows, cols: input.cols};
  if (input.close) return {terminal, close: true};
  return input.data === undefined ? {terminal, rows: input.rows, cols: input.cols} : {terminal, data: typedBase64(input.data)};
}

/**
 * RUSH Lab's link to a session's terminals on this computer: `port` on 127.0.0.1, which takes `token`. Each line the worker sends goes
 * to `onLine` in order, the last `{ended}` (null, or why the link broke). `{send(line), close()}`. The page is in RUSH Lab's window,
 * whose IPC is `tauri`; a page anywhere else has no way to its terminals, and says so.
 */
export async function openLink({port, token, onLine, tauri = globalThis.__TAURI_INTERNALS__}) {
  if (!tauri) throw new Error('The Harness terminal runs on your computer, through RUSH Lab: open this page in the RUSH Lab app.');
  // A Tauri channel: each message carries its index, and a large one, which the page fetches, can come after the next.
  let next = 0;
  const held = new Map();
  const channel = tauri.transformCallback(({message, index}) => {
    held.set(index, message);
    while (held.has(next)) {
      const line = held.get(next);
      held.delete(next);
      next += 1;
      if (line !== undefined) onLine(line);
    }
  });
  const call = (command, args) => tauri.invoke(command, args).catch(error => { throw new Error(String(error)); });
  const link = await call('terminal_link', {port, token, events: `__CHANNEL__:${channel}`});
  return {send: line => call('terminal_send', {link, line: JSON.stringify(line)}), close: () => call('terminal_unlink', {link})};
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
 * Follow the attempt `attemptId` of a Harness tab session until it is sealed or `signal` aborts: link to its terminals once its worker
 * has started them (`connect`, openLink), hand the link to `linked`, tell the page what the link carries (`emit('harness.output',
 * {terminal, data})`, data in base64; `emit('harness.closed', {terminal})`), and once the link ended and the attempt is sealed, tell
 * its outcome (`emit('harness.outcome', outcome)`). `request(path, init)` fetches a RUSH API path.
 */
export async function followHarness({attemptId, request, emit, signal, linked, connect = openLink, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const json = reader(request);
  const attempt = async () => (await json(`${BASE}/attempts/${attemptId}`)).attempt;
  let shown = false;
  let sealed = false;
  // Never a silent black screen: until the first byte, the terminal itself says what it waits on, each time that changes.
  (async () => {
    let said = null;
    await sleep(SILENT_MS);
    while (!shown && !sealed && !signal.aborted) {
      let text;
      try {
        const [now, status] = await Promise.all([attempt(), json('/api/runner/status')]);
        text = waitingText(now, status);
      } catch (error) {
        text = error.message;
      }
      if (shown || sealed || signal.aborted) return;
      if (text !== said) emit('harness.output', {terminal: 0, data: typedBase64(`\x1b[2m[RUSH] ${text}\x1b[0m\r\n`)});
      said = text;
      await sleep(RETRY_MS);
    }
  })();
  try {
    let link = null;
    while (!link && !signal.aborted) {
      let response;
      try {
        response = await request(`${BASE}/attempts/${attemptId}/terminal-link`, {signal});
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }
      if (response.status === 200) link = await response.json();
      else if (response.status !== 204) throw new Error((await response.json().catch(() => ({}))).error || `Could not find the session's terminals (${response.status})`);
      else if ((await attempt()).sealed) break;  // it ended before its worker started its terminals
    }
    if (link) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', resolve, {once: true});
        const onLine = line => {
          if (line.data !== undefined) {
            shown = true;
            emit('harness.output', {terminal: line.terminal, data: line.data});
          } else if (line.closed) {
            emit('harness.closed', {terminal: line.terminal});
          } else if (line.error) {
            emit('harness.error', {message: `The session's terminals refused the page: ${line.error}`});
          } else if ('ended' in line) {
            if (line.ended) emit('harness.error', {message: `The link to the session's terminals broke: ${line.ended}`});
            resolve();
          }
        };
        connect({port: link.port, token: link.token, onLine}).then(opened => {
          linked(opened);
          if (signal.aborted) opened.close().catch(() => {});
          else signal.addEventListener('abort', () => opened.close().catch(() => {}), {once: true});
        }, reject);
      });
    }
    while (!signal.aborted && !(await attempt()).sealed) await sleep(SEAL_POLL_MS);
    if (signal.aborted) return;
    const [ended, accounting] = await Promise.all([attempt(), json(`${BASE}/attempts/${attemptId}/accounting`)]);
    emit('harness.outcome', harnessOutcome(ended, accounting));
  } finally {
    sealed = true;  // the notices stop, however the session ended
  }
}
