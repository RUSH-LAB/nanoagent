/**
 * An attempt's live event stream (GET attempts/{id}/stream): the cursor to resume from, and a loop that reconnects from it.
 * Cursors are per attempt, start at 1 and are committed in order, so an event at or below the last one seen is a repeat.
 */

export const initialStream = (after = 0) => ({cursor: after, sealed: false, finalCursor: null});

/** The stream's state after one parsed frame `{event, data}`: `event` frames advance the cursor, `sealed` ends it. */
export function foldFrame(state, frame) {
  if (frame.event === 'sealed') return {...state, sealed: true, finalCursor: frame.data?.final_cursor ?? state.cursor};
  if (frame.event !== 'event' || !(frame.data?.cursor > state.cursor)) return state;
  return {...state, cursor: frame.data.cursor};
}

/** The path to open the stream at, resuming after `cursor`. */
export const streamPath = (attemptId, cursor) => `/api/benchmark/attempts/${encodeURIComponent(attemptId)}/stream?after=${cursor}`;

/**
 * Follow an attempt until it seals or `signal` aborts: `open(path)` returns the response, `read(response, onFrame)` parses its
 * frames. A stream that ends or fails before `sealed` is opened again after `retryMs`, from the last cursor seen. `onFrame`
 * hears each new frame (never a repeat) with the state it led to.
 */
export async function followStream({attemptId, after = 0, open, read, onFrame, signal, retryMs = 1500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  let state = initialStream(after);
  while (!signal?.aborted && !state.sealed) {
    try {
      const response = await open(streamPath(attemptId, state.cursor), signal);
      if (!response.ok) {
        if (response.status === 404) return state;
        throw new Error(`stream answered ${response.status}`);
      }
      await read(response, frame => {
        const next = foldFrame(state, frame);
        if (next === state) return;
        state = next;
        onFrame(frame, state);
      });
    } catch (error) {
      if (signal?.aborted) return state;
    }
    if (!state.sealed && !signal?.aborted) await sleep(retryMs);
  }
  return state;
}
