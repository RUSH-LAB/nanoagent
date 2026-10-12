import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL, base64ToBytes, bytesToBase64, chatEvent, invalidRequest, promptHistory, requestFrom, taskEvent,
} from '../../../../src/components/PluginFrame/protocol.js';
import {createBridgeHost} from '../../../../src/components/PluginFrame/host.js';

const PLUGIN = {id: 'chess-move', name: 'Chess Move', tasks: [{id: 'best-move', inputSchema: {type: 'object'}}]};
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const eventStream = text => new Response(text, {headers: {'Content-Type': 'text/event-stream'}});

const SESSION = '00000000-0000-4000-8000-000000000001';
const SESSIONS = '/api/apps/chess-move/sessions';
const sessionWith = (chat = []) => ({id: SESSION, pluginId: 'chess-move', title: '', state: null, chat, calls: []});

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
      ['runTask', {task: 'best-move', arguments: {fen: 'x'}}],
      ['prompt', {text: 'hi'}],
      ['cancel', {runId: 'run-1'}],
      ['workspace.list', {}],
      ['workspace.read', {path: 'a.txt'}],
      ['workspace.write', {path: 'a.txt', text: ''}],
      ['workspace.write', {path: 'a.png', base64: 'AA=='}],
    ];
    for (const [method, params] of valid) assert.equal(invalidRequest({method, params}), null, method);
    const invalid = [
      ['toString', {}],
      ['shell', {}],
      ['describe', undefined],
      ['describe', []],
      ['runTask', {task: 'best-move'}],
      ['runTask', {task: '', arguments: {}}],
      ['runTask', {task: 'best-move', arguments: []}],
      ['prompt', {text: '   '}],
      ['prompt', {text: 'x'.repeat(50_001)}],
      ['cancel', {}],
      ['workspace.read', {path: ''}],
      ['workspace.write', {path: 'a.txt'}],
      ['workspace.write', {path: 'a.txt', text: 'a', base64: 'AA=='}],
      ['session.get', {id: 'not-an-id'}],
      ['session.resume', {}],
      ['session.save', {}],
      ['session.save', {state: 1, title: 2}],
    ];
    for (const [method, params] of invalid) assert.equal(typeof invalidRequest({method, params}), 'string', method);
  });
});

describe('run events on the bridge', () => {
  it('passes task events through without NanoAgent\'s type and run id', () => {
    assert.deepEqual(taskEvent({type: 'task.verdict', runId: 'nano-1', valid: true, score: 1}), {
      event: 'task.verdict', data: {valid: true, score: 1},
    });
    assert.equal(taskEvent({type: 'delta', runId: 'nano-1'}), null);
  });

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

  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 256);
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
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
    send('w1', 'workspace.write', {path: 'a.txt'});
    await until(() => posted.length);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 'w1', error: {message: 'workspace.write needs either text or base64'}}]);
  });

  it('runs a task, replying with its run id before forwarding its events', async () => {
    const stream = sse('task.started', {type: 'task.started', runId: 'n', task: 'best-move'})
      + ': heartbeat\n\n'
      + sse('task.result', {type: 'task.result', runId: 'n', response: {move: 'e4'}})
      + sse('task.done', {type: 'task.done', runId: 'n'});
    const {posted, calls, send} = await hostWith(() => eventStream(stream));
    send('t1', 'runTask', {task: 'best-move', arguments: {fen: 'x'}});
    await until(() => messages(posted).some(message => message.event === 'task.done'));
    assert.equal(calls[0].path, '/api/apps/chess-move/tasks/best-move/runs');
    assert.deepEqual(JSON.parse(calls[0].init.body), {arguments: {fen: 'x'}, sessionId: SESSION});
    assert.deepEqual(messages(posted)[0], {protocol: PROTOCOL, id: 't1', result: {runId: 'run-1'}});
    assert.deepEqual(eventsOf(posted, 'run-1'), [
      ['task.started', {task: 'best-move'}],
      ['task.result', {response: {move: 'e4'}}],
      ['task.done', {}],
    ]);
  });

  it('relays a refused task run as the request\'s error', async () => {
    const {posted, send} = await hostWith(() => Response.json({error: 'arguments.fen: required'}, {status: 400}));
    send('t1', 'runTask', {task: 'best-move', arguments: {}});
    await until(() => posted.length);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 't1', error: {message: 'arguments.fen: required'}}]);
  });

  it('ends a task run that stops early, or is cancelled, with task.error and task.done', async () => {
    const truncated = await hostWith(() => eventStream(sse('task.started', {type: 'task.started', runId: 'n', task: 'best-move'})));
    truncated.send('t1', 'runTask', {task: 'best-move', arguments: {}});
    await until(() => messages(truncated.posted).some(message => message.event === 'task.done'));
    assert.deepEqual(eventsOf(truncated.posted, 'run-1').slice(1), [
      ['task.error', {message: 'The connection closed before the task finished'}],
      ['task.done', {}],
    ]);

    const hanging = await hostWith((_path, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), {once: true});
      },
    }), {headers: {'Content-Type': 'text/event-stream'}}));
    hanging.send('t1', 'runTask', {task: 'best-move', arguments: {}});
    await until(() => hanging.posted.length);
    hanging.send('c1', 'cancel', {runId: 'run-1'});
    await until(() => messages(hanging.posted).some(message => message.event === 'task.done'));
    assert.deepEqual(messages(hanging.posted).find(message => message.id === 'c1'), {protocol: PROTOCOL, id: 'c1', result: {}});
    assert.deepEqual(eventsOf(hanging.posted, 'run-1'), [['task.error', {message: 'Cancelled'}], ['task.done', {}]]);
    hanging.send('c2', 'cancel', {runId: 'run-1'});
    await until(() => messages(hanging.posted).some(message => message.id === 'c2'));
    assert.deepEqual(messages(hanging.posted).at(-1).error, {message: 'No run run-1 is in progress'});
  });

  it('prompts the app\'s agent, keeping the conversation for the next prompt', async () => {
    const answer = sse('delta', {text: 'e4'})
      + sse('agent', {type: 'run.started'})
      + sse('agent', {type: 'tool.completed', call: {name: 'move', arguments: {fen: 'x'}, output: {move: 'e4'}}})
      + sse('done', {text: 'Play e4.', cost: 0.01, model: 'm', usage: {prompt_tokens: 3}, metrics: {ttft_s: 0.5, generation_s: 1, duration_s: 2}});
    const {posted, calls, send} = await hostWith(() => eventStream(answer));
    send('p1', 'prompt', {text: 'Best move?'});
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(posted, 'run-1'), [
      ['chat.delta', {text: 'e4'}],
      ['chat.tool', {name: 'move', arguments: {fen: 'x'}, output: {move: 'e4'}, isError: false}],
      ['chat.answer', {text: 'Play e4.', metrics: {model: 'm', cost: 0.01, usage: {prompt_tokens: 3}, ttft_s: 0.5, generation_s: 1, duration_s: 2}}],
      ['chat.done', {}],
    ]);
    send('p2', 'prompt', {text: 'Why?'});
    await until(() => calls.length === 2);
    assert.equal(calls[0].path, '/api/ai/stream');
    assert.deepEqual(JSON.parse(calls[0].init.body), {prompt: 'Best move?', messages: [], appId: 'chess-move', sessionId: SESSION});
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      prompt: 'Why?',
      messages: [{role: 'user', content: 'Best move?'}, {role: 'assistant', content: 'Play e4.'}],
      appId: 'chess-move',
      sessionId: SESSION,
    });
  });

  it('continues a resumed session\'s conversation', async () => {
    const {calls, send} = await hostWith(() => eventStream(sse('done', {text: 'ok'})), {chat: [{prompt: 'Hi', answer: 'Hello'}]});
    send('p1', 'prompt', {text: 'Again'});
    await until(() => calls.length);
    assert.deepEqual(JSON.parse(calls[0].init.body).messages, [{role: 'user', content: 'Hi'}, {role: 'assistant', content: 'Hello'}]);
  });

  it('runs nothing before a session is started or resumed', async () => {
    const {posted, send} = await hostWith(() => assert.fail('must not reach the API'), {started: false});
    send('t1', 'runTask', {task: 'best-move', arguments: {}});
    send('p1', 'prompt', {text: 'Hi'});
    send('s1', 'session.save', {state: {}});
    await until(() => posted.length === 3);
    assert.deepEqual(messages(posted).map(message => message.error.message), Array(3).fill('Start or resume a session first'));
  });

  it('lists, starts, reads and saves sessions through the sessions routes', async () => {
    const {posted, calls, send} = await hostWith((path, init = {}) => {
      if (path === SESSIONS && !init.method) return Response.json({sessions: [{id: SESSION}]});
      if (init.method === 'PUT') return Response.json({saved: true});
      return Response.json({session: sessionWith()});
    });
    send('l', 'sessions.list');
    send('g', 'session.get', {id: SESSION});
    send('n', 'session.start');
    send('s', 'session.save', {state: {fen: 'x'}, title: 'Game'});
    await until(() => posted.length === 4);
    const byId = Object.fromEntries(messages(posted).map(message => [message.id, message.result ?? message.error]));
    assert.deepEqual(byId, {l: {sessions: [{id: SESSION}]}, g: {session: sessionWith()}, n: {session: sessionWith()}, s: {}});
    assert.deepEqual(calls.map(({path, init}) => [path, init?.method ?? 'GET']), [
      [SESSIONS, 'GET'], [`${SESSIONS}/${SESSION}`, 'GET'], [SESSIONS, 'POST'], [`${SESSIONS}/${SESSION}`, 'PUT'],
    ]);
    assert.deepEqual(JSON.parse(calls[3].init.body), {state: {fen: 'x'}, title: 'Game'});
  });

  it('ends a failed prompt with chat.error and chat.done, and leaves it out of the conversation', async () => {
    const {posted, calls, send} = await hostWith(() => eventStream(sse('error', {error: 'Agent run timed out', status: 504})));
    send('p1', 'prompt', {text: 'Best move?'});
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(posted, 'run-1'), [['chat.error', {message: 'Agent run timed out'}], ['chat.done', {}]]);
    send('p2', 'prompt', {text: 'Again?'});
    await until(() => calls.length === 2);
    assert.deepEqual(JSON.parse(calls[1].init.body).messages, []);
  });

  it('lists, reads and writes workspace files through the agent-files routes', async () => {
    const {posted, calls, send} = await hostWith((path, init) => {
      if (path === '/api/agent-files') return Response.json({files: [{path: 'a.txt', size: 2, modified: 1}], folders: []});
      if (init.method === 'PUT') return Response.json({path: 'b.bin', size: 2});
      if (path.endsWith('a.txt')) return new Response('hi', {headers: {'Content-Type': 'text/plain; charset=utf-8'}});
      if (path.endsWith('missing.txt')) return Response.json({error: 'not found'}, {status: 404});
      return new Response(new Uint8Array([0, 255]), {headers: {'Content-Type': 'image/png'}});
    });
    send('l', 'workspace.list');
    send('r1', 'workspace.read', {path: 'a.txt'});
    send('r2', 'workspace.read', {path: 'img/b c.png'});
    send('r3', 'workspace.read', {path: 'missing.txt'});
    send('w', 'workspace.write', {path: 'b.bin', base64: 'AP8='});
    await until(() => posted.length === 5);
    const byId = Object.fromEntries(messages(posted).map(message => [message.id, message.result ?? message.error]));
    assert.deepEqual(byId, {
      l: {files: [{path: 'a.txt', size: 2}]},
      r1: {text: 'hi'},
      r2: {base64: 'AP8='},
      r3: {message: 'not found'},
      w: {},
    });
    assert.equal(calls.find(call => call.path.includes('b%20c.png')).path, '/api/agent-files/content?path=img%2Fb%20c.png');
    const write = calls.find(call => call.init.method === 'PUT');
    assert.equal(write.path, '/api/agent-files/content?path=b.bin');
    assert.deepEqual([...write.init.body], [0, 255]);
  });

  it('tells the page the site\'s theme', async () => {
    const {host, posted} = await hostWith(() => assert.fail('no request'));
    host.setTheme('dark');
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, event: 'host.theme', data: {theme: 'dark'}}]);
  });
});
