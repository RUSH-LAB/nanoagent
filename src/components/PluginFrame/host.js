import {readEvents, SSE_CONTENT_TYPE} from '../../utils/eventStream.js';
import {
  base64ToBytes, bytesToBase64, chatEvent, failure, invalidRequest, promptHistory,
  reply, requestFrom, runEvent, taskEvent, themeEvent,
} from './protocol.js';

/**
 * The host side of `nanoagent.ui/v1` for one plugin frame: it answers the
 * page's requests through Mochi's own API, as the signed-in user in their own
 * workspace, and posts each run's events back to the frame.
 *
 * `frameWindow()` is the frame's window, the only one whose messages are
 * accepted; `request(path, init)` fetches a Mochi API path with the user's
 * session. The `prompt` conversation lives as long as the host does.
 */
export function createBridgeHost({frameWindow, plugin, workspaceId, theme, request}) {
  const runs = new Map();
  const turns = [];
  let currentTheme = theme;
  let runCount = 0;
  // The page's origin is opaque, so there is no origin to name but '*'.
  const post = message => frameWindow()?.postMessage(message, '*');

  async function failed(response, label) {
    const data = await response.json().catch(() => ({}));
    return new Error(data.error || `${label} (${response.status})`);
  }

  async function startRun(path, body, label) {
    const controller = new AbortController();
    const response = await request(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes(SSE_CONTENT_TYPE)) {
      throw await failed(response, label);
    }
    runCount += 1;
    const runId = `run-${runCount}`;
    runs.set(runId, controller);
    return {runId, response, controller};
  }

  /** Read a run's events into `onEvent`; the reason it stopped early, or null when it finished. */
  async function follow({runId, response, controller}, onEvent, closedEarly) {
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

  async function runTask({task, arguments: args}) {
    const run = await startRun(
      `/api/apps/${encodeURIComponent(plugin.id)}/tasks/${encodeURIComponent(task)}/runs`,
      {arguments: args},
      `Could not run ${task}`,
    );
    const after = async () => {
      const stopped = await follow(run, ({data}) => {
        const mapped = taskEvent(data);
        if (!mapped) return false;
        post(runEvent(mapped.event, run.runId, mapped.data));
        return mapped.event === 'task.done';
      }, 'The connection closed before the task finished');
      if (stopped) {
        post(runEvent('task.error', run.runId, {message: stopped}));
        post(runEvent('task.done', run.runId, {}));
      }
    };
    return {result: {runId: run.runId}, after};
  }

  async function prompt({text}) {
    const run = await startRun(
      '/api/ai/stream',
      {prompt: text, messages: promptHistory(turns), appId: plugin.id},
      'Could not send the prompt',
    );
    const after = async () => {
      let answer = null;
      const stopped = await follow(run, parsed => {
        const mapped = chatEvent(parsed);
        if (!mapped) return false;
        post(runEvent(mapped.event, run.runId, mapped.data));
        if (mapped.event === 'chat.answer') answer = mapped.data.text;
        return Boolean(mapped.final);
      }, 'The connection closed before the app finished');
      if (stopped) post(runEvent('chat.error', run.runId, {message: stopped}));
      if (answer !== null) turns.push({prompt: text, answer});
      post(runEvent('chat.done', run.runId, {}));
    };
    return {result: {runId: run.runId}, after};
  }

  const fileQuery = path => `path=${encodeURIComponent(path)}`;

  const methods = {
    'describe': async () => ({result: {plugin, workspace: {id: workspaceId}, theme: currentTheme}}),
    runTask,
    prompt,
    'cancel': async ({runId}) => {
      const controller = runs.get(runId);
      if (!controller) throw new Error(`No run ${runId} is in progress`);
      controller.abort();
      return {result: {}};
    },
    'workspace.list': async () => {
      const response = await request('/api/agent-files');
      if (!response.ok) throw await failed(response, 'Could not list the workspace');
      const {files} = await response.json();
      return {result: {files: files.map(({path, size}) => ({path, size}))}};
    },
    'workspace.read': async ({path}) => {
      const response = await request(`/api/agent-files/content?${fileQuery(path)}`);
      if (!response.ok) throw await failed(response, `Could not read ${path}`);
      // The server sends UTF-8 text as text/plain and anything else as itself.
      if ((response.headers.get('content-type') ?? '').startsWith('text/plain')) {
        return {result: {text: await response.text()}};
      }
      return {result: {base64: bytesToBase64(new Uint8Array(await response.arrayBuffer()))}};
    },
    'workspace.write': async ({path, text, base64}) => {
      const response = await request(`/api/agent-files/content?${fileQuery(path)}`, {
        method: 'PUT',
        headers: {'Content-Type': typeof text === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream'},
        body: typeof text === 'string' ? text : base64ToBytes(base64),
      });
      if (!response.ok) throw await failed(response, `Could not write ${path}`);
      return {result: {}};
    },
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
    /** Stop every run still going; the frame is going away. */
    close() {
      for (const controller of runs.values()) controller.abort();
    },
  };
}
