/** The benchmark worker's state as RUSH Lab reports it (GET /api/runner/status, `worker`; runner/worker.mjs): what the screens say about it. */

/** The worker's `progress`, `{done, total}` bytes of the images it pulls as it starts, as "x of y MB". */
export const megabytes = ({done, total}) => `${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB`;

const CHECK_MARKS = {pending: '○', running: '…', pass: '✓', warn: '!', wait: '…', fail: '✗'};
export const checkMark = state => CHECK_MARKS[state] ?? '○';

/** `{tone, text}` for the banner (tone ok, wait or bad), or null while the status has not arrived. */
export function workerNotice(status) {
  if (!status) return null;
  if (!status.connected) return {tone: 'bad', text: 'RUSH Lab is not connected on this computer. Open RUSH Lab to run benchmarks.'};
  const worker = status.worker;
  if (!worker) return {tone: 'wait', text: 'RUSH Lab has not reported its benchmark worker yet. If this stays, update RUSH Lab.'};
  switch (worker.state) {
    case 'ready': return {tone: 'ok', text: 'Benchmark worker ready.'};
    case 'no-key': return {tone: 'bad', text: 'Add your OpenRouter key in Settings to run benchmarks.'};
    case 'unsupported': return {tone: 'bad', text: worker.message ?? 'Benchmarks cannot run on this computer.'};
    case 'failed': return {tone: 'bad', text: `The benchmark worker failed: ${worker.message ?? 'no reason was given'}`};
    default: return {tone: 'wait', text: `Starting the benchmark worker…${worker.progress ? ` (preparing: ${megabytes(worker.progress)})` : ''}`};
  }
}
