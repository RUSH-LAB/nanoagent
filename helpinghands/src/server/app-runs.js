'use strict';

// The plugin runs going on, at most one per session. A run is kept here and not
// on the connection that started it, so it outlives the page: a page closed,
// reloaded or left mid-answer leaves the run going, the session keeps its turn
// when it ends (postgres/sessions.js), and a page that opens the session in the
// meantime follows it to its end. Only cancelling stops one. In memory, like
// the members' computers the runs go to (runner.js), which are connected to
// this one process.

/** A run the request cannot have: `status` is the HTTP status that says why. */
class AppRunError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AppRunError';
    this.status = status;
  }
}

function createAppRuns() {
  const runs = new Map(); // session id -> run

  return {
    /**
     * Run `work(run)` as the session's run, `prompt` its message. `run.send(event, data)`
     * passes an event to whoever follows it, and `run.signal` aborts when it is cancelled.
     * Refuses a session already answering a message.
     */
    start(sessionId, prompt, work) {
      if (runs.has(sessionId)) throw new AppRunError(409, 'This session is still answering a message');
      const controller = new AbortController();
      const events = [];
      const followers = new Set();
      const run = {
        prompt,
        signal: controller.signal,
        cancel: () => controller.abort(),
        send(event, data) {
          events.push({event, data});
          for (const follower of followers) follower(event, data);
        },
        /** Pass every event so far to `onEvent`, then each as it comes, then `onEnd`; returns an unsubscribe. */
        follow(onEvent, onEnd) {
          for (const {event, data} of events) onEvent(event, data);
          const follower = (event, data) => (event === null ? onEnd() : onEvent(event, data));
          followers.add(follower);
          return () => followers.delete(follower);
        },
      };
      runs.set(sessionId, run);
      run.ended = Promise.resolve()
        .then(() => work(run))
        .finally(() => {
          runs.delete(sessionId);
          for (const follower of followers) follower(null);
        });
      return run;
    },
    /** The session's run, or null when it is not answering a message. */
    get(sessionId) {
      return runs.get(sessionId) ?? null;
    },
  };
}

module.exports = {createAppRuns, AppRunError};
