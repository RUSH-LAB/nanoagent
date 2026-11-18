import API_BASE, {apiFetch, apiRequest} from '../../utils/api.js';
import {readEvents} from '../../utils/eventStream.js';
import {allPages, SPAN_LIMIT} from './pagination.js';

/** The member's benchmark API (docs/contracts/rush-benchmark-api.md), under the workspace the page is in. */
const BASE = '/api/benchmark';
const id = value => encodeURIComponent(value);
/** A POST init with a JSON body. */
const json = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body ?? {})});
/** One page of a newest-first list, the server's largest, older than `before` when given. */
const page = (path, before) => {
  const query = new URLSearchParams({limit: '200'});
  if (before) query.set('before', before);
  return apiRequest(`${BASE}${path}?${query}`);
};

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
  account: () => apiRequest('/api/workspaces'),
  /** What a benchmark publication starts from: limits, the coding template and its placeholders, the endpoints workers advertise. */
  defaults: () => apiRequest(`${BASE}/defaults`),
  /** Every published benchmark, newest first. */
  async benchmarks(before) { return (await page('/benchmarks', before)).benchmarks; },
  allBenchmarks() { return allPages(before => this.benchmarks(before), {key: 'benchmark_id', time: 'published_at'}); },
  /** A benchmark with its case set: task, context and the cases (kind, arguments, expected error). */
  async benchmark(benchmarkId) { return (await apiRequest(`${BASE}/benchmarks/${id(benchmarkId)}`)).benchmark; },
  /** Every member's runs of a benchmark, as run summaries. */
  async benchmarkResults(benchmarkId, before) { return (await page(`/benchmarks/${id(benchmarkId)}/results`, before)).runs; },
  allBenchmarkResults(benchmarkId) { return allPages(before => this.benchmarkResults(benchmarkId, before)); },
  allRuns() { return allPages(async before => (await page('/runs', before)).runs); },
  /**
   * Publish a benchmark for the installed plugin: `bodyText` is the request as text (the case file embedded as it was read, never parsed
   * here, so a number's spelling survives). The member's computer pins the cases and RUSH publishes them: `{benchmark, created}`.
   */
  publish: bodyText => request(`${BASE}/benchmarks/pinned`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: bodyText}),
  preview: body => request(`${BASE}/previews`, json(body)),
  /** Upload a harness ZIP: `{source_sha256, size, harness: {name, version, dialects}}`; a refusal keeps its code (`invalid_manifest`, `harness_version_taken`). */
  uploadSource: file => request(`${BASE}/sources`, {method: 'POST', headers: {'Content-Type': 'application/zip'}, body: file}),
  /** The ZIP of reference harness `name`, built by the member's own NanoAgent and stored as their source: the same answer as `uploadSource`. */
  referenceSource: name => request(`${BASE}/sources/references/${id(name)}/computer`, {method: 'POST'}),
  /** Submit a run; a refusal keeps what it carries (`details` holds a stale preview's `stale` and `current`). */
  submit: body => request(`${BASE}/runs`, json(body)),
  run: runId => apiRequest(`${BASE}/runs/${id(runId)}`),
  cancel: runId => apiRequest(`${BASE}/runs/${id(runId)}/cancel`, json()),
  rerun: (runId, caseId) => apiRequest(`${BASE}/runs/${id(runId)}/cases/${id(caseId)}/rerun`, json()),
  attempt: attemptId => apiRequest(`${BASE}/attempts/${id(attemptId)}`),
  spans: attemptId => apiRequest(`${BASE}/attempts/${id(attemptId)}/spans?limit=${SPAN_LIMIT}`),
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
