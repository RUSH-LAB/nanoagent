import API_BASE, {apiFetch} from '../../utils/api.js';

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

export const jsonPost = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

/** RUSH Lab's state on the member's computer (GET /api/runner/status), for workerNotice; null when it cannot be read. */
export async function runnerStatus() {
  try {
    const response = await apiFetch(`${API_BASE}/api/runner/status`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * A run in full (GET runs/{id}) with what its newest attempts cost: the settled sum, null when none is known. Read fresh every time: a
 * finished run becomes active again when one of its cases is rerun.
 */
export async function runDetail(id) {
  const {run} = await benchmarkJson(`/runs/${id}`);
  const attempts = run.cases.filter(one => one.latest_attempt_id).map(one => one.latest_attempt_id);
  const accounting = await Promise.all(attempts.map(attempt => benchmarkJson(`/attempts/${attempt}/accounting`)));
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
