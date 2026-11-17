/** The most spans one attempt's trace request returns (the server's cap); a trace that reaches it may be cut. */
export const SPAN_LIMIT = 5000;
export const spansCut = data => (data?.spans?.length ?? 0) >= SPAN_LIMIT;

/** Overlap the last millisecond so timestamp ties are not silently skipped. Runs page by `created_at`; `{key, time}` pages other rows (benchmarks: `benchmark_id`, `published_at`). */
export async function allPages(read, {key = 'run_id', time = 'created_at'} = {}) {
  const rows = new Map();
  let before;
  for (;;) {
    const page = await read(before);
    const oldSize = rows.size;
    for (const row of page) rows.set(row[key], row);
    if (page.length < 200) return [...rows.values()];
    if (rows.size === oldSize) throw new Error('Too many rows share a timestamp to page through results safely');
    before = new Date(Date.parse(page[page.length - 1][time]) + 1).toISOString();
  }
}
