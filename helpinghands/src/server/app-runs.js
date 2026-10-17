'use strict';

const crypto = require('crypto');
const {HOLD_MS} = require('../runner/protocol');
const {completionPayload, RUNNER_OFFLINE} = require('./ai');

// Why a run ended without its answer, when nothing else said so.
const LOST = 'RUSH Lab stopped while answering, so this message was not answered. Send it again.';
const NOT_BACK = `RUSH Lab was not back within ${HOLD_MS / 60_000} minutes, so this message was not answered. Send it again.`;
const FAILED = 'AI request failed. Please try again later.';
// Why a run in RUSH Lab cloud no process is doing any more ended: the process doing it stopped.
const CLOUD_LOST = 'RUSH Lab cloud stopped while answering, so this message was not answered. Send it again.';

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
 *
 * A run is on the NanoAgent the member's runs went to when it started
 * (server/runner.js aiFor), its `runner`: their computer, or RUSH Lab cloud
 * (cloud-runs.js). It is done, written back and charged there, whichever they
 * choose meanwhile. Nothing holds a cloud run across a restart: NanoAgent ends
 * it once its stream is gone, so a Mochi started since records it as
 * interrupted at once, with no computer to wait for.
 */
function createAppRuns({sessions, agentSync, runners, aiMeter}) {
  const live = new Map(); // session id -> this process's run
  const waiting = new Map(); // session id -> followers of a run not taken up yet
  const bootedAt = Date.now();
  const contextOf = row => ({userId: row.userId, workspaceId: row.workspaceId});

  // A run on the member's computer is theirs to pay for; one in RUSH Lab cloud is charged to the workspace.
  async function charge(context, row, result, ran) {
    try {
      await aiMeter.record(context, 'app', result, {ran, local: row.runner !== 'cloud', pluginId: row.pluginId, sessionId: row.sessionId});
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
   * Do the run `row` on `ai`, its runner's NanoAgent, `resume` taking it up from
   * its first frame, and end it: write what it did back, keep its turn, charge
   * it, and let the computer forget it. `request` is what NanoAgent is asked.
   */
  async function execute(run, row, {request, resume, ai}) {
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
      if (!folder) {
        folder = await agentSync.prepare(context, ai, row.pluginId);
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
          // A tool starts once the model has answered with its call: the run has cost something,
          // though a step is priced only once its tools are done.
          if (event.type === 'step.completed' || event.type === 'reasoning.delta' || event.type === 'tool.started') markRan();
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
        // From where it ran: RUSH Lab cloud, or the member's computer as it is connected now, as a
        // held run follows its computer to a new connection.
        const from = row.runner === 'cloud' ? ai : (runners.computer(row.userId) ?? ai);
        await agentSync.finish(context, from, row.pluginId, folder);
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
      return run.send('error', {error: 'Mochi could not keep this answer. It is kept when RUSH Lab next connects.', status: 500});
    }
    // Charged once, by whichever ended it.
    if (ended) await charge(context, row, result, ran);
    // Only a computer holds its runs, until it is told Mochi kept what one did.
    if (row.runner !== 'cloud') runners.release(row.userId, row.id);
    if (error) run.send('error', {error, status: result.status || 502});
    else run.send('done', completionPayload(result));
  }

  /** End the run `row`, which no process is doing any more, as not answered, for `reason`. */
  async function interrupt(row, reason) {
    const context = contextOf(row);
    let error = row.runner === 'cloud' ? CLOUD_LOST : reason;
    // Only a computer's run can be taken up and written back after its process: its computer holds it.
    if (row.folder && row.runner !== 'cloud') {
      try {
        const computer = runners.computer(row.userId);
        if (!computer) throw new Error(RUNNER_OFFLINE);
        await agentSync.finish(context, computer, row.pluginId, {workspace: row.folder, sent: row.sent});
      } catch (problem) {
        error = `${error} What it did could not be written back to your agent folder: ${problem.message}`;
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
     * `pluginId`, on the install `request.install` of `ai`, the NanoAgent the
     * member's runs go to (server/runner.js aiFor); refuses a session already
     * answering one (SessionError 409). The run, to `follow`.
     */
    async start(context, {pluginId, sessionId, prompt, request, ai}) {
      const id = crypto.randomUUID();
      // A gateway that is not the member's own computer's is RUSH Lab cloud's (server/ai.js `local`).
      const runner = ai.local ? 'computer' : 'cloud';
      await sessions.startRun(context, pluginId, sessionId, {id, prompt, install: request.install, runner});
      const row = {
        id, workspaceId: context.workspaceId, userId: context.userId, sessionId, pluginId, prompt,
        install: request.install, runner, folder: null, sent: null, ran: false,
      };
      return begin(row, run => execute(run, row, {request, resume: false, ai}));
    },

    /**
     * The runs the member's computer holds that no call of this process has
     * (server/runner.js onRuns): each of theirs this process is not doing is
     * taken up again where the computer has it, and recorded as interrupted
     * where it does not; one Mochi has no record of is let go.
     */
    async adopt(userId, ids) {
      // The computer that said hello, which holds them; gone again, its next hello hands them over.
      const computer = runners.computer(userId);
      if (!computer) return;
      const held = new Set(ids);
      for (const row of await sessions.runs({userId, workspaceId: null})) {
        const had = held.delete(row.id);
        // A run in RUSH Lab cloud is no computer's to hand over: settle ends it.
        if (live.has(row.sessionId) || row.runner === 'cloud') continue;
        if (had) begin(row, run => execute(run, row, {request: {}, resume: true, ai: computer}));
        else await interrupt(row, LOST);
      }
      for (const id of held) runners.release(userId, id);
    },

    /**
     * Record as interrupted each of the caller's runs no process is doing: at
     * once one in RUSH Lab cloud an earlier process started, which ended with
     * it, and once this process has been up HOLD_MS one on a computer that was
     * not back to hand it over. A cloud run this process started is its own,
     * live or about to be, so only one started before it is ended here.
     */
    async settle(context) {
      const holding = Date.now() - bootedAt < HOLD_MS;
      for (const row of await sessions.runs(context)) {
        if (live.has(row.sessionId)) continue;
        if (row.runner === 'cloud') {
          if (row.startedAt < bootedAt) await interrupt(row, CLOUD_LOST);
        } else if (!holding) {
          await interrupt(row, NOT_BACK);
        }
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
      await interrupt(row, 'Stopped before RUSH Lab was back.');
      return true;
    },
  });
}

module.exports = {createAppRuns};
