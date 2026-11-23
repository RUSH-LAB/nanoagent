import API_BASE, {apiFetch} from '../../utils/api.js';
import {workerNotice} from '../PluginFrame/worker.js';

/** A request of the member's benchmark API (docs/contracts/rush-benchmark-api.md): its JSON, or an Error with the server's own message. */
export async function benchmarkJson(path, init) {
  let response;
  try {
    response = await apiFetch(`${API_BASE}/api/benchmark${path}`, init);
  } catch {
    throw new Error('Could not reach the API server');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The request failed (${response.status})`);
  return data;
}

/** RUSH Lab's state on the member's computer (GET /api/runner/status), for workerNotice; an Error when it cannot be read. */
export async function runnerStatus() {
  let response;
  try {
    response = await apiFetch(`${API_BASE}/api/runner/status`);
  } catch {
    throw new Error('Could not reach the API server');
  }
  if (!response.ok) throw new Error(`The request failed (${response.status})`);
  return response.json();
}

/** The notice about RUSH Lab and its benchmark worker: workerNotice of its status, or a bad one saying the status could not be read. */
export const runnerNotice = () => runnerStatus().then(workerNotice, failure => ({tone: 'bad', text: `RUSH Lab's status could not be read: ${failure.message}`}));

// A sealed attempt's accounting never changes, so it is read once.
const sealedAccounting = new Map();

const attemptAccounting = async (attemptId, sealed) => {
  if (sealedAccounting.has(attemptId)) return sealedAccounting.get(attemptId);
  const accounting = await benchmarkJson(`/attempts/${attemptId}/accounting`);
  if (sealed) sealedAccounting.set(attemptId, accounting);
  return accounting;
};

/**
 * A run in full (GET runs/{id}) with what its newest attempts cost: the settled sum, null when none is known. The run is read fresh
 * every time (a finished run becomes active again when one of its cases is rerun), the accounting of its unsealed attempts too.
 */
export async function runDetail(id) {
  const {run} = await benchmarkJson(`/runs/${id}`);
  const attempts = run.cases.filter(one => one.latest_attempt_id).map(one => [one.latest_attempt_id, one.attempts.find(attempt => attempt.attempt_id === one.latest_attempt_id)?.sealed === true]);
  const accounting = await Promise.all(attempts.map(([attempt, sealed]) => attemptAccounting(attempt, sealed)));
  const settled = accounting.length > 0 && accounting.every(record => Number.isFinite(record.totals.settled_usd) && record.calls.every(call => call.admission.status === 'settled'));
  return {run, cost_usd: settled ? accounting.reduce((sum, record) => sum + record.totals.settled_usd, 0) : null};
}

/** The installed plugin `id`'s manifest (GET /api/apps/{id}, which needs the member's computer): its tasks, each with `inputSchema`. */
export async function appManifest(id) {
  let response;
  try {
    response = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(id)}`);
  } catch {
    throw new Error('Could not reach the API server');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Could not read the plugin's manifest (${response.status})`);
  return data.app;
}
