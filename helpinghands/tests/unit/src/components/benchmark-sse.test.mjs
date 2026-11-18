import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {followStream, foldFrame, initialStream, streamPath} from '../../../../src/components/Benchmark/sse.js';

const event = cursor => ({event: 'event', data: {cursor}});
const sealed = finalCursor => ({event: 'sealed', data: {final_cursor: finalCursor}});

describe('benchmark live stream', () => {
  it('advances its cursor with each new event and ignores a repeat', () => {
    let state = initialStream();
    for (const frame of [event(1), event(2), event(2), event(1), event(3)]) state = foldFrame(state, frame);
    assert.deepEqual([state.cursor, state.sealed], [3, false]);
    state = foldFrame(state, sealed(3));
    assert.deepEqual([state.sealed, state.finalCursor], [true, 3]);
  });

  it('resumes after the last cursor it saw when the connection drops before the seal', async () => {
    const opened = [];
    const script = [[event(1), event(2)], [event(2), event(3), sealed(3)]];
    const heard = [];
    const final = await followStream({
      attemptId: 'a/1',
      open: async path => { opened.push(path); return {ok: true, status: 200, frames: script.shift()}; },
      read: async (response, onFrame) => response.frames.forEach(onFrame),
      onFrame: (frame, state) => heard.push([frame.event, state.cursor]),
      sleep: async () => {},
    });
    assert.deepEqual(opened, [streamPath('a/1', 0), streamPath('a/1', 2)]);
    assert.equal(opened[1], '/api/benchmark/attempts/a%2F1/stream?after=2');
    // The repeat of cursor 2 on the second connection is not heard again.
    assert.deepEqual(heard, [['event', 1], ['event', 2], ['event', 3], ['sealed', 3]]);
    assert.equal(final.sealed, true);
  });

  it('reconnects after a failed open and stops for an attempt that is gone or when aborted', async () => {
    let opens = 0;
    const final = await followStream({
      attemptId: 'a', after: 5,
      open: async () => { opens += 1; if (opens === 1) throw new Error('offline'); return {ok: true, frames: [sealed(7)]}; },
      read: async (response, onFrame) => response.frames.forEach(onFrame), onFrame() {}, sleep: async () => {},
    });
    assert.deepEqual([opens, final.sealed], [2, true]);

    const gone = await followStream({attemptId: 'a', open: async () => ({ok: false, status: 404}), read: async () => {}, onFrame() {}, sleep: async () => {}});
    assert.equal(gone.sealed, false);

    const controller = new AbortController();
    let calls = 0;
    await followStream({
      attemptId: 'a', signal: controller.signal, open: async () => { calls += 1; controller.abort(); return {ok: true}; },
      read: async () => {}, onFrame() {}, sleep: async () => {},
    });
    assert.equal(calls, 1);
  });
});
