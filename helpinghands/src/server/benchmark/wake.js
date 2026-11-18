'use strict';

const {EventEmitter} = require('events');

/**
 * Wake-ups between this server's requests: a long-polling worker request waits on a key (`claim:<user>` for a member's queued
 * work, `case:<run>` for a session's case being pinned) until another request wakes it, so it answers at once instead of at its
 * next poll.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Wake every request waiting on `key`. */
const wake = key => bus.emit(key);

/**
 * Start listening on `key` (before reading what it guards, so a wake in between is not missed): `{woken, stop}`, where `woken(ms)`
 * resolves on the first wake since, or after `ms`, and `stop()` stops listening.
 */
function listen(key) {
  let fired = false;
  let resolve = null;
  const onWake = () => {
    fired = true;
    resolve?.();
  };
  bus.on(key, onWake);
  return {
    woken: ms => (fired ? Promise.resolve() : new Promise(done => {
      const timer = setTimeout(done, ms);
      resolve = () => {
        clearTimeout(timer);
        done();
      };
    })),
    stop: () => bus.off(key, onWake),
  };
}

module.exports = {wake, listen};
