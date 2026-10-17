import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const ai = require('../../../src/server/ai.js');

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function response(chunks, {status = 200, error = null, json = {}} = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => error ? {error} : json,
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? {value: encoder.encode(chunks[index++]), done: false}
          : {value: undefined, done: true},
        releaseLock() {},
      }),
    },
  };
}

describe('NanoAgent endpoint configuration', () => {
  it('defaults to the local private service', () => {
    assert.deepEqual(ai.endpointFrom({}), {url: 'http://127.0.0.1:8787'});
  });

  it('can be disabled or rejected before a request is sent', async () => {
    let calls = 0;
    const off = ai.createNanoAgentGateway({env: {NANOAGENT_URL: 'off'}, fetchImpl: async () => { calls += 1; }});
    assert.equal(off.describe().available, false);
    assert.equal((await off.complete({input: 'hello'})).status, 503);
    assert.equal(calls, 0);

    assert.match(ai.endpointFrom({NANOAGENT_URL: 'file:///tmp/socket'}).error, /HTTP or HTTPS/);
  });

  it('describes NanoAgent without exposing its bearer token', () => {
    const gateway = ai.createNanoAgentGateway({env: {
      NANOAGENT_URL: 'https://agent.internal/',
      NANOAGENT_API_TOKEN: 'secret',
    }});
    const description = gateway.describe();
    assert.deepEqual(description, {
      available: true,
      provider: 'nanoagent',
      profile: ai.DEFAULT_PROFILE,
      model: ai.DEFAULT_MODEL,
    });
    assert.doesNotMatch(JSON.stringify(description), /secret/);
  });
});

describe('NanoAgent SSE parsing', () => {
  it('reassembles fragmented and multiline event data and ignores heartbeats', () => {
    const seen = [];
    const parser = ai.createSseParser(event => seen.push(event));
    parser.push(': heart');
    parser.push('beat\n\ndata: {"type":"del');
    parser.push('ta",\ndata: "text":"hello"}\r\n\r\n');
    parser.end();
    assert.deepEqual(seen, [{type: 'delta', text: 'hello'}]);
  });

  it('fails closed on malformed upstream data', () => {
    const parser = ai.createSseParser(() => {});
    assert.throws(() => parser.push('data: not-json\n\n'), /invalid event/);
  });
});

describe('NanoAgent gateway', () => {
  it('streams visible content, preserves the final result, and sanitizes lifecycle events', async () => {
    let sent;
    const chunks = [
      sse({type: 'start', runId: 'run-1', metadata: null}),
      sse({type: 'delta', runId: 'run-1', kind: 'reasoning', text: 'private thought'}),
      sse({type: 'delta', runId: 'run-1', kind: 'content', text: 'hel'}).slice(0, 34),
      sse({type: 'delta', runId: 'run-1', kind: 'content', text: 'hel'}).slice(34)
        + sse({type: 'delta', runId: 'run-1', kind: 'content', text: 'lo'}),
      sse({
        type: 'tool', runId: 'run-1', id: 'tool-1', name: 'search',
        arguments: {query: 'q'}, output: 'private document text', is_error: false,
      }),
      sse({type: 'step', runId: 'run-1', step: 1, usage: {total_tokens: 4}, cost: 0.01}),
      sse({
        type: 'done', runId: 'run-1', answer: 'hello', stop_reason: 'answer', steps: 2,
        usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1},
        cost: 0.02, error: null,
        metrics: {
          duration_s: 1.5, model_s: 1.2, tools_s: 0.2, overhead_s: 0.1, ttft_s: 0.4, generation_s: 0.7,
          usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1},
          cost: 0.02,
          steps: [{
            step: 1, duration_s: 1.5, model_s: 1.2, tools_s: 0.2, overhead_s: 0.1,
            usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1},
            cost: 0.02,
            model_calls: [{
              kind: 'agent', duration_s: 1.2, ttft_s: 0.4, generation_s: 0.8,
              output_tokens_per_second: 2.5,
              usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1},
              cost: 0.02, error: 'private provider detail',
            }],
            tool_calls: [{id: 'secret-id', name: 'search', duration_s: 0.2, is_error: false, error: null}],
          }],
        },
        profile: 'pi-deepseek', harness: 'pi', model: 'deepseek/test',
      }),
    ];
    const gateway = ai.createNanoAgentGateway({
      env: {NANOAGENT_URL: 'http://agent.internal:8787/', NANOAGENT_API_TOKEN: 'token'},
      fetchImpl: async (url, init) => {
        sent = {url, ...init, body: JSON.parse(init.body)};
        return response(chunks);
      },
    });
    const deltas = [];
    const events = [];
    const result = await gateway.stream({
      input: 'current question',
      profile: 'pi-deepseek',
      messages: [{role: 'user', content: 'earlier'}],
      instructions: 'Be concise.',
      onDelta: delta => deltas.push(delta),
      onEvent: event => events.push(event),
    });

    assert.equal(sent.url, 'http://agent.internal:8787/v1/runs');
    assert.equal(sent.headers.Authorization, 'Bearer token');
    assert.deepEqual(sent.body, {
      input: 'current question',
      messages: [{role: 'user', content: 'earlier'}],
      instructions: 'Be concise.',
      profile: 'pi-deepseek',
    });
    assert.deepEqual(deltas, ['hel', 'lo']);
    assert.deepEqual(result, {
      text: 'hello', profile: 'pi-deepseek', harness: 'pi', model: 'deepseek/test',
      usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1}, cost: 0.02,
      metrics: {
        duration_s: 1.5, model_s: 1.2, tools_s: 0.2, overhead_s: 0.1, ttft_s: 0.4, generation_s: 0.7,
        usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1},
        cost: 0.02,
        steps: [{
          step: 1, duration_s: 1.5, model_s: 1.2, tools_s: 0.2, overhead_s: 0.1,
          usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1},
          cost: 0.02,
          model_calls: [{
            kind: 'agent', duration_s: 1.2, ttft_s: 0.4, generation_s: 0.8,
            output_tokens_per_second: 2.5,
            usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1},
            cost: 0.02, failed: true,
          }],
          tool_calls: [{name: 'search', duration_s: 0.2, is_error: false}],
        }],
      },
      stopReason: 'answer', runId: 'run-1',
    });
    assert.deepEqual(events.map(event => event.type), [
      'run.started', 'output_text.delta', 'output_text.delta',
      'tool.completed', 'step.completed', 'run.completed',
    ]);
    assert.doesNotMatch(JSON.stringify(events), /private thought|private document text|private provider detail|secret-id|\"query\"/);
  });

  it('uses the stream for buffered completions too', async () => {
    const gateway = ai.createNanoAgentGateway({
      env: {},
      fetchImpl: async () => response([sse({
        type: 'done', runId: 'r', answer: 'finished', stop_reason: 'answer',
        steps: 1, usage: {}, cost: 0, error: null,
      })]),
    });
    assert.equal((await gateway.complete({prompt: 'legacy shape', system: 'instruction'})).text, 'finished');
  });

  it('forwards the run\'s choice of profile or model, and its settings, as routes/ai.js composed them', () => {
    assert.deepEqual(ai.nanoRequest({input: 'x', profile: 'native-test', settings: {max_tokens: 10}, extra: 'dropped'}), {
      input: 'x', messages: [], profile: 'native-test', settings: {max_tokens: 10},
    });
    assert.deepEqual(ai.nanoRequest({input: 'x', model: {provider: 'anthropic', model: 'claude'}}), {
      input: 'x', messages: [], model: {provider: 'anthropic', model: 'claude'},
    });
  });

  it('discovers and caches the server-owned profile catalog', async () => {
    let calls = 0;
    const catalog = {
      defaultProfile: 'native-test',
      profiles: [{
        id: 'native-test', label: 'Native Test', harness: 'nanoagent', provider: 'openrouter', model: 'test-model',
        uses: ['chat', 'apps'], price: {input: 0.1, output: 0.2}, contextWindow: 1000, reasoning: false,
        available: true, unavailableReason: null,
        capabilities: {streaming: true, history: true},
      }],
      limits: {max_steps: 6, cost_limit: 0.1, token_limit: 100, max_tokens: 50, capped: true},
    };
    const gateway = ai.createNanoAgentGateway({
      env: {NANOAGENT_URL: 'http://agent'},
      fetchImpl: async () => { calls += 1; return response([], {json: catalog}); },
    });
    assert.deepEqual(await gateway.profiles(), ai.normalizeProfileCatalog(catalog));
    assert.deepEqual(await gateway.profiles(), ai.normalizeProfileCatalog(catalog));
    assert.equal(calls, 1);
    const [profile] = (await gateway.profiles()).profiles;
    assert.deepEqual([profile.uses, profile.price, profile.contextWindow], [['chat', 'apps'], {input: 0.1, output: 0.2}, 1000]);
    assert.equal((await gateway.profiles()).limits.capped, true);
  });

  it('maps terminal failures and incomplete streams to Mochi errors', async () => {
    const failed = ai.createNanoAgentGateway({
      env: {},
      fetchImpl: async () => response([sse({type: 'error', runId: 'r', code: 'timeout', error: 'Agent run timed out'})]),
    });
    assert.deepEqual(await failed.complete({input: 'x'}), {error: 'Agent run timed out', status: 504});

    const incomplete = ai.createNanoAgentGateway({env: {}, fetchImpl: async () => response([])});
    assert.equal((await incomplete.complete({input: 'x'})).status, 502);
  });

  it('maps HTTP failures without mistaking internal authentication for browser authentication', async () => {
    const gateway = ai.createNanoAgentGateway({
      env: {},
      fetchImpl: async () => response([], {status: 401, error: 'unauthorized'}),
    });
    assert.deepEqual(await gateway.complete({input: 'x'}), {error: 'unauthorized', status: 502});
  });

  it('cancels the upstream request when the Mochi caller disconnects', async () => {
    const caller = new AbortController();
    const gateway = ai.createNanoAgentGateway({
      env: {},
      fetchImpl: async (_url, init) => ({
        ok: true,
        status: 200,
        body: {getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
          }),
          releaseLock() {},
        })},
      }),
    });
    const running = gateway.stream({input: 'wait', signal: caller.signal});
    await new Promise(resolve => setImmediate(resolve));
    caller.abort();
    assert.deepEqual(await running, {error: 'The AI request was cancelled.', status: 499});
  });

  it('bounds the bytes accepted from the internal event stream', async () => {
    const gateway = ai.createNanoAgentGateway({
      env: {NANOAGENT_MAX_STREAM_BYTES: '10'},
      fetchImpl: async () => response(['x'.repeat(11)]),
    });
    assert.match((await gateway.complete({input: 'x'})).error, /too large/);
  });
});

describe('NanoAgent plugin API', () => {
  it('is exported for the routes: every gateway method', () => {
    for (const [name, value] of Object.entries(ai.createNanoAgentGateway())) {
      assert.equal(typeof ai[name], typeof value, `ai.${name} is not exported`);
    }
    assert.equal(ai.local, false);
  });

  it('reads an install and sends a package to install, with the service token', async () => {
    const seen = [];
    const gateway = ai.createNanoAgentGateway({
      env: {NANOAGENT_API_TOKEN: 'secret'},
      fetchImpl: async (url, init) => {
        seen.push([url, init.method, init.headers.Authorization, init.headers['Content-Type'] ?? null, init.body ?? null]);
        if (init.method === 'GET') return {ok: false, status: 404, json: async () => ({error: 'not installed'})};
        return response([], {json: {plugin: {id: 'hello'}}});
      },
    });
    const sha = 'a'.repeat(64);
    assert.deepEqual(await gateway.install(sha), {error: 'not installed', status: 404});
    assert.deepEqual((await gateway.installPackage(sha, Buffer.from('pkg'))).value, {plugin: {id: 'hello'}});
    assert.deepEqual(seen, [
      [`http://127.0.0.1:8787/v1/installs/${sha}`, 'GET', 'Bearer secret', null, null],
      [`http://127.0.0.1:8787/v1/installs/${sha}`, 'PUT', 'Bearer secret', 'application/gzip', Buffer.from('pkg')],
    ]);
  });

  it('streams an app prompt to that plugin\'s agent without a profile', async () => {
    const seen = [];
    const gateway = ai.createNanoAgentGateway({
      env: {},
      fetchImpl: async (url, init) => {
        seen.push([url, JSON.parse(init.body)]);
        return response([sse({type: 'done', answer: 'saved', runId: 'r1'})]);
      },
    });
    const sha = 'a'.repeat(64);
    assert.equal((await gateway.complete({input: 'save it', install: sha, workspace: 'w1'})).text, 'saved');
    assert.deepEqual(seen, [[`http://127.0.0.1:8787/v1/workspaces/w1/installs/${sha}/runs`, {input: 'save it', messages: []}]]);
  });

  it('shows an app run its thinking and each task as it runs, which other runs keep private', async () => {
    const chunks = [
      sse({type: 'delta', runId: 'r1', kind: 'reasoning', text: 'which task?'}),
      sse({type: 'tool_start', runId: 'r1', id: 'call-1', name: 'echo'}),
      sse({type: 'tool_progress', runId: 'r1', id: 'call-1', name: 'echo', event: 'task.result', data: {}}),
      sse({type: 'tool', runId: 'r1', id: 'call-1', name: 'echo', arguments: {value: 'hi'}, output: '{}', is_error: false}),
      sse({type: 'done', runId: 'r1', answer: 'saved'}),
    ];
    const gateway = ai.createNanoAgentGateway({env: {}, fetchImpl: async () => response(chunks)});
    const events = [];
    await gateway.stream({input: 'save it', install: 'a'.repeat(64), workspace: 'w1', onEvent: event => events.push(event)});
    assert.deepEqual(events.slice(0, 3), [
      {type: 'reasoning.delta', runId: 'r1', text: 'which task?'},
      {type: 'tool.started', runId: 'r1', call: {id: 'call-1', name: 'echo'}},
      {type: 'tool.progress', runId: 'r1', call: {id: 'call-1', name: 'echo'}, event: 'task.result', data: {}},
    ]);
    const others = [];
    await gateway.stream({input: 'hi', onEvent: event => others.push(event)});
    assert.deepEqual(others.map(event => event.type), ['tool.started', 'tool.completed', 'run.completed']);
  });

  it('reads a workspace file as bytes and relays a missing one as 404', async () => {
    const seen = [];
    const gateway = ai.createNanoAgentGateway({
      env: {},
      fetchImpl: async url => {
        seen.push(url);
        if (url.endsWith('missing.tex')) return {ok: false, status: 404, json: async () => ({error: 'file not found'})};
        return {ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('hi').buffer};
      },
    });
    assert.equal((await gateway.workspaceFile('w1', 'papers/a b.tex')).value.toString(), 'hi');
    assert.deepEqual(await gateway.workspaceFile('w1', 'missing.tex'), {error: 'file not found', status: 404});
    assert.equal(seen[0], 'http://127.0.0.1:8787/v1/workspaces/w1/files/papers/a%20b.tex');
  });

  it('fetches a plugin page file with its headers', async () => {
    const seen = [];
    const gateway = ai.createNanoAgentGateway({
      env: {NANOAGENT_API_TOKEN: 'secret'},
      fetchImpl: async (url, init) => {
        seen.push([url, init.headers.Authorization]);
        return {
          ok: true, status: 200,
          headers: new Headers({'content-security-policy': "default-src 'self'"}),
          arrayBuffer: async () => new TextEncoder().encode('<html>').buffer,
        };
      },
    });
    const sha = 'a'.repeat(64);
    const file = await gateway.installUiFile(sha, '0123456789abcdef', 'js/app main.js');
    assert.equal(file.value.toString(), '<html>');
    assert.equal(file.headers.get('content-security-policy'), "default-src 'self'");
    assert.deepEqual(seen, [[`http://127.0.0.1:8787/v1/installs/${sha}/ui/0123456789abcdef/js/app%20main.js`, 'Bearer secret']]);
  });

  it('shows an app run\'s tool arguments and output, and no other run\'s', async () => {
    const tool = sse({type: 'tool', runId: 'r', id: 't', name: 'move', arguments: {fen: 'x'}, output: {move: 'e4'}, is_error: false});
    const done = sse({type: 'done', runId: 'r', answer: 'ok'});
    const gateway = ai.createNanoAgentGateway({env: {}, fetchImpl: async () => response([tool, done])});
    const calls = async request => {
      const events = [];
      await gateway.stream({input: 'x', ...request, onEvent: event => events.push(event)});
      return events.filter(event => event.type === 'tool.completed').map(event => event.call);
    };
    assert.deepEqual(await calls({install: 'a'.repeat(64), workspace: 'w1'}), [{id: 't', name: 'move', arguments: {fen: 'x'}, output: {move: 'e4'}}]);
    assert.deepEqual(await calls({}), [{id: 't', name: 'move'}]);
  });

  it('reports an unreachable service', async () => {
    const gateway = ai.createNanoAgentGateway({env: {}, fetchImpl: async () => { throw new Error('refused'); }});
    assert.deepEqual(await gateway.install('a'.repeat(64)), {error: 'Could not reach NanoAgent.', status: 502});
  });
});

describe('NanoAgent plugin packages', () => {
  it('sends a repository archive to be packed and relays why it is refused', async () => {
    const sent = [];
    const gateway = ai.createNanoAgentGateway({
      env: {NANOAGENT_URL: 'https://agent.internal', NANOAGENT_API_TOKEN: 'secret'},
      fetchImpl: async (url, init) => {
        sent.push({url, init});
        return response([], {status: 422, error: 'the package is refused: missing LICENSE'});
      },
    });
    const refused = await gateway.packageSource(Buffer.from('archive'), 'plugins/my notes');
    assert.deepEqual(refused, {error: 'the package is refused: missing LICENSE', status: 422});
    assert.equal(sent[0].url, 'https://agent.internal/v1/packages/source?path=plugins%2Fmy%20notes');
    assert.equal(sent[0].init.method, 'POST');
    assert.equal(sent[0].init.headers['Content-Type'], 'application/gzip');
    assert.equal(sent[0].init.headers.Authorization, 'Bearer secret');
  });
});
