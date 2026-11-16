/** Overlap the last millisecond so timestamp ties are not silently skipped. */
export async function allPages(read) {
  const runs = new Map();
  let before;
  for (;;) {
    const page = await read(before);
    const oldSize = runs.size;
    for (const run of page) runs.set(run.run_id, run);
    if (page.length < 200) return [...runs.values()];
    if (runs.size === oldSize) throw new Error('Too many runs share a timestamp to page through results safely');
    before = new Date(Date.parse(page[page.length - 1].created_at) + 1).toISOString();
  }
}
