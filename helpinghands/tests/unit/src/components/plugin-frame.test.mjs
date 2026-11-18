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
 * A host on a fake frame, with `request` answering RUSH API paths, and a
 * session already started (with `chat` as its conversation); every message
 * posted and every request made after that is in `posted` and `calls`.
 */
async function hostWith(request, {chat = [], started = true, onVersion = () => {}, shown = null, onShown = () => {}} = {}) {
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
    onVersion,
    shown: () => shown,
    onShown,
    // The wait between reads of the worker's state, kept short.
    pause: () => new Promise(resolve => setTimeout(resolve, 1)),
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
      ['session.shown', {id: SESSION}],
      ['session.shown', {id: null}],
      ['plugin.version', {version: '1.2.0'}],
      ['plugin.version', {version: null}],
      ['harness.run', {harness: 'claude-code', task: 'save-paper-source', text: 'hi'}],
      ['harness.run', {harness: 'shell'}],
      ['harness.run', {harness: 'shell', resume: SESSION}],
      ['harness.cancel', {runId: 'harness-1'}],
      ['harness.input', {runId: 'harness-1', terminal: 0, data: '\x03'}],
      ['harness.resize', {runId: 'harness-1', terminal: 2, rows: 40, cols: 120}],
      ['harness.open', {runId: 'harness-1', terminal: 1, rows: 40, cols: 120}],
      ['harness.close', {runId: 'harness-1', terminal: 0}],
      ['leaderboard', {}],
      ['leaderboard.trace', {attemptId: SESSION}],
      ['recording', {attemptId: SESSION}],
      ['recording.payload', {attemptId: SESSION, sha256: 'a'.repeat(64)}],
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
      ['session.shown', {}],
      ['session.shown', {id: 'not-an-id'}],
      ['plugin.version', {}],
      ['plugin.version', {version: ''}],
      ['harness.run', {harness: 'Not a name', task: 'save-paper-source', text: 'hi'}],
      ['harness.run', {harness: 'nanoagent', task: '', text: 'hi'}],
      ['harness.run', {harness: 'nanoagent', task: 'save-paper-source', text: ' '}],
      ['harness.run', {harness: 'shell', task: 'save-paper-source'}],
      ['harness.run', {harness: 'shell', resume: 'not-an-id'}],
      ['harness.run', {harness: 'claude-code', task: 'save-paper-source', text: 'hi', resume: SESSION}],
      ['harness.cancel', {}],
      ['harness.input', {runId: 'harness-1', terminal: 0, data: ''}],
      ['harness.input', {runId: 'harness-1', data: 'a'}],
      ['harness.resize', {runId: 'harness-1', terminal: 0, rows: 0, cols: 120}],
      ['harness.open', {runId: 'harness-1', terminal: 0, rows: 40, cols: 120}],
      ['harness.open', {runId: 'harness-1', terminal: 32, rows: 40, cols: 120}],
      ['harness.close', {runId: 'harness-1', terminal: -1}],
      ['leaderboard.trace', {attemptId: 'not-an-id'}],
      ['recording', {}],
      ['recording.payload', {attemptId: SESSION, sha256: 'not-a-sha'}],
    ];
    for (const [method, params] of invalid) assert.equal(typeof invalidRequest({method, params}), 'string', method);
  });
});

describe('run events on the bridge', () => {
  it('maps the chat stream onto chat events', () => {
    assert.deepEqual(chatEvent({event: 'delta', data: {text: 'he'}}), {event: 'chat.delta', data: {text: 'he'}});
    // The run's provenance graph: each change, then the whole graph.
    const patch = {op: 'append', id: 'steps[0]', field: 'text', text: 'hi'};
    assert.deepEqual(chatEvent({event: 'agent', data: {type: 'graph.patch', patch}}), {event: 'chat.graph', data: {patch}});
    assert.deepEqual(chatEvent({event: 'agent', data: {type: 'graph.completed', graph: {nodes: [], edges: []}}}), {event: 'chat.graph', data: {graph: {nodes: [], edges: []}}});
    assert.deepEqual(chatEvent({event: 'agent', data: {type: 'reasoning.delta', text: 'hm'}}), {event: 'chat.reasoning', data: {text: 'hm'}});
    assert.deepEqual(chatEvent({event: 'agent', data: {type: 'tool.started', call: {id: 'c1', name: 'move'}}}), {
      event: 'chat.tool.started', data: {id: 'c1', name: 'move'},
    });
    assert.deepEqual(chatEvent({event: 'agent', data: {type: 'tool.progress', call: {id: 'c1', name: 'move'}, event: 'task.tool', data: {name: 'step', isError: false}}}), {
      event: 'chat.tool.progress', data: {id: 'c1', name: 'move', event: 'task.tool', data: {name: 'step', isError: false}},
    });
    assert.deepEqual(chatEvent({event: 'agent', data: {type: 'tool.failed', call: {id: 'c1', name: 'move', arguments: {a: 1}, output: 'bad'}}}), {
      event: 'chat.tool', data: {id: 'c1', name: 'move', arguments: {a: 1}, output: 'bad', isError: true},
    });
    assert.equal(chatEvent({event: 'agent', data: {type: 'step.completed'}}), null);
    assert.deepEqual(chatEvent({event: 'done', data: {text: 'all done'}}), {event: 'chat.answer', data: {text: 'all done', metrics: null, version: null}, final: true});
    assert.equal(chatEvent({event: 'done', data: {text: 'all done', version: '1.2.0'}}).data.version, '1.2.0');
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
  it('describes the plugin, workspace, theme and the session to open on, replying to origin *', async () => {
    const {posted, send} = await hostWith(() => assert.fail('describe needs no request'), {shown: SESSION});
    send('d1', 'describe');
    await until(() => posted.length);
    assert.deepEqual(posted, [{
      message: {protocol: PROTOCOL, id: 'd1', result: {plugin: PLUGIN, workspace: {id: 'ws-1'}, theme: 'light', session: SESSION}},
      origin: '*',
    }]);
  });

  it('hears the session the page shows, or null for its Dashboard', async () => {
    const heard = [];
    const {posted, send} = await hostWith(() => assert.fail('session.shown needs no request'), {onShown: id => heard.push(id)});
    send('s1', 'session.shown', {id: SESSION});
    send('s2', 'session.shown', {id: null});
    await until(() => heard.length === 2);
    assert.deepEqual(heard, [SESSION, null]);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 's1', result: {}}, {protocol: PROTOCOL, id: 's2', result: {}}]);
  });

  it('ignores another window\'s messages and answers a bad request with an error', async () => {
    const {host, posted, send} = await hostWith(() => assert.fail('must not reach the API'));
    host.onMessage({source: {}, data: {protocol: PROTOCOL, id: 'x', method: 'describe', params: {}}});
    send('p1', 'prompt', {text: ' '});
    await until(() => posted.length);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 'p1', error: {message: 'prompt needs text of 1 to 50000 characters'}}]);
  });

  it('relays a refused prompt as the request\'s error', async () => {
    const {posted, send} = await hostWith(() => Response.json({error: 'RUSH Lab is not connected'}, {status: 503}));
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => posted.length);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 'p1', error: {message: 'RUSH Lab is not connected'}}]);
  });

  it('follows a run again when its stream drops, from its first event', async () => {
    const {posted, calls, send} = await hostWith(path => (path === '/api/ai/stream'
      ? eventStream(sse('agent', {type: 'reasoning.delta', text: 'Find'}) + sse('delta', {text: 'Sav'}))
      : eventStream(sse('agent', {type: 'reasoning.delta', text: 'Find'}) + sse('delta', {text: 'Saved'}) + sse('done', {text: 'Saved it.'}))));
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(posted, 'run-1').map(([event]) => event), [
      'chat.reasoning', 'chat.delta', 'chat.restart', 'chat.reasoning', 'chat.delta', 'chat.answer', 'chat.done',
    ]);
    assert.deepEqual(calls.map(({path}) => path), ['/api/ai/stream', `${SESSIONS}/${SESSION}/run`]);
    // The answer is the conversation's, as if the stream had never dropped.
    send('p2', 'prompt', {text: 'Why?'});
    await until(() => calls.length === 3);
    assert.deepEqual(JSON.parse(calls[2].init.body).messages.at(-1), {role: 'assistant', content: 'Saved it.'});
  });

  it('shows the turn the session kept when its run ended while the stream was down', async () => {
    const turn = {prompt: 'Save 1706.03762', answer: 'Saved it.', tools: [], activity: [{kind: 'thought', text: 'Find'}], error: null};
    const {posted, calls, send} = await hostWith(path => {
      if (path === '/api/ai/stream') return eventStream(sse('delta', {text: 'Sav'}));
      if (path === `${SESSIONS}/${SESSION}/run`) return Response.json({error: 'This session is not answering a message any more.'}, {status: 404});
      return Response.json({session: sessionWith([turn])});
    });
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(posted, 'run-1').slice(1), [['chat.turn', {turn}], ['chat.done', {}]]);
    send('p2', 'prompt', {text: 'Why?'});
    await until(() => calls.length === 4);
    assert.deepEqual(JSON.parse(calls[3].init.body).messages.at(-1), {role: 'assistant', content: 'Saved it.'});
  });

  it('ends a prompt that stops early and cannot be followed again, or is cancelled, with chat.error and chat.done', async () => {
    const refused = await hostWith(path => (path === '/api/ai/stream'
      ? eventStream(sse('delta', {text: 'Sav'}))
      : Response.json({error: 'Sign in to use plugins'}, {status: 401})));
    refused.send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => messages(refused.posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(refused.posted, 'run-1').slice(1), [
      ['chat.error', {message: 'Sign in to use plugins'}],
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
    // RUSH stops the run; the page's connection only follows it.
    assert.deepEqual(hanging.calls.slice(1).map(({path, init}) => [path, init.method]), [[`${SESSIONS}/${SESSION}/run`, 'DELETE']]);
    hanging.send('c2', 'cancel', {runId: 'run-1'});
    await until(() => messages(hanging.posted).some(message => message.id === 'c2'));
    assert.deepEqual(messages(hanging.posted).at(-1).error, {message: 'No run run-1 is in progress'});
  });

  it('prompts the app\'s agent, keeping the conversation for the next prompt', async () => {
    const answer = sse('delta', {text: 'Saved'})
      + sse('agent', {type: 'run.started'})
      + sse('agent', {type: 'tool.completed', call: {id: 'call-1', name: 'download_source', arguments: {arxiv_id: '1706.03762'}, output: {path: 'attention'}}})
      + sse('done', {text: 'Saved it.', version: '1.2.0', cost: 0.01, model: 'm', usage: {prompt_tokens: 3}, metrics: {model: 'm', cost: 0.01, usage: {prompt_tokens: 3}, ttft_s: 0.5, generation_s: 1, duration_s: 2}});
    const {posted, calls, send} = await hostWith(() => eventStream(answer));
    send('p1', 'prompt', {text: 'Save 1706.03762'});
    await until(() => messages(posted).some(message => message.event === 'chat.done'));
    assert.deepEqual(eventsOf(posted, 'run-1'), [
      ['chat.delta', {text: 'Saved'}],
      ['chat.tool', {id: 'call-1', name: 'download_source', arguments: {arxiv_id: '1706.03762'}, output: {path: 'attention'}, isError: false}],
      ['chat.answer', {text: 'Saved it.', metrics: {model: 'm', cost: 0.01, usage: {prompt_tokens: 3}, ttft_s: 0.5, generation_s: 1, duration_s: 2}, version: '1.2.0'}],
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
    const {calls, send} = await hostWith(() => eventStream(sse('done', {text: 'ok'})), {chat: [
      {prompt: 'Hi', answer: 'Hello', error: null},
      {prompt: 'Save it', answer: '', error: 'RUSH Lab stopped while answering'},
    ]});
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
      if (path.startsWith('/api/benchmark/terminal-sessions')) return Response.json({sessions: [{id: 'a1', harness: 'Codex'}]});
      return Response.json({session: sessionWith()});
    });
    send('l', 'sessions.list');
    await until(() => posted.length === 1);
    send('g', 'session.get', {id: SESSION});
    send('n', 'session.start');
    await until(() => posted.length === 3);
    const byId = Object.fromEntries(messages(posted).map(message => [message.id, message.result ?? message.error]));
    assert.deepEqual(byId, {
      l: {sessions: [{id: SESSION}], terminals: [{id: 'a1', harness: 'Codex'}]}, g: {session: sessionWith()}, n: {session: sessionWith()},
    });
    assert.deepEqual(calls.map(({path, init}) => [path, init?.method ?? 'GET']), [
      [SESSIONS, 'GET'], ['/api/benchmark/terminal-sessions?plugin_id=arxiv-source', 'GET'], [`${SESSIONS}/${SESSION}`, 'GET'], [SESSIONS, 'POST'],
    ]);
  });

  it('reads the plugin\'s leaderboard, whatever task, and the whole trace of one of the member\'s runs on it, page by page', async () => {
    const pages = {
      0: {events: [{cursor: 1, kind: 'verifier.verdict', data: {correct: true}}], has_more: true},
      1: {events: [{cursor: 2, kind: 'trajectory.step', data: {step_id: 1}}], has_more: false},
    };
    const {posted, calls, send} = await hostWith(path => (path.includes('/events')
      ? Response.json(pages[new URL(path, 'http://rush').searchParams.get('after')])
      : Response.json({harnesses: [{rank: 1, harness: 'RUSH'}], cases: []})));
    send('b', 'leaderboard', {});
    send('t', 'leaderboard.trace', {attemptId: SESSION});
    await until(() => posted.length === 2);
    const byId = Object.fromEntries(messages(posted).map(message => [message.id, message.result]));
    assert.deepEqual(byId, {b: {harnesses: [{rank: 1, harness: 'RUSH'}], cases: []}, t: {events: [...pages[0].events, ...pages[1].events]}});
    assert.deepEqual(calls.map(({path}) => path), [
      '/api/benchmark/leaderboard?plugin_id=arxiv-source',
      `/api/benchmark/attempts/${SESSION}/events?limit=1000&after=0`, `/api/benchmark/attempts/${SESSION}/events?limit=1000&after=1`,
    ]);
  });

  it('reads a Harness session\'s recording and a model call\'s request from the attempt\'s routes', async () => {
    const {posted, calls, send} = await hostWith(path => (path.includes('/payloads/') ? new Response('{"messages":[]}') : Response.json({session: {id: SESSION}, terminals: []})));
    send('r', 'recording', {attemptId: SESSION});
    send('p', 'recording.payload', {attemptId: SESSION, sha256: 'a'.repeat(64)});
    await until(() => posted.length === 2);
    const byId = Object.fromEntries(messages(posted).map(message => [message.id, message.result]));
    assert.deepEqual(byId, {r: {session: {id: SESSION}, terminals: []}, p: {text: '{"messages":[]}'}});
    assert.deepEqual(calls.map(({path}) => path), [`/api/benchmark/attempts/${SESSION}/recording`, `/api/benchmark/attempts/${SESSION}/payloads/${'a'.repeat(64)}`]);
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

  it('moves the member to another version of the plugin, or to follow its latest, and says so', async () => {
    const moved = [];
    const repository = {owner: 'alice', repo: 'notes', ref: 'HEAD', path: '', commit: 'd'.repeat(40)};
    const app = {id: PLUGIN.id, version: '1.2.0', latest: '1.2.0', autoUpdate: false, repository, latestRepository: repository, sha256: 'f'.repeat(64)};
    const {posted, calls, send} = await hostWith(() => Response.json({app}), {onVersion: changed => moved.push(changed)});
    send('v', 'plugin.version', {version: '1.2.0'});
    await until(() => moved.length);
    assert.deepEqual(calls.map(({path, init}) => [path, init.method, JSON.parse(init.body)]), [
      [`/api/apps/${PLUGIN.id}`, 'PATCH', {version: '1.2.0'}],
    ]);
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, id: 'v', result: {version: '1.2.0', latest: '1.2.0', repository, latestRepository: repository}}]);
    assert.deepEqual(moved, [app]);
  });

  it('tells the page the site\'s theme', async () => {
    const {host, posted} = await hostWith(() => assert.fail('no request'));
    host.setTheme('dark');
    assert.deepEqual(messages(posted), [{protocol: PROTOCOL, event: 'host.theme', data: {theme: 'dark'}}]);
  });

  const READY = {connected: true, worker: {state: 'ready'}};

  /**
   * RUSH Lab's IPC as the page sees it: `terminal_link` links to the worker at the port and token RUSH named, and `lines` are what the
   * worker sends, each delivered once the page has sent `after` lines (or at once); every line the page sends is in `sent`.
   */
  function fakeLab(script) {
    const callbacks = new Map();
    const lab = {linked: [], sent: [], unlinked: 0};
    let index = 0;
    const deliver = (channel, message) => callbacks.get(channel)({message, index: index++});
    lab.tauri = {
      transformCallback: callback => { callbacks.set(callbacks.size + 1, callback); return callbacks.size; },
      invoke: async (command, args) => {
        if (command === 'terminal_link') {
          lab.linked.push({port: args.port, token: args.token});
          lab.channel = Number(args.events.split(':')[1]);
          for (const line of script.filter(line => !line.after)) deliver(lab.channel, line.line);
          return 7;
        }
        if (command === 'terminal_send') {
          assert.equal(args.link, 7);
          lab.sent.push(JSON.parse(args.line));
          for (const line of script.filter(line => line.after === lab.sent.length)) deliver(lab.channel, line.line);
          return null;
        }
        if (command === 'terminal_unlink') lab.unlinked += 1;
        return null;
      },
    };
    return lab;
  }

  it('runs a Harness tab session as a one-case benchmark run once the worker is ready, linking the page to its terminals on this computer: their output as it comes, what is typed, opening and closing them, and then its outcome', async () => {
    const ATTEMPT = '00000000-0000-4000-8000-0000000000aa';
    const base64 = text => Buffer.from(text).toString('base64');
    const statuses = [{connected: true, worker: {state: 'starting', progress: {done: 5e6, total: 2e7}}}, READY];
    const links = [new Response(null, {status: 204}), Response.json({port: 51234, token: 't0k'})];
    const lab = fakeLab([
      {line: {terminal: 0, data: base64('\x1b[1mhello\x1b[0m ')}},
      {after: 2, line: {terminal: 1, data: base64('$ ')}},
      {after: 3, line: {terminal: 1, closed: true}},
      {after: 4, line: {terminal: 0, data: base64('é')}},
      {after: 4, line: {terminal: 0, closed: true}},
      {after: 4, line: {ended: null}},
    ]);
    const answers = {
      '/api/runner/status': () => Response.json(statuses.shift()),
      '/api/benchmark/sessions': () => Response.json({run: {run_id: 'r1', cases: [{attempts: [{attempt_id: ATTEMPT}]}]}, attempt_id: ATTEMPT}, {status: 201}),
      [`/api/benchmark/attempts/${ATTEMPT}/terminal-link`]: () => links.shift(),
      // Sealed once the page has typed its last and the link ended.
      [`/api/benchmark/attempts/${ATTEMPT}`]: () => Response.json({attempt: {
        state: 'final', sealed: lab.sent.length === 4, execution: {status: 'answered', reason: null}, verdict: 'pass', explanation: null,
        metrics: {input_tokens: 120, output_tokens: 30, elapsed_ms: 4200},
      }}),
      [`/api/benchmark/attempts/${ATTEMPT}/accounting`]: () => Response.json({totals: {settled_usd: 0.0012}}),
    };
    globalThis.__TAURI_INTERNALS__ = lab.tauri;
    try {
      const {posted, calls, send} = await hostWith((path, init) => answers[path](init), {started: false});
      send('h', 'harness.run', {harness: 'claude-code', task: 'save-paper-source', text: 'Get 2401.00001'});
      await until(() => eventsOf(posted, 'harness-1').length);
      send('r', 'harness.resize', {runId: 'harness-1', terminal: 0, rows: 30, cols: 100});
      send('o', 'harness.open', {runId: 'harness-1', terminal: 1, rows: 20, cols: 80});
      send('x', 'harness.close', {runId: 'harness-1', terminal: 1});
      send('i', 'harness.input', {runId: 'harness-1', terminal: 0, data: 'é\r'});
      await until(() => messages(posted).some(message => message.event === 'harness.done'));
      assert.deepEqual(calls.slice(0, 2).map(call => call.path), ['/api/runner/status', '/api/runner/status']);
      assert.deepEqual(JSON.parse(calls[2].init.body), {plugin_id: 'arxiv-source', task_id: 'save-paper-source', harness: 'claude-code', text: 'Get 2401.00001', interactive: true});
      assert.deepEqual(messages(posted)[0], {protocol: PROTOCOL, id: 'h', result: {runId: 'harness-1'}});
      // Nothing typed goes to RUSH: RUSH named the link, and the page sent it all there.
      assert.deepEqual(lab.linked, [{port: 51234, token: 't0k'}]);
      assert.deepEqual(lab.sent, [
        {terminal: 0, rows: 30, cols: 100}, {terminal: 1, rows: 20, cols: 80}, {terminal: 1, close: true}, {terminal: 0, data: base64('é\r')},
      ]);
      assert.ok(calls.every(call => !call.path.endsWith('/terminal') && call.init.method !== 'POST' || call.path === '/api/benchmark/sessions'));
      const events = eventsOf(posted, 'harness-1');
      const of = terminal => events.filter(([, data]) => data.terminal === terminal);
      assert.deepEqual(of(0), [['harness.output', {terminal: 0, data: base64('\x1b[1mhello\x1b[0m ')}], ['harness.output', {terminal: 0, data: base64('é')}], ['harness.closed', {terminal: 0}]]);
      assert.deepEqual(of(1), [['harness.output', {terminal: 1, data: base64('$ ')}], ['harness.closed', {terminal: 1}]]);
      assert.deepEqual(events[0], ['harness.preparing', {done: 5e6, total: 2e7}]);
      assert.deepEqual(events.slice(-2), [
        ['harness.outcome', {status: 'Answered', ended: false, scored: true, reason: null, verdict: 'Pass', explanation: '', inputTokens: 120, outputTokens: 30, elapsedMs: 4200, cost: 0.0012}],
        ['harness.done', {}],
      ]);
    } finally {
      delete globalThis.__TAURI_INTERNALS__;
    }
  });

  it('says a Harness tab session\'s terminals are reached only from RUSH Lab, and ends the session', async () => {
    const answers = {
      '/api/runner/status': () => Response.json(READY),
      '/api/benchmark/sessions': () => Response.json({run: {run_id: 'r1', cases: [{attempts: [{attempt_id: 'a1'}]}]}, attempt_id: 'a1'}, {status: 201}),
      '/api/benchmark/attempts/a1/terminal-link': () => Response.json({port: 51234, token: 't0k'}),
      '/api/benchmark/runs/r1/cancel': () => Response.json({}),
    };
    const {posted, calls, send} = await hostWith(path => answers[path](), {started: false});
    send('h', 'harness.run', {harness: 'shell', resume: SESSION});  // a session the Dashboard resumes is queued as resuming it
    await until(() => messages(posted).some(message => message.event === 'harness.done'));
    assert.deepEqual(eventsOf(posted, 'harness-1'), [
      ['harness.error', {message: 'The Harness terminal runs on your computer, through RUSH Lab: open this page in the RUSH Lab app.'}], ['harness.done', {}],
    ]);
    const queued = JSON.parse(calls.find(call => call.path === '/api/benchmark/sessions').init.body);
    assert.deepEqual([queued.harness, queued.resume, queued.interactive], ['shell', SESSION, true]);
    assert.ok(calls.some(call => call.path === '/api/benchmark/runs/r1/cancel' && call.init.method === 'POST'));
  });

  it('cancels a Harness tab session\'s run, and says why one could not start', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const answers = {
      '/api/runner/status': () => Response.json(READY),
      '/api/benchmark/sessions': () => Response.json({run: {run_id: 'r1', cases: [{attempts: [{attempt_id: 'a1'}]}]}, attempt_id: 'a1'}, {status: 201}),
      '/api/benchmark/attempts/a1/terminal-link': async () => { await held; return new Response(null, {status: 204}); },
      '/api/benchmark/runs/r1/cancel': () => { release(); return Response.json({}); },
      '/api/benchmark/attempts/a1': () => Response.json({attempt: {state: 'final', sealed: true, execution: {status: 'canceled', reason: null}, verdict: null, metrics: null}}),
      '/api/benchmark/attempts/a1/accounting': () => Response.json({totals: {settled_usd: null}}),
    };
    const {posted, calls, send} = await hostWith(path => answers[path](), {started: false});
    send('h', 'harness.run', {harness: 'nanoagent', task: 'save-paper-source', text: 'Get it'});
    await until(() => calls.some(call => call.path === '/api/benchmark/attempts/a1/terminal-link'));
    send('c', 'harness.cancel', {runId: 'harness-1'});
    await until(() => messages(posted).some(message => message.event === 'harness.done'));
    assert.ok(calls.some(call => call.path === '/api/benchmark/runs/r1/cancel' && call.init.method === 'POST'));
    assert.equal(eventsOf(posted, 'harness-1').find(([name]) => name === 'harness.outcome')[1].status, 'Canceled');

    const refused = await hostWith(path => (path === '/api/runner/status' ? Response.json(READY) : Response.json({error: 'Your benchmark worker is not running'}, {status: 409})), {started: false});
    refused.send('h', 'harness.run', {harness: 'nanoagent', task: 'save-paper-source', text: 'Get it'});
    await until(() => messages(refused.posted).some(message => message.event === 'harness.done'));
    assert.deepEqual(eventsOf(refused.posted, 'harness-1'), [['harness.error', {message: 'Your benchmark worker is not running'}], ['harness.done', {}]]);

    // A worker that cannot start fails the session before RUSH queues it.
    const keyless = await hostWith(() => Response.json({connected: true, worker: {state: 'no-key'}}), {started: false});
    keyless.send('h', 'harness.run', {harness: 'nanoagent', task: 'save-paper-source', text: 'Get it'});
    await until(() => messages(keyless.posted).some(message => message.event === 'harness.done'));
    assert.deepEqual(eventsOf(keyless.posted, 'harness-1'), [['harness.error', {message: 'Add your OpenRouter key in Settings to run benchmarks.'}], ['harness.done', {}]]);
    assert.ok(keyless.calls.every(call => call.path === '/api/runner/status'));
  });

  it('stops a Harness tab session that is waiting for the worker without queuing it', async () => {
    const {posted, calls, send} = await hostWith(() => Response.json({connected: true, worker: {state: 'starting', progress: null}}), {started: false});
    send('h', 'harness.run', {harness: 'shell'});
    await until(() => eventsOf(posted, 'harness-1').length);
    send('c', 'harness.cancel', {runId: 'harness-1'});
    await until(() => messages(posted).some(message => message.event === 'harness.done'));
    assert.deepEqual(eventsOf(posted, 'harness-1'), [['harness.preparing', {done: 0, total: 0}], ['harness.done', {}]]);
    assert.ok(calls.every(call => call.path === '/api/runner/status'));
  });
});
