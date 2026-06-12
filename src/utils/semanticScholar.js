/** Shared Semantic Scholar API endpoints for the bibliography and editor UIs. */

/** API host. Used to compose the recommendations and search request URLs. */
export const S2_API_BASE = 'https://api.semanticscholar.org';

/** Paper title and keyword search endpoint (graph API v1). */
export const S2_PAPER_SEARCH = `${S2_API_BASE}/graph/v1/paper/search`;
