/** Persist each request and its idempotency key before sending it; retry unknown outcomes with the same request. */
export async function submitBatch(initial, {send, persist}) {
  let batch = initial;
  persist(batch);
  for (let i = 0; i < batch.entries.length; i++) {
    const entry = batch.entries[i];
    if (entry.runId) continue;
    const body = {benchmark_id: entry.benchmark.benchmark_id, policy: batch.policy, preview_id: entry.previewId, source_sha256: batch.source.source_sha256, idempotency_key: entry.key};
    try {
      const response = await send(body);
      batch = {...batch, entries: batch.entries.map((row, j) => j === i ? {...row, runId: response.run.run_id, error: null, code: null} : row)};
    } catch (error) {
      batch = {...batch, entries: batch.entries.map((row, j) => j === i ? {...row, error: error.message, code: error.code ?? null} : row)};
    }
    persist(batch);
  }
  return batch;
}

/** The maximum is per case, not per benchmark. */
export const maximumCost = previews => previews.reduce((sum, item) => sum + item.limits.effective.max_cost_usd * item.cases.length, 0);

/** NanoAgent uses plugin tools; other references and uploaded harnesses start in coding mode. */
export const defaultPolicy = reference => reference === 'nanoagent' ? 'task_tools' : 'coding';
