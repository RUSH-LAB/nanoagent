import API_BASE, {apiFetch, apiRequest} from '../../utils/api.js';

const BASE = '/api/benchmark/attempts';
const id = value => encodeURIComponent(value);

/** The most spans one trace request returns (the server's cap); a trace that reaches it may be cut. */
export const SPAN_LIMIT = 5000;
const EVENT_PAGE = 1000;  // the server's largest page

export const traceApi = {
  attempt: attemptId => apiRequest(`${BASE}/${id(attemptId)}`).then(result => result.attempt),
  spans: attemptId => apiRequest(`${BASE}/${id(attemptId)}/spans?limit=${SPAN_LIMIT}`),
  accounting: attemptId => apiRequest(`${BASE}/${id(attemptId)}/accounting`),
  /** What each terminal of a Harness tab session wrote: `{session, terminals: [{terminal, data}]}` with `data` base64. */
  recording: attemptId => apiRequest(`${BASE}/${id(attemptId)}/recording`),
  /** The last workspace snapshot's event data (`diff`, `diff_truncated`), or null when none was taken. Every event is read: the snapshot comes last. */
  async snapshot(attemptId) {
    let snapshot = null;
    for (let after = 0; ;) {
      const result = await apiRequest(`${BASE}/${id(attemptId)}/events?after=${after}&limit=${EVENT_PAGE}`);
      snapshot = result.events.filter(event => event.kind === 'snapshot.taken').at(-1)?.data ?? snapshot;
      if (!result.has_more) break;
      after = result.events.at(-1).cursor;
    }
    return snapshot;
  },
  /** Two sealed attempts of one pinned case, compared action by action: `{header, rows, first_difference}`. */
  compare: (a, b) => apiRequest(`/api/benchmark/compare/attempts?a=${id(a)}&b=${id(b)}`),
  /** A payload, fetched on selection: its text and the stored redaction status. */
  async payload(attemptId, sha256) {
    const response = await apiFetch(`${API_BASE}${BASE}/${id(attemptId)}/payloads/${sha256}`);
    if (!response.ok) throw new Error(response.status === 404 ? 'This payload was not stored' : `The payload could not be read (${response.status})`);
    return {text: await response.text(), redaction: response.headers.get('X-Rush-Redaction') ?? 'none'};
  },
};
