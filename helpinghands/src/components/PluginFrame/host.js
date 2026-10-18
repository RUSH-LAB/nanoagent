import {readEvents, SSE_CONTENT_TYPE} from '../../utils/eventStream.js';
import {
  chatEvent, failure, invalidRequest, promptHistory, reply, requestFrom, runEvent, themeEvent,
} from './protocol.js';

/**
 * The host side of `nanoagent.ui/v1` for one plugin frame: it answers the
 * page's requests through Mochi's own API, as the signed-in user in their own
 * workspace, and posts each run's events back to the frame.
 *
 * `frameWindow()` is the frame's window, the only one whose messages are
 * accepted; `request(path, init)` fetches a Mochi API path with the user's
 * session; `onVersion(app)` hears that the member chose another version of the
 * plugin, or to follow its latest (`plugin.version`), with the app as they now run it.
 * A draft (`plugin.source` 'draft', routes/apps.js) has no versions to choose:
 * it runs as its computer's RUSH Lab installed it, its prompts saying so.
 *
 * Every run belongs to the current plugin session, which the page starts or
 * resumes (`session.start`, `session.resume`): Mochi charges the run to it, and
 * keeps the session's conversation, which a resumed session continues. A run
 * is Mochi's, not the page's: the page closing or leaving only stops following
 * it, and a session resumed while it still answers a message follows its run
 * (`follow`) to its end. A run's stream that drops (Mochi restarted, the
 * network went away) is followed again once Mochi answers: the page is told
 * the run starts over (`chat.restart`), as following replays it from its first
 * event, or, when it ended meanwhile, given the turn the session kept
 * (`chat.turn`). Only `cancel` stops one.
 */
// As long as the member's computer holds a run for Mochi to take up again (runner/protocol.js HOLD_MS).
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

export function createBridgeHost({frameWindow, plugin, workspaceId, theme, request, onVersion}) {
  const runs = new Map(); // runId -> {controller, session}, the controller of its stream now
  // Each session's conversation, by id: a run left going in one session keeps its turn there.
  const turns = new Map();
  let session = null;
  const draft = plugin.source === 'draft';
  // A draft's sessions are apart from those with the plugin installed (routes/apps.js).
  const sessionsPath = `/api/${draft ? 'app-drafts' : 'apps'}/${encodeURIComponent(plugin.id)}/sessions`;
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
   * Follow session `id`'s run `runId` again after its stream dropped, trying until Mochi answers
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
        // Mochi is not back yet.
      }
      if (controller.signal.aborted) return {error: 'Cancelled'};
      if (response?.status === 404) return {ended: true};
      if (response?.ok && (response.headers.get('content-type') ?? '').includes(SSE_CONTENT_TYPE)) return {response};
      // Mochi refused it for a reason waiting does not change (signed out, no access).
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
      body: JSON.stringify({prompt: text, messages: promptHistory(turns.get(id)), appId: plugin.id, sessionId: id, ...(draft ? {draft: true} : {})}),
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

  const methods = {
    'describe': async () => ({result: {plugin, workspace: {id: workspaceId}, theme: currentTheme}}),
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
    'sessions.list': async () => {
      const response = await request(sessionsPath);
      if (!response.ok) throw await failed(response, 'Could not list the sessions');
      return {result: {sessions: (await response.json()).sessions}};
    },
    'session.get': async ({id}) => ({
      result: {session: await readSession(`${sessionsPath}/${id}`, undefined, 'Could not read the session')},
    }),
    'session.start': async () => enter(await readSession(sessionsPath, {method: 'POST'}, 'Could not start a session')),
    'session.resume': async ({id}) => enter(await readSession(`${sessionsPath}/${id}`, undefined, 'Could not open the session')),
    'plugin.version': async ({version}) => {
      if (draft) throw new Error('A draft runs from its folder: run rushlab preview again');
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
    /** Stop following every run; the frame is going away, and the runs go on. */
    close() {
      for (const run of runs.values()) run.controller.abort();
    },
  };
}
