import API_BASE, {apiFetch, apiRequest} from '../../utils/api.js';
import {readEvents} from '../../utils/eventStream.js';

/** The member's benchmark API (docs/contracts/rush-benchmark-api.md), under the workspace the page is in. */
const BASE = '/api/benchmark';
const post = (path, body) => apiRequest(`${BASE}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body ?? {})});
const id = value => encodeURIComponent(value);

/** A JSON request whose refusal keeps everything the server said (`details`: its code and extras such as `exceeded` or `case_ids`). */
async function request(path, init) {
  const response = await apiFetch(`${API_BASE}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `The request failed (${response.status})`), {status: response.status, code: data.code ?? null, details: data});
  return data;
}

export const benchmarkApi = {
  /** The member's installed apps with their tasks, the plugins a benchmark is published for. */
  async apps() { return (await apiRequest('/api/apps')).apps; },
  /** What a benchmark publication starts from: limits, the coding template and its placeholders, the endpoints workers advertise. */
  defaults: () => apiRequest(`${BASE}/defaults`),
  /** Every published benchmark, newest first, of one plugin (and one version of it) when given. */
  async benchmarks(pluginId, version) {
    const query = new URLSearchParams();
    if (pluginId) query.set('plugin_id', pluginId);
    if (pluginId && version) query.set('version', version);
    return (await apiRequest(`${BASE}/benchmarks${query.size ? `?${query}` : ''}`)).benchmarks;
  },
  /** A benchmark with its case set: task, context and the cases (kind, arguments, expected error). */
  async benchmark(benchmarkId) { return (await apiRequest(`${BASE}/benchmarks/${id(benchmarkId)}`)).benchmark; },
  /** Every member's runs of a benchmark, as run summaries. */
  async benchmarkResults(benchmarkId) { return (await apiRequest(`${BASE}/benchmarks/${id(benchmarkId)}/results?limit=200`)).runs; },
  /**
   * Publish a benchmark for the installed plugin: `bodyText` is the request as text (the case file embedded as it was read, never parsed
   * here, so a number's spelling survives). The member's computer pins the cases and RUSH publishes them: `{benchmark, created}`.
   */
  publish: bodyText => request(`${BASE}/benchmarks/pinned`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: bodyText}),
  preview: body => request(`${BASE}/previews`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
  /** Upload a harness ZIP: `{source_sha256, size, harness: {name, version, dialects}}`; a refusal keeps its code (`invalid_manifest`, `harness_version_taken`). */
  uploadSource: file => request(`${BASE}/sources`, {method: 'POST', headers: {'Content-Type': 'application/zip'}, body: file}),
  /** The ZIP of reference harness `name`, built by the member's own NanoAgent and stored as their source: the same answer as `uploadSource`. */
  referenceSource: name => request(`${BASE}/sources/references/${id(name)}/computer`, {method: 'POST'}),
  /** Submit a run; a refusal keeps what it carries (`details` holds a stale preview's `stale` and `current`). */
  submit: body => request(`${BASE}/runs`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
  runs: () => apiRequest(`${BASE}/runs?limit=100`),
  run: runId => apiRequest(`${BASE}/runs/${id(runId)}`),
  cancel: runId => post(`/runs/${id(runId)}/cancel`),
  rerun: (runId, caseId) => post(`/runs/${id(runId)}/cases/${id(caseId)}/rerun`),
  attempt: attemptId => apiRequest(`${BASE}/attempts/${id(attemptId)}`),
  spans: attemptId => apiRequest(`${BASE}/attempts/${id(attemptId)}/spans`),
  /** Two runs of one task verifier, compared as setups and by the cases they share. */
  compareRuns: (a, b) => apiRequest(`${BASE}/compare?a=${id(a)}&b=${id(b)}`),
  /** Two sealed attempts of one pinned case, compared action by action. */
  compareAttempts: (a, b) => apiRequest(`${BASE}/compare/attempts?a=${id(a)}&b=${id(b)}`),
  /** A payload, fetched on selection: its text and the stored redaction status. */
  async payload(attemptId, sha256) {
    const response = await apiFetch(`${API_BASE}${BASE}/attempts/${id(attemptId)}/payloads/${sha256}`);
    if (!response.ok) {
      const error = new Error(response.status === 404 ? 'This payload was not stored' : `The payload could not be read (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return {text: await response.text(), redaction: response.headers.get('X-Rush-Redaction') ?? 'none'};
  },
  /** The stream of an attempt's committed events, for sse.followStream. */
  openStream: (path, signal) => apiFetch(`${API_BASE}${path}`, {signal, headers: {Accept: 'text/event-stream'}}),
  readStream: readEvents,
};
