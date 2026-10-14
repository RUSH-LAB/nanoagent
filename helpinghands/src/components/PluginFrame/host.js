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
 * session.
 *
 * Every run belongs to the current plugin session, which the page starts or
 * resumes (`session.start`, `session.resume`): Mochi charges the run to it, and
 * keeps the session's conversation, which a resumed session continues. A run
 * is Mochi's, not the page's: the page closing or leaving only stops following
 * it, and a session resumed while it still answers a message follows its run
 * (`follow`) to its end. Only `cancel` stops one.
 */
export function createBridgeHost({frameWindow, plugin, workspaceId, theme, request}) {
  const runs = new Map(); // runId -> {controller, session}
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

  /** Read a run's events into `onEvent`; the reason it stopped early, or null when it finished. */
  async function readRun({runId, response, controller}, onEvent, closedEarly) {
    let finished = false;
    try {
      await readEvents(response, parsed => {
        if (!finished) finished = onEvent(parsed);
      });
    } catch {
      // Cancelled, or the connection dropped; told below.
    } finally {
      runs.delete(runId);
    }
    if (finished) return null;
    return controller.signal.aborted ? 'Cancelled' : closedEarly;
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

  /** Post a run's events to the frame, and keep its turn when it is answered. */
  async function relay(run, id, text) {
    let answer = null;
    const stopped = await readRun(run, parsed => {
      const mapped = chatEvent(parsed);
      if (!mapped) return false;
      post(runEvent(mapped.event, run.runId, mapped.data));
      if (mapped.event === 'chat.answer') answer = mapped.data.text;
      return Boolean(mapped.final);
    }, 'The connection closed before the app finished. The session keeps its answer when it does: open the session again to see it.');
    if (stopped) post(runEvent('chat.error', run.runId, {message: stopped}));
    if (answer !== null) turns.get(id).push({prompt: text, answer});
    post(runEvent('chat.done', run.runId, {}));
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
