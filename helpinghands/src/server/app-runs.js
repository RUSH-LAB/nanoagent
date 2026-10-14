'use strict';

const crypto = require('crypto');
const {HOLD_MS} = require('../runner/protocol');
const {completionPayload} = require('./ai');

// Why a run ended without its answer, when nothing else said so.
const LOST = 'Mochi Lab stopped while answering, so this message was not answered. Send it again.';
const NOT_BACK = `Mochi Lab was not back within ${HOLD_MS / 60_000} minutes, so this message was not answered. Send it again.`;
const FAILED = 'AI request failed. Please try again later.';

/**
 * The plugin runs going on, at most one per session. A run is not the
 * connection's that started it: a page closed, reloaded or left mid-answer
 * leaves it going, and a page that opens the session meanwhile follows it to
 * its end. It is kept in PostgreSQL (migration 0028) and by the member's
 * computer, which holds it across its connections (runner/protocol.js): when
 * Mochi restarts, the computer's next hello hands its runs to this process,
 * which takes each up again from its first frame, and records as interrupted
 * one the computer does not have any more, or one whose computer was not back
 * within HOLD_MS. A run ends with its turn in the session, answered or not,
 * and then the computer lets it go. Only cancelling stops one.
 */
function createAppRuns({sessions, agentSync, runners, aiMeter}) {
  const live = new Map(); // session id -> this process's run
  const waiting = new Map(); // session id -> followers of a run not taken up yet
  const bootedAt = Date.now();
  const contextOf = row => ({userId: row.userId, workspaceId: row.workspaceId});

  async function charge(context, row, result, ran) {
    try {
      await aiMeter.record(context, 'app', result, {ran, local: true, pluginId: row.pluginId, sessionId: row.sessionId});
    } catch (error) {
      console.error('[apps] Could not record a run\'s usage:', error.message);
    }
  }

  /** Make `row` this process's run, `work(run)` doing it; those waiting on its session follow it. */
  function begin(row, work) {
    const controller = new AbortController();
    const events = [];
    const followers = new Set();
    const run = {
      id: row.id,
      signal: controller.signal,
      cancel: () => controller.abort(),
      send(event, data) {
        events.push({event, data});
        for (const follower of followers) follower.onEvent(event, data);
      },
      /** Pass every event so far to `onEvent`, then each as it comes, then `onEnd`; returns an unsubscribe. */
      follow(onEvent, onEnd) {
        for (const {event, data} of events) onEvent(event, data);
        const follower = {onEvent, onEnd};
        followers.add(follower);
        return () => followers.delete(follower);
      },
    };
    live.set(row.sessionId, run);
    for (const waiter of waiting.get(row.sessionId) ?? []) waiter.stop = run.follow(waiter.onEvent, waiter.onEnd);
    waiting.delete(row.sessionId);
    run.ended = work(run).finally(() => {
      live.delete(row.sessionId);
      for (const follower of followers) follower.onEnd();
    });
    return run;
  }

  /**
   * Do the run `row` on its member's computer, `resume` taking it up from its
   * first frame, and end it: write what it did back, keep its turn, charge it,
   * and let the computer forget it. `request` is what NanoAgent is asked.
   */
  async function execute(run, row, {request, resume}) {
    const context = contextOf(row);
    let ran = row.ran;
    let marked = null;
    const markRan = () => {
      if (ran) return;
      ran = true;
      marked = sessions.markRunRan(context, row.id);
    };
    const tools = [];
    let folder = row.folder ? {workspace: row.folder, sent: row.sent} : null;
    let result;
    try {
      const ai = await runners.aiFor(row.userId);
      if (!folder) {
        folder = await agentSync.prepare(context, ai);
        await sessions.setRunFolder(context, row.id, folder);
      }
      result = await ai.stream({
        ...request,
        app: row.pluginId,
        install: row.install,
        workspace: folder.workspace,
        run: {id: row.id, resume},
        signal: run.signal,
        onDelta: text => {
          markRan();
          run.send('delta', {text});
        },
        onEvent: event => {
          if (event.type === 'step.completed') markRan();
          if (event.type === 'tool.completed' || event.type === 'tool.failed') {
            tools.push({name: event.call.name, arguments: event.call.arguments, output: event.call.output, isError: event.type === 'tool.failed'});
          }
          if (event.type !== 'output_text.delta') run.send('agent', event);
        },
      });
    } catch (error) {
      result = {error: error.message || FAILED, status: error.status || 502};
    }
    // What the run did in its folder is the member's, answered or not.
    let unsaved = null;
    if (folder) {
      try {
        await agentSync.finish(context, await runners.aiFor(row.userId), folder);
      } catch (error) {
        unsaved = `What the run did could not be written back to your agent folder: ${error.message}`;
      }
    }
    const error = result.error ?? unsaved;
    let ended;
    try {
      await marked;
      ended = await sessions.endRun(context, row.id, {prompt: row.prompt, answer: result.error ? '' : result.text, tools, error: error ?? null});
    } catch (problem) {
      // The computer keeps the run until it is let go, so the next Mochi to hear of it ends it.
      console.error('[apps] Could not keep a run\'s turn:', problem.message);
      return run.send('error', {error: 'Mochi could not keep this answer. It is kept when Mochi Lab next connects.', status: 500});
    }
    // Charged once, by whichever ended it.
    if (ended) await charge(context, row, result, ran);
    runners.release(row.userId, row.id);
    if (error) run.send('error', {error, status: result.status || 502});
    else run.send('done', completionPayload(result));
  }

  /** End the run `row`, which no process is doing any more, as not answered, for `reason`. */
  async function interrupt(row, reason) {
    const context = contextOf(row);
    let error = reason;
    if (row.folder) {
      try {
        await agentSync.finish(context, await runners.aiFor(row.userId), {workspace: row.folder, sent: row.sent});
      } catch (problem) {
        error = `${reason} What it did could not be written back to your agent folder: ${problem.message}`;
      }
    }
    if (await sessions.endRun(context, row.id, {prompt: row.prompt, answer: '', tools: [], error})) {
      await charge(context, row, null, row.ran);
    }
    for (const waiter of waiting.get(row.sessionId) ?? []) {
      waiter.onEvent('error', {error, status: 503});
      waiter.onEnd();
    }
    waiting.delete(row.sessionId);
  }

  return Object.freeze({
    /**
     * Start answering `prompt` in the caller's session `sessionId` with
     * `pluginId`, on the install `request.install`; refuses a session already
     * answering one (SessionError 409). The run, to `follow`.
     */
    async start(context, {pluginId, sessionId, prompt, request}) {
      const id = crypto.randomUUID();
      await sessions.startRun(context, pluginId, sessionId, {id, prompt, install: request.install});
      const row = {
        id, workspaceId: context.workspaceId, userId: context.userId, sessionId, pluginId, prompt,
        install: request.install, folder: null, sent: null, ran: false,
      };
      return begin(row, run => execute(run, row, {request, resume: false}));
    },

    /**
     * The runs the member's computer holds that no call of this process has
     * (server/runner.js onRuns): each of theirs this process is not doing is
     * taken up again where the computer has it, and recorded as interrupted
     * where it does not; one Mochi has no record of is let go.
     */
    async adopt(userId, ids) {
      const held = new Set(ids);
      for (const row of await sessions.runs({userId, workspaceId: null})) {
        const had = held.delete(row.id);
        if (live.has(row.sessionId)) continue;
        if (had) begin(row, run => execute(run, row, {request: {}, resume: true}));
        else await interrupt(row, LOST);
      }
      for (const id of held) runners.release(userId, id);
    },

    /**
     * Record as interrupted each of the caller's runs no process is doing once
     * this one has been up HOLD_MS: their computer was not back to hand them over.
     */
    async settle(context) {
      if (Date.now() - bootedAt < HOLD_MS) return;
      for (const row of await sessions.runs(context)) {
        if (!live.has(row.sessionId)) await interrupt(row, NOT_BACK);
      }
    },

    /**
     * Follow the run of session `sessionId`, which is answering a message: every
     * event so far and then each as it comes, then `onEnd`; one not taken up yet
     * (Mochi restarted) is followed once it is. Returns an unsubscribe.
     */
    subscribe(sessionId, onEvent, onEnd) {
      const run = live.get(sessionId);
      if (run) return run.follow(onEvent, onEnd);
      const waiter = {onEvent, onEnd, stop: null};
      if (!waiting.has(sessionId)) waiting.set(sessionId, new Set());
      waiting.get(sessionId).add(waiter);
      return () => {
        waiter.stop?.();
        waiting.get(sessionId)?.delete(waiter);
      };
    },

    /** Stop the caller's run in session `sessionId`; false when it is not answering a message. */
    async cancel(context, sessionId) {
      const run = live.get(sessionId);
      if (run) {
        run.cancel();
        return true;
      }
      const row = (await sessions.runs(context)).find(one => one.sessionId === sessionId);
      if (!row) return false;
      await interrupt(row, 'Stopped before Mochi Lab was back.');
      return true;
    },
  });
}

module.exports = {createAppRuns};
