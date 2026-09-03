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
        usage: {total_tokens: 5}, cost: 0.02, error: null,
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
      usage: {total_tokens: 5}, cost: 0.02,
      stopReason: 'answer', runId: 'run-1',
    });
    assert.deepEqual(events.map(event => event.type), [
      'run.started', 'output_text.delta', 'output_text.delta',
      'tool.completed', 'step.completed', 'run.completed',
    ]);
    assert.doesNotMatch(JSON.stringify(events), /private thought|private document text|\"query\"/);
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

  it('forwards only a profile id, never browser-owned model configuration', () => {
    assert.deepEqual(ai.nanoRequest({input: 'x', profile: 'native-test', model: 'ignored'}), {
      input: 'x', messages: [], profile: 'native-test',
    });
  });

  it('discovers and caches the server-owned profile catalog', async () => {
    let calls = 0;
    const catalog = {
      defaultProfile: 'native-test',
      profiles: [{
        id: 'native-test', label: 'Native Test', harness: 'native', model: 'test-model',
        available: true, unavailableReason: null,
        capabilities: {streaming: true, history: true},
      }],
    };
    const gateway = ai.createNanoAgentGateway({
      env: {NANOAGENT_URL: 'http://agent'},
      fetchImpl: async () => { calls += 1; return response([], {json: catalog}); },
    });
    assert.deepEqual(await gateway.profiles(), ai.normalizeProfileCatalog(catalog));
    assert.deepEqual(await gateway.profiles(), ai.normalizeProfileCatalog(catalog));
    assert.equal(calls, 1);
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
