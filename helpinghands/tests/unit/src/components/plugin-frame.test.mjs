import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL, chatEvent, invalidRequest, promptHistory, requestFrom,
} from '../../../../src/components/PluginFrame/protocol.js';
import {createBridgeHost} from '../../../../src/components/PluginFrame/host.js';

const PLUGIN = {id: 'arxiv-source', name: 'arXiv Source Downloader', tasks: [{id: 'save-paper-source', inputSchema: {type: 'object'}}]};
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const eventStream = text => new Response(text, {headers: {'Content-Type': 'text/event-stream'}});

const SESSION = '00000000-0000-4000-8000-000000000001';
const SESSIONS = '/api/apps/arxiv-source/sessions';
const sessionWith = (chat = []) => ({id: SESSION, pluginId: 'arxiv-source', title: '', chat, calls: []});

/**
 * A host on a fake frame, with `request` answering Mochi API paths, and a
 * session already started (with `chat` as its conversation); every message
 * posted and every request made after that is in `posted` and `calls`.
 */
async function hostWith(request, {chat = [], started = true} = {}) {
  const posted = [];
  const frame = {postMessage: (message, origin) => posted.push({message, origin})};
  const calls = [];
  const host = createBridgeHost({
    frameWindow: () => frame,
    plugin: PLUGIN,
    workspaceId: 'ws-1',
    theme: 'light',
    request: async (path, init = {}) => {
      calls.push({path, init});
      return request(path, init);
    },
  });
  const send = (id, method, params = {}) => host.onMessage({source: frame, data: {protocol: PROTOCOL, id, method, params}});
  if (started) {
    const opening = request;
    request = () => Response.json({session: sessionWith(chat)});
    send('start', 'session.resume', {id: SESSION});
    await until(() => posted.length);
    posted.length = 0;
    calls.length = 0;
    request = opening;
  }
  return {host, frame, posted, calls, send};
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('timed out waiting for the host');
}

const messages = posted => posted.map(({message}) => message);
const eventsOf = (posted, runId) => messages(posted).filter(message => message.runId === runId).map(({event, data}) => [event, data]);

describe('nanoagent.ui/v1 requests', () => {
  const frame = {};
  const message = data => ({source: frame, data});

  it('accepts only the frame\'s own messages, in this protocol, with an id', () => {
    const request = {protocol: PROTOCOL, id: '1', method: 'describe', params: {}};
    assert.deepEqual(requestFrom(message(request), frame), {id: '1', method: 'describe', params: {}});
    assert.equal(requestFrom({source: {}, data: request}, frame), null);
    assert.equal(requestFrom(message(request), null), null);
    assert.equal(requestFrom(message({...request, protocol: 'nanoagent.ui/v2'}), frame), null);
    assert.equal(requestFrom(message({...request, id: 1}), frame), null);
    assert.equal(requestFrom(message({...request, id: ''}), frame), null);
    assert.equal(requestFrom(message('describe'), frame), null);
  });

  it('checks each method\'s params', () => {
    const valid = [
      ['describe', {}],
      ['prompt', {text: 'hi'}],
      ['follow', {}],
      ['cancel', {runId: 'run-1'}],
      ['session.archive', {id: SESSION, archived: true}],
    ];
    for (const [method, params] of valid) assert.equal(invalidRequest({method, params}), null, method);
    const invalid = [
      ['toString', {}],
      ['shell', {}],
      ['describe', undefined],
      ['describe', []],
      ['runTask', {task: 'save-paper-source', arguments: {}}],
      ['prompt', {text: '   '}],
      ['prompt', {text: 'x'.repeat(50_001)}],
      ['cancel', {}],
      ['workspace.write', {path: 'a.txt', text: ''}],
      ['session.get', {id: 'not-an-id'}],
      ['session.resume', {}],
      ['session.save', {state: {}}],
      ['session.archive', {id: SESSION}],
      ['session.archive', {id: 'not-an-id', archived: true}],
    ];
    for (const [method, params] of invalid) assert.equal(typeof invalidRequest({method, params}), 'string', method);
  });
});

describe('run events on the bridge', () => {
  it('maps the chat stream onto chat events', () => {
    assert.deepEqual(chatEvent({event: 'delta', data: {text: 'he'}}), {event: 'chat.delta', data: {text: 'he'}});
    assert.deepEqual(chatEvent({event: 'agent', data: {type: 'tool.failed', call: {name: 'move', arguments: {a: 1}, output: 'bad'}}}), {
      event: 'chat.tool', data: {name: 'move', arguments: {a: 1}, output: 'bad', isError: true},
    });
    assert.equal(chatEvent({event: 'agent', data: {type: 'step.completed'}}), null);
    assert.deepEqual(chatEvent({event: 'done', data: {text: 'all done'}}), {event: 'chat.answer', data: {text: 'all done', metrics: null}, final: true});
    assert.deepEqual(chatEvent({event: 'error', data: {error: 'nope'}}), {event: 'chat.error', data: {message: 'nope'}, final: true});
  });

  it('keeps the conversation within what the server accepts', () => {
    const turns = Array.from({length: 13}, (_, index) => ({prompt: `q${index}`, answer: 'a'.repeat(10_001)}));
    const history = promptHistory(turns);
    assert.equal(history.length, 24);
    assert.deepEqual(history[0], {role: 'user', content: 'q1'});
    assert.equal(history[1].content.length, 10_000);
  });
});

describe('the bridge host', () => {
  it('describes the plugin, workspace and theme, replying to origin *', async () => {
    const {posted, send} = await hostWith(() => assert.fail('describe needs no request'));
    send('d1', 'describe');
    await until(() => posted.length);
    assert.deepEqual(posted, [{
      message: {protocol: PROTOCOL, id: 'd1', result: {plugin: PLUGIN, workspace: {id: 'ws-1'}, theme: 'light'}},
      origin: '*',
    }]);
  });

  it('ignores another window\'s messages and answers a bad request with an error', async () => {
    const {host, posted, send} = await hostWith(() => assert.fail('must not reach the API'));
    host.onMessage({source: {}, data: {protocol: PROTOCOL, id: 'x', method: 'describe', params: {}}});
    send('p1', 'prompt', {text: ' '});
    await until(() => posted.length);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 'p1', error: {message: 'prompt needs text of 1 to 50000 characters'}}]);
  });

  it('relays a refused prompt as the request\'s error', async () => {
    const {posted, send} = await hostWith(() => Response.json({error: 'Mochi Lab is not connected'}, {status: 503}));
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => posted.length);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 'p1', error: {message: 'Mochi Lab is not connected'}}]);
  });

  it('ends a prompt that stops early, or is cancelled, with chat.error and chat.done', async () => {
    const truncated = await hostWith(() => eventStream(sse('delta', {text: 'Sav'})));
    truncated.send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => messages(truncated.posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(truncated.posted, 'run-1').slice(1), [
      ['chat.error', {message: 'The connection closed before the app finished. The session keeps its answer when it does: open the session again to see it.'}],
      ['chat.done', {}],
    ]);

    const hanging = await hostWith((_path, init) => (init.method === 'DELETE' ? Response.json({cancelled: SESSION}) : new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), {once: true});
      },
    }), {headers: {'Content-Type': 'text/event-stream'}})));
    hanging.send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => hanging.posted.length);
    hanging.send('c1', 'cancel', {runId: 'run-1'});
    await until(() => messages(hanging.posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(messages(hanging.posted).find(message => message.id === 'c1'), {protocol: PROTOCOL, id: 'c1', result: {}});
    assert.deepEqual(eventsOf(hanging.posted, 'run-1'), [['chat.error', {message: 'Cancelled'}], ['chat.done', {}]]);
    // Mochi stops the run; the page's connection only follows it.
    assert.deepEqual(hanging.calls.slice(1).map(({path, init}) => [path, init.method]), [[`${SESSIONS}/${SESSION}/run`, 'DELETE']]);
    hanging.send('c2', 'cancel', {runId: 'run-1'});
    await until(() => messages(hanging.posted).some(message => message.id === 'c2'));
    assert.deepEqual(messages(hanging.posted).at(-1).error, {message: 'No run run-1 is in progress'});
  });

  it('prompts the app\'s agent, keeping the conversation for the next prompt', async () => {
    const answer = sse('delta', {text: 'Saved'})
      + sse('agent', {type: 'run.started'})
      + sse('agent', {type: 'tool.completed', call: {name: 'download_source', arguments: {arxiv_id: '1706.03762'}, output: {path: 'attention'}}})
      + sse('done', {text: 'Saved it.', cost: 0.01, model: 'm', usage: {prompt_tokens: 3}, metrics: {ttft_s: 0.5, generation_s: 1, duration_s: 2}});
    const {posted, calls, send} = await hostWith(() => eventStream(answer));
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(posted, 'run-1'), [
      ['chat.delta', {text: 'Saved'}],
      ['chat.tool', {name: 'download_source', arguments: {arxiv_id: '1706.03762'}, output: {path: 'attention'}, isError: false}],
      ['chat.answer', {text: 'Saved it.', metrics: {model: 'm', cost: 0.01, usage: {prompt_tokens: 3}, ttft_s: 0.5, generation_s: 1, duration_s: 2}}],
      ['chat.done', {}],
    ]);
    send('p2', 'prompt', {text: 'Why?'});
    await until(() => calls.length === 2);
    assert.equal(calls[0].path, '/api/ai/stream');
    assert.deepEqual(JSON.parse(calls[0].init.body), {prompt: 'Save 1706.03762', messages: [], appId: 'arxiv-source', sessionId: SESSION});
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      prompt: 'Why?',
      messages: [{role: 'user', content: 'Save 1706.03762'}, {role: 'assistant', content: 'Saved it.'}],
      appId: 'arxiv-source',
      sessionId: SESSION,
    });
  });

  it('follows the message a resumed session is still answering, and keeps its turn', async () => {
    const opened = {...sessionWith([{prompt: 'Hi', answer: 'Hello'}]), running: {prompt: 'Save 1706.03762'}};
    const {posted, calls, send} = await hostWith(path => (path === `${SESSIONS}/${SESSION}`
      ? Response.json({session: opened})
      : eventStream(sse('delta', {text: 'Saved'}) + sse('done', {text: 'Saved it.'}))));
    send('r', 'session.resume', {id: SESSION});
    await until(() => posted.length);
    send('f', 'follow');
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(messages(posted).find(message => message.id === 'f').result, {runId: 'run-1', prompt: 'Save 1706.03762'});
    assert.deepEqual(eventsOf(posted, 'run-1').map(([event]) => event), ['chat.delta', 'chat.answer', 'chat.done']);
    assert.deepEqual(calls[1].path, `${SESSIONS}/${SESSION}/run`);
    send('f2', 'follow');
    await until(() => messages(posted).some(message => message.id === 'f2'));
    assert.deepEqual(messages(posted).at(-1).error, {message: 'This session is not answering a message'});
    send('p', 'prompt', {text: 'Why?'});
    await until(() => calls.length === 3);
    assert.deepEqual(JSON.parse(calls[2].init.body).messages, [
      {role: 'user', content: 'Hi'}, {role: 'assistant', content: 'Hello'},
      {role: 'user', content: 'Save 1706.03762'}, {role: 'assistant', content: 'Saved it.'},
    ]);
  });

  it('continues a resumed session\'s conversation', async () => {
    const {calls, send} = await hostWith(() => eventStream(sse('done', {text: 'ok'})), {chat: [{prompt: 'Hi', answer: 'Hello'}]});
    send('p1', 'prompt', {text: 'Again'});
    await until(() => calls.length);
    assert.deepEqual(JSON.parse(calls[0].init.body).messages, [{role: 'user', content: 'Hi'}, {role: 'assistant', content: 'Hello'}]);
  });

  it('keeps a run\'s turn in its own session when another is opened before it finishes', async () => {
    const OTHER = '00000000-0000-4000-8000-000000000002';
    let finish;
    const {posted, calls, send} = await hostWith((path, init = {}) => {
      if (path === `${SESSIONS}/${OTHER}`) return Response.json({session: {...sessionWith(), id: OTHER}});
      if (path === `${SESSIONS}/${SESSION}`) return Response.json({session: sessionWith()});
      if (finish) return eventStream(sse('done', {text: 'ok'}));
      return new Response(new ReadableStream({start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode(sse('done', {text: 'Saved it.'}))); controller.close(); }; }}), {headers: {'Content-Type': 'text/event-stream'}});
    });
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => finish);
    send('o', 'session.resume', {id: OTHER});
    await until(() => messages(posted).some(message => message.id === 'o'));
    finish();
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    send('p2', 'prompt', {text: 'Hi'});
    await until(() => calls.filter(call => call.path === '/api/ai/stream').length === 2);
    const other = JSON.parse(calls.at(-1).init.body);
    assert.deepEqual([other.sessionId, other.messages], [OTHER, []]);
  });

  it('runs nothing before a session is started or resumed', async () => {
    const {posted, send} = await hostWith(() => assert.fail('must not reach the API'), {started: false});
    send('p1', 'prompt', {text: 'Hi'});
    await until(() => posted.length);
    assert.deepEqual(messages(posted).map(message => message.error.message), ['Start or resume a session first']);
  });

  it('lists, starts and reads sessions through the sessions routes', async () => {
    const {posted, calls, send} = await hostWith((path, init = {}) => {
      if (path === SESSIONS && !init.method) return Response.json({sessions: [{id: SESSION}]});
      return Response.json({session: sessionWith()});
    });
    send('l', 'sessions.list');
    send('g', 'session.get', {id: SESSION});
    send('n', 'session.start');
    await until(() => posted.length === 3);
    const byId = Object.fromEntries(messages(posted).map(message => [message.id, message.result ?? message.error]));
    assert.deepEqual(byId, {l: {sessions: [{id: SESSION}]}, g: {session: sessionWith()}, n: {session: sessionWith()}});
    assert.deepEqual(calls.map(({path, init}) => [path, init?.method ?? 'GET']), [
      [SESSIONS, 'GET'], [`${SESSIONS}/${SESSION}`, 'GET'], [SESSIONS, 'POST'],
    ]);
  });

  it('archives and restores a session through its route', async () => {
    const {posted, calls, send} = await hostWith(() => Response.json({session: {id: SESSION, archivedAt: null}}));
    send('a', 'session.archive', {id: SESSION, archived: true});
    send('r', 'session.archive', {id: SESSION, archived: false});
    await until(() => posted.length === 2);
    assert.deepEqual(calls.map(({path, init}) => [path, init.method, JSON.parse(init.body)]), [
      [`${SESSIONS}/${SESSION}`, 'PATCH', {archived: true}], [`${SESSIONS}/${SESSION}`, 'PATCH', {archived: false}],
    ]);
  });

  it('ends a failed prompt with chat.error and chat.done, and leaves it out of the conversation', async () => {
    const {posted, calls, send} = await hostWith(() => eventStream(sse('error', {error: 'Agent run timed out', status: 504})));
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(posted, 'run-1'), [['chat.error', {message: 'Agent run timed out'}], ['chat.done', {}]]);
    send('p2', 'prompt', {text: 'Again?'});
    await until(() => calls.length === 2);
    assert.deepEqual(JSON.parse(calls[1].init.body).messages, []);
  });

  it('tells the page the site\'s theme', async () => {
    const {host, posted} = await hostWith(() => assert.fail('no request'));
    host.setTheme('dark');
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, event: 'host.theme', data: {theme: 'dark'}}]);
  });
});
