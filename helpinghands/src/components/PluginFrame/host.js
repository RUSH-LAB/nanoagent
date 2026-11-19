import {readEvents, SSE_CONTENT_TYPE} from '../../utils/eventStream.js';
import {awaitWorker, followHarness, linkLine} from './harness.js';
import {
  chatEvent, failure, invalidRequest, promptHistory, reply, requestFrom, runEvent, themeEvent,
} from './protocol.js';

/**
 * The host side of `nanoagent.ui/v1` for one plugin frame: it answers the
 * page's requests through RUSH's own API, as the signed-in user in their own
 * workspace, and posts each run's events back to the frame.
 *
 * `frameWindow()` is the frame's window, the only one whose messages are
 * accepted; `request(path, init)` fetches a RUSH API path with the user's
 * session; `onVersion(app)` hears that the member chose another version of the
 * plugin, or to follow its latest (`plugin.version`), with the app as they now run it.
 * `shown()` is the session the page's address names, which the page opens on
 * (`describe`), and `onShown(id)` hears the session the page shows, or null
 * for its Dashboard (`session.shown`), so that reloading opens it again.
 *
 * Every run belongs to the current plugin session, which the page starts or
 * resumes (`session.start`, `session.resume`): RUSH charges the run to it, and
 * keeps the session's conversation, which a resumed session continues. A run
 * is RUSH's, not the page's: the page closing or leaving only stops following
 * it, and a session resumed while it still answers a message follows its run
 * (`follow`) to its end. A run's stream that drops (RUSH restarted, the
 * network went away) is followed again once RUSH answers: the page is told
 * the run starts over (`chat.restart`), as following replays it from its first
 * event, or, when it ended meanwhile, given the turn the session kept
 * (`chat.turn`). Only `cancel` stops one.
 *
 * The Harness tab's session (`harness.run`) is a benchmark run of one case, the page's request to one of the plugin's tasks
 * worked by a reference harness on the member's own worker, or of the free-form Terminal (`shell`, no task, request or case), on a
 * terminal the member works in: RUSH queues and records it, and the page talks to its terminals on this computer, through RUSH
 * Lab, not through RUSH (./harness.js). The page hears the terminal's output as it comes and the outcome, through `harness.done`,
 * and sends what is typed (`harness.input`) and the terminal's size (`harness.resize`), each to one of its terminals (0 the first);
 * `harness.open` opens another in a free-form session, `harness.close` closes one, and `harness.cancel` cancels the run. The frame
 * going away, or the page no longer following it, leaves the session running: started again with neither `resume` nor `start`, the
 * page is given it again (RUSH answers with the member's free-form session on the plugin that still runs), and its link replays each
 * terminal's output from its first byte. A free-form session started with `resume` (an ended one's attempt id, clicked on the
 * Dashboard) resumes it: the worker puts back what it kept of it on this computer, and with `chat` too (`{agent, id}`, one of its chats) reopens that
 * conversation. One started with `start` (an agent's CLI command, the Dashboard's New session under that agent) runs it in its first
 * terminal. Either one started with `join` (a chat clicked on the Dashboard) is, while the member's free-form session still runs, that
 * session instead, `harness.session` saying so (`joined`), and `harness.reopen` then opens the chat in its next terminal: from the ended
 * session that holds it (`{resume, chat}`) or, one that cannot be reopened, its agent anew with why (`{start, line}`). Once RUSH has
 * queued it, `harness.session` names its attempt.
 *
 * The Leaderboard tab reads the harnesses ranked on the plugin, whatever task (`leaderboard`), and the trace of one of the member's
 * own runs on it (`leaderboard.trace`, its attempt's events).
 *
 * The Dashboard lists the chats the member's Harness tab sessions on the plugin held beside their own chats (`sessions.list`'s
 * `terminals`, each a conversation of an agent CLI), and archives or restores one as it does a chat (`terminal.archive`, by its key).
 */
// As long as the member's computer holds a run for RUSH to take up again (runner/protocol.js HOLD_MS).
const RECONNECT_MS = 10 * 60_000;
const RECONNECT_WAIT_MS = 2000;
const CLOSED = 'The connection closed before the app finished. The session keeps its answer when it does: open the session again to see it.';
const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, {once: true});
});

export function createBridgeHost({frameWindow, plugin, workspaceId, theme, request, onVersion, shown, onShown, pause = sleep}) {
  const runs = new Map(); // runId -> {controller, session}, the controller of its stream now
  // runId -> {controller, run, attempt, link, sending}: a Harness tab session's controller, its benchmark run's and attempt's ids, the
  // link to its terminals once made, and its input in flight, which goes to the terminals in order.
  const harnessRuns = new Map();
  // Each session's conversation, by id: a run left going in one session keeps its turn there.
  const turns = new Map();
  let session = null;
  const sessionsPath = `/api/apps/${encodeURIComponent(plugin.id)}/sessions`;
  let currentTheme = theme;
  let runCount = 0;
  // The page's origin is opaque, so there is no origin to name but '*'.
  const post = message => frameWindow()?.postMessage(message, '*');

  async function failed(response, label) {
    const data = await response.json().catch(() => ({}));
    return new Error(data.error || `${label} (${response.status})`);
  }

  /** Open the event stream of a run of session `id` at `path`. */
  async function startRun(id, path, init, label) {
    const controller = new AbortController();
    const response = await request(path, {...init, signal: controller.signal});
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes(SSE_CONTENT_TYPE)) {
      throw await failed(response, label);
    }
    runCount += 1;
    const runId = `run-${runCount}`;
    runs.set(runId, {controller, session: id});
    return {runId, response, controller};
  }

  /** Read a stream's events into `onEvent`: true once one ends the run, false when the stream stopped first. */
  async function readRun(response, onEvent) {
    let finished = false;
    try {
      await readEvents(response, parsed => {
        if (!finished) finished = onEvent(parsed);
      });
    } catch {
      // Cancelled, or the connection dropped; the caller tells which.
    }
    return finished;
  }

  /**
   * Follow session `id`'s run `runId` again after its stream dropped, trying until RUSH answers
   * or RECONNECT_MS passes: `{response}`, its stream from its first event; `{ended: true}` when
   * the session answers no message any more; or `{error}`.
   */
  async function reconnect(id, runId) {
    const deadline = Date.now() + RECONNECT_MS;
    for (;;) {
      const controller = new AbortController();
      runs.set(runId, {controller, session: id});
      let response = null;
      try {
        response = await request(`${sessionsPath}/${id}/run`, {signal: controller.signal});
      } catch {
        // RUSH is not back yet.
      }
      if (controller.signal.aborted) return {error: 'Cancelled'};
      if (response?.status === 404) return {ended: true};
      if (response?.ok && (response.headers.get('content-type') ?? '').includes(SSE_CONTENT_TYPE)) return {response};
      // RUSH refused it for a reason waiting does not change (signed out, no access).
      if (response && response.status < 500) return {error: (await failed(response, 'Could not follow the session\'s answer')).message};
      if (Date.now() > deadline) return {error: CLOSED};
      await sleep(RECONNECT_WAIT_MS, controller.signal);
      if (controller.signal.aborted) return {error: 'Cancelled'};
    }
  }

  function current() {
    if (!session) throw new Error('Start or resume a session first');
    return session;
  }

  async function readSession(path, init, label) {
    const response = await request(path, init);
    if (!response.ok) throw await failed(response, label);
    return (await response.json()).session;
  }

  // The message each session was answering when it was last opened, by id.
  const answering = new Map();

  /** Make `opened` the current session, continuing its conversation. */
  function enter(opened) {
    session = opened.id;
    // A turn the session did not answer (`error`) is no part of the conversation the agent continues.
    turns.set(opened.id, opened.chat.filter(turn => !turn.error).map(({prompt, answer}) => ({prompt, answer})));
    answering.set(opened.id, opened.running?.prompt ?? null);
    return {result: {session: opened}};
  }

  async function prompt({text}) {
    const id = current();
    const run = await startRun(id, '/api/ai/stream', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({prompt: text, messages: promptHistory(turns.get(id)), appId: plugin.id, sessionId: id}),
    }, 'Could not send the prompt');
    return {result: {runId: run.runId}, after: () => relay(run, id, text)};
  }

  /** Follow the run the current session was answering when it was opened. */
  async function follow() {
    const id = current();
    const text = answering.get(id);
    if (text === null) throw new Error('This session is not answering a message');
    const run = await startRun(id, `${sessionsPath}/${id}/run`, {}, 'Could not follow the session\'s answer');
    answering.set(id, null);
    return {result: {runId: run.runId, prompt: text}, after: () => relay(run, id, text)};
  }

  /**
   * Post a run's events to the frame, following it again whenever its stream drops, and keep its
   * turn when it is answered.
   */
  async function relay(run, id, text) {
    const {runId} = run;
    let answer = null;
    let response = run.response;
    for (;;) {
      answer = null;
      const finished = await readRun(response, parsed => {
        const mapped = chatEvent(parsed);
        if (!mapped) return false;
        post(runEvent(mapped.event, runId, mapped.data));
        if (mapped.event === 'chat.answer') answer = mapped.data.text;
        return Boolean(mapped.final);
      });
      if (finished) break;
      if (runs.get(runId).controller.signal.aborted) {
        post(runEvent('chat.error', runId, {message: 'Cancelled'}));
        break;
      }
      const again = await reconnect(id, runId);
      if (again.error) {
        post(runEvent('chat.error', runId, {message: again.error}));
        break;
      }
      if (again.ended) {
        // It ended while no stream followed it: what the session kept of it is its turn.
        try {
          const kept = await readSession(`${sessionsPath}/${id}`, undefined, 'Could not read the session');
          const turn = kept.chat.at(-1);
          post(runEvent('chat.turn', runId, {turn}));
          if (!turn.error) answer = turn.answer;
        } catch (error) {
          post(runEvent('chat.error', runId, {message: error.message}));
        }
        break;
      }
      post(runEvent('chat.restart', runId, {}));
      response = again.response;
    }
    runs.delete(runId);
    if (answer !== null) turns.get(id).push({prompt: text, answer});
    post(runEvent('chat.done', runId, {}));
  }

  async function harnessRun({harness, task, text, resume, start, chat, join}) {
    runCount += 1;
    const runId = `harness-${runCount}`;
    const controller = new AbortController();
    // `run` and `attempt` once RUSH has queued the session, which waits for the member's worker to be ready; `link` once its terminals
    // are linked.
    let linked;
    const entry = {controller, run: null, attempt: null, link: new Promise(resolve => (linked = resolve)), sending: Promise.resolve()};
    harnessRuns.set(runId, entry);
    const emit = (event, data) => post(runEvent(event, runId, data));
    const follow = async () => {
      try {
        await awaitWorker({request, emit, signal: controller.signal, sleep: ms => pause(ms, controller.signal)});
        if (controller.signal.aborted) return;
        const response = await request('/api/benchmark/sessions', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({plugin_id: plugin.id, task_id: task, harness, text, resume, start, chat, join, interactive: true}),
        });
        if (!response.ok) throw await failed(response, 'Could not start the harness');
        const {run, attempt_id: attempt, joined} = await response.json();
        Object.assign(entry, {run: run.run_id, attempt});
        // A page given its running session again follows it here alone.
        for (const other of harnessRuns.values()) if (other !== entry && other.attempt === attempt) other.controller.abort();
        emit('harness.session', {attemptId: attempt, joined: Boolean(joined)});  // the session the page's terminals are, which the Dashboard's chats name
        if (controller.signal.aborted) return;
        await followHarness({attemptId: entry.attempt, request, emit, signal: controller.signal, linked});
      } catch (error) {
        if (!controller.signal.aborted) emit('harness.error', {message: error.message});
      } finally {
        harnessRuns.delete(runId);
        emit('harness.done', {});
      }
    };
    return {result: {runId}, after: follow};
  }

  /** Send a Harness tab session's terminal `input` over its link, after what was sent before it and once the link is made. */
  function toTerminal(runId, input) {
    const run = harnessRuns.get(runId);
    if (!run) throw new Error(`No harness run ${runId} is in progress`);
    run.sending = run.sending.catch(() => {}).then(() => run.link).then(link => link.send(linkLine(input)));
    return run.sending.then(() => ({result: {}}));
  }
  /** End a Harness tab session: its run, or, before RUSH has queued it, the wait for the worker. */
  const cancelHarness = async run => {
    if (!run.run) return run.controller.abort();
    const response = await request(`/api/benchmark/runs/${run.run}/cancel`, {method: 'POST'});
    if (!response.ok) throw await failed(response, 'Could not cancel the harness');
  };

  const methods = {
    'describe': async () => ({result: {plugin, workspace: {id: workspaceId}, theme: currentTheme, session: shown()}}),
    prompt,
    follow,
    'cancel': async ({runId}) => {
      const run = runs.get(runId);
      if (!run) throw new Error(`No run ${runId} is in progress`);
      const response = await request(`${sessionsPath}/${run.session}/run`, {method: 'DELETE'});
      if (!response.ok) throw await failed(response, 'Could not cancel the run');
      run.controller.abort();
      return {result: {}};
    },
    'harness.run': harnessRun,
    'harness.cancel': async ({runId}) => {
      const run = harnessRuns.get(runId);
      if (!run) throw new Error(`No harness run ${runId} is in progress`);
      await cancelHarness(run);
      return {result: {}};
    },
    'harness.input': async ({runId, terminal, data}) => toTerminal(runId, {terminal, data}),
    'harness.resize': async ({runId, terminal, rows, cols}) => toTerminal(runId, {terminal, rows, cols}),
    // Another terminal of the session, `rows` by `cols`: its first size opens it, and its output comes over the link as the others' does.
    'harness.open': async ({runId, terminal, rows, cols}) => toTerminal(runId, {terminal, rows, cols}),
    'harness.close': async ({runId, terminal}) => toTerminal(runId, {terminal, close: true}),
    // A chat clicked on the Dashboard, in the next terminal of the session, whose output comes over the link as the others' does.
    'harness.reopen': async ({runId, rows, cols, reopen}) => toTerminal(runId, {reopen, rows, cols}),
    'leaderboard': async () => {
      const response = await request(`/api/benchmark/leaderboard?${new URLSearchParams({plugin_id: plugin.id})}`);
      if (!response.ok) throw await failed(response, 'Could not read the leaderboard');
      return {result: await response.json()};
    },
    'leaderboard.trace': async ({attemptId}) => {
      const events = [];
      for (let more = true; more;) {
        const response = await request(`/api/benchmark/attempts/${attemptId}/events?limit=1000&after=${events.at(-1)?.cursor ?? 0}`);
        if (!response.ok) throw await failed(response, 'Could not read the run\'s trace');
        const page = await response.json();
        events.push(...page.events);
        more = page.has_more;
      }
      return {result: {events}};
    },
    'sessions.list': async () => {
      const [chats, terminals] = await Promise.all([
        request(sessionsPath), request(`/api/benchmark/terminal-sessions?${new URLSearchParams({plugin_id: plugin.id})}`),
      ]);
      if (!chats.ok) throw await failed(chats, 'Could not list the sessions');
      if (!terminals.ok) throw await failed(terminals, 'Could not list the Harness sessions');
      return {result: {sessions: (await chats.json()).sessions, terminals: (await terminals.json()).chats}};
    },
    'terminal.archive': async ({attemptId, chat, archived}) => {
      const response = await request(`/api/benchmark/attempts/${attemptId}/archive`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({archived, chat}),
      });
      if (!response.ok) throw await failed(response, archived ? 'Could not archive the session' : 'Could not restore the session');
      return {result: await response.json()};
    },
    'session.get': async ({id}) => ({
      result: {session: await readSession(`${sessionsPath}/${id}`, undefined, 'Could not read the session')},
    }),
    'session.start': async () => enter(await readSession(sessionsPath, {method: 'POST'}, 'Could not start a session')),
    'session.resume': async ({id}) => enter(await readSession(`${sessionsPath}/${id}`, undefined, 'Could not open the session')),
    'session.shown': async ({id}) => ({result: {}, after: () => onShown(id)}),
    'plugin.version': async ({version}) => {
      const response = await request(`/api/apps/${encodeURIComponent(plugin.id)}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({version}),
      });
      if (!response.ok) throw await failed(response, 'Could not change the version');
      const {app} = await response.json();
      const {version: current, latest, repository, latestRepository} = app;
      return {result: {version: current, latest, repository, latestRepository}, after: () => onVersion(app)};
    },
    'session.archive': async ({id, archived}) => ({
      result: {
        session: await readSession(`${sessionsPath}/${id}`, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({archived}),
        }, archived ? 'Could not archive the session' : 'Could not restore the session'),
      },
    }),
  };

  return {
    /** The window `message` listener. */
    onMessage(event) {
      const accepted = requestFrom(event, frameWindow());
      if (!accepted) return;
      const problem = invalidRequest(accepted);
      if (problem) {
        post(failure(accepted.id, problem));
        return;
      }
      methods[accepted.method](accepted.params).then(
        ({result, after}) => {
          post(reply(accepted.id, result));
          after?.();
        },
        error => post(failure(accepted.id, error?.message || 'Request failed')),
      );
    },
    /** Tell the page the site's theme: when its frame loads, and whenever the theme changes. */
    setTheme(theme) {
      currentTheme = theme;
      post(themeEvent(theme));
    },
    /** Stop following every run, a Harness tab session's too; the frame is going away, and the runs go on. */
    close() {
      for (const run of [...runs.values(), ...harnessRuns.values()]) run.controller.abort();
    },
  };
}
