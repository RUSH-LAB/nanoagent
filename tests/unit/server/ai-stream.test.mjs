/**
 * server/ai.js: reading an answer while it is still being written.
 *
 * The buffered path is pinned in tests/unit/server/ai.test.mjs, where nothing
 * runs and nothing is fetched. Streaming cannot be tested that way, because
 * every bug it can have is a bug about arrival: a JSON payload split across two
 * reads, a run that produced a final result but no deltas, a process nobody is
 * waiting for any more. So this suite drives both transports for real, one
 * through a stubbed fetch and the other through a stand-in `claude` on disk
 * that prints the records the real one prints.
 */
import {describe, it, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * A stand-in for the `claude` command, written before server/ai.js is loaded.
 *
 * findCli() caches its answer on first use, and CLAUDE_CLI_PATH is what it
 * consults first, so setting it here fixes the whole process on this script.
 * The prompt selects which run to imitate.
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-ai-stream-'));
const FAKE_CLI = path.join(SANDBOX, 'claude');
fs.writeFileSync(FAKE_CLI, `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--print') + 1];
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
const delta = (text) => emit({type: 'stream_event', event: {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}}});

if (prompt === 'no-deltas') {
  emit({type: 'result', subtype: 'success', is_error: false, result: 'the whole answer'});
} else if (prompt === 'refuse') {
  emit({type: 'result', subtype: 'error_max_turns', is_error: true, result: 'nope'});
} else if (prompt === 'echo-args') {
  emit({type: 'result', subtype: 'success', is_error: false, result: args.join(' ')});
} else if (prompt === 'die') {
  process.stderr.write('SECURITY WARNING: this directory\\nmore\\n');
  process.exit(1);
} else if (prompt === 'flood') {
  for (let i = 0; i < 40; i++) delta('x'.repeat(64 * 1024));
} else if (prompt === 'slow') {
  delta('starting');
  setTimeout(() => emit({type: 'result', subtype: 'success', is_error: false, result: 'starting'}), 30000);
} else {
  emit({type: 'system', subtype: 'init'});
  delta('Hello');
  delta(', world');
  emit({type: 'result', subtype: 'success', is_error: false, result: 'Hello, world'});
}
`, {mode: 0o755});
const FAKE_CODEX = path.join(SANDBOX, 'codex');
fs.writeFileSync(FAKE_CODEX, `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args.at(-1);
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
if (prompt.includes('codex-refuse')) {
  emit({type: 'turn.failed', error: {message: 'model unavailable'}});
  process.exit(1);
} else if (prompt.includes('codex-slow')) {
  emit({type: 'item.completed', item: {type: 'agent_message', text: 'starting'}});
  setTimeout(() => emit({type: 'turn.completed'}), 30000);
} else if (prompt.includes('echo-codex-args')) {
  emit({type: 'item.completed', item: {type: 'agent_message', text: args.join(' ')}});
  emit({type: 'turn.completed'});
} else {
  emit({type: 'thread.started', thread_id: 'thread-1'});
  emit({type: 'item.completed', item: {type: 'reasoning', text: 'hidden'}});
  emit({type: 'item.completed', item: {type: 'agent_message', text: 'Hello from Codex'}});
  emit({type: 'turn.completed'});
}
`, {mode: 0o755});
process.env.CLAUDE_CLI_PATH = FAKE_CLI;
process.env.CODEX_CLI_PATH = FAKE_CODEX;
// Not the repository, and not the home directory either: a test should leave
// nothing behind outside its own temporary tree.
process.env.AI_WORKDIR = path.join(SANDBOX, 'workdir');

const ai = require('../../../src/server/ai.js');

after(() => { fs.rmSync(SANDBOX, {recursive: true, force: true}); });

/** Collect every delta a run reports, alongside what it resolved to. */
async function run(request) {
  const deltas = [];
  const result = await ai.stream({...request, onDelta: (text) => deltas.push(text)});
  return {deltas, result};
}

describe('splitting a stream into records', () => {
  const collect = (parser, chunks) => {
    for (const chunk of chunks) parser.push(chunk);
    parser.end();
  };

  // The failure this exists to prevent: a chunk boundary in the middle of a
  // JSON payload, which is routine on a real socket and drops a whole delta if
  // the parser assumes a chunk is a line.
  it('holds a line back until its newline arrives, however it was chopped up', () => {
    const seen = [];
    const parser = ai.createSseParser(payload => seen.push(payload));
    collect(parser, [
      'event: content_block_delta\ndata: {"type":"content_bl',
      'ock_delta","delta":{"type":"text_delta","text":"one"}}\n\ndata: {"type"',
      ':"content_block_delta","delta":{"type":"text_delta","text":"two"}}\n\n',
    ]);
    assert.deepEqual(seen.map(p => p.delta.text), ['one', 'two']);
  });

  it('survives a payload arriving one character at a time', () => {
    const seen = [];
    const parser = ai.createSseParser(payload => seen.push(payload));
    collect(parser, [...'data: {"type":"ping"}\n\n']);
    assert.deepEqual(seen, [{type: 'ping'}]);
  });

  it('ignores the lines that carry nothing: comments, event names, [DONE]', () => {
    const seen = [];
    const parser = ai.createSseParser(payload => seen.push(payload));
    collect(parser, [': ping\n\nevent: message_stop\nid: 7\ndata: [DONE]\n\ndata: \n\n']);
    assert.deepEqual(seen, []);
  });

  it('skips a payload that is not JSON rather than throwing into the read loop', () => {
    const seen = [];
    const parser = ai.createSseParser(payload => seen.push(payload));
    collect(parser, ['data: <html>502 Bad Gateway</html>\n\ndata: {"type":"ping"}\n\n']);
    assert.deepEqual(seen, [{type: 'ping'}]);
  });

  it('tolerates CRLF, which a proxy may introduce', () => {
    const seen = [];
    const parser = ai.createSseParser(payload => seen.push(payload));
    collect(parser, ['data: {"type":"ping"}\r\n\r\n']);
    assert.deepEqual(seen, [{type: 'ping'}]);
  });

  it('releases a last line that never got its newline', () => {
    const seen = [];
    const parser = ai.createNdjsonParser(record => seen.push(record));
    parser.push('{"a":1}\n{"a":2}');
    assert.deepEqual(seen, [{a: 1}]);
    parser.end();
    assert.deepEqual(seen, [{a: 1}, {a: 2}]);
  });

  it('reads the CLI records as one JSON object per line', () => {
    const seen = [];
    const parser = ai.createNdjsonParser(record => seen.push(record));
    collect(parser, ['{"type":"system"}\n\n  \n{"type":"res', 'ult","result":"x"}\n']);
    assert.deepEqual(seen, [{type: 'system'}, {type: 'result', result: 'x'}]);
  });
});

describe('the text a record adds', () => {
  const textDelta = text => ({type: 'content_block_delta', delta: {type: 'text_delta', text}});

  it('reads the API shape and the CLI shape the same way', () => {
    assert.equal(ai.streamEventText(textDelta('hi')), 'hi');
    assert.equal(ai.streamEventText({type: 'stream_event', event: textDelta('hi')}), 'hi');
  });

  const NOTHING = [
    ['a message_start', {type: 'message_start'}],
    ['a ping', {type: 'ping'}],
    ['a thinking delta, which has no text', {type: 'content_block_delta', delta: {type: 'thinking_delta', thinking: 'hm'}}],
    ['an empty delta', textDelta('')],
    ['a stream_event with no event', {type: 'stream_event'}],
    ['nothing at all', null],
  ];
  for (const [name, record] of NOTHING) {
    it(`adds nothing for ${name}`, () => {
      assert.equal(ai.streamEventText(record), null);
    });
  }
});

describe('streaming from the direct API', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  const realProvider = process.env.AI_PROVIDER;

  before(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.AI_PROVIDER = 'api';
  });
  afterEach(() => { globalThis.fetch = realFetch; });
  after(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
    if (realProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = realProvider;
  });

  /** A fetch that answers with `chunks` as the body, byte for byte. */
  function respondWith(chunks, {ok = true} = {}) {
    const encoder = new TextEncoder();
    let i = 0;
    globalThis.fetch = async (url, init) => {
      globalThis.fetch.sent = {url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal};
      return {
        ok,
        body: {
          getReader: () => ({
            read: async () => (i < chunks.length
              ? {value: encoder.encode(chunks[i++]), done: false}
              : {value: undefined, done: true}),
          }),
        },
      };
    };
  }

  const FRAMES = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel',
    'lo"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  it('asks for a stream and reports the text as it arrives', async () => {
    respondWith(FRAMES);
    const {deltas, result} = await run({prompt: 'hello', system: 'be brief'});
    assert.deepEqual(deltas, ['Hello', ', world']);
    assert.deepEqual(result, {text: 'Hello, world'});
    assert.equal(globalThis.fetch.sent.body.stream, true);
    assert.equal(globalThis.fetch.sent.body.system, 'be brief');
    assert.deepEqual(globalThis.fetch.sent.body.messages, [{role: 'user', content: 'hello'}]);
    assert.equal(globalThis.fetch.sent.headers['x-api-key'], 'sk-test');
  });

  it('omits the system field entirely when there is none', async () => {
    respondWith(FRAMES);
    await run({prompt: 'p'});
    assert.equal('system' in globalThis.fetch.sent.body, false);
  });

  it('says something when the stream carried no text at all', async () => {
    respondWith(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);
    const {result} = await run({prompt: 'p'});
    assert.deepEqual(result, {text: 'No response generated'});
  });

  it('answers 502 when the upstream refuses', async () => {
    respondWith([], {ok: false});
    const {status, error} = (await run({prompt: 'p'})).result;
    assert.equal(status, 502);
    assert.match(error, /returned an error/);
  });

  it('answers 502 when the reply has no body to read', async () => {
    globalThis.fetch = async () => ({ok: true, body: null});
    assert.equal((await run({prompt: 'p'})).result.status, 502);
  });

  it('answers 502 when the service cannot be reached at all', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal((await run({prompt: 'p'})).result.status, 502);
  });

  it('answers 504 when nothing comes back in time', async () => {
    globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), {name: 'AbortError'}); };
    const {status, error} = (await run({prompt: 'p'})).result;
    assert.equal(status, 504);
    assert.match(error, /timed out/);
  });

  it('reports a read that fails halfway as an upstream error, keeping nothing half told', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      body: {getReader: () => ({read: async () => { throw new Error('socket hang up'); }})},
    });
    assert.equal((await run({prompt: 'p'})).result.status, 502);
  });

  it('refuses an already abandoned request without calling out at all', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return {ok: true, body: null}; };
    const controller = new AbortController();
    controller.abort();
    const result = await ai.stream({prompt: 'p', signal: controller.signal});
    assert.equal(result.status, 499);
    assert.match(result.error, /cancelled/);
    assert.equal(called, false);
  });

  it('stops reading when the caller goes away', async () => {
    const controller = new AbortController();
    globalThis.fetch = async (_url, init) => {
      init.signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), {name: 'AbortError'})); });
      return {ok: true, body: {getReader: () => ({read: () => new Promise((_r, rj) => { reject = rj; })})}};
    };
    let reject;
    const running = ai.stream({prompt: 'p', signal: controller.signal, onDelta: () => {}});
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    const result = await running;
    assert.deepEqual([result.status, result.error], [499, 'The AI request was cancelled.']);
  });

  it('passes a refusal from the provider chooser straight through', async () => {
    process.env.AI_PROVIDER = 'off';
    const result = await ai.stream({prompt: 'p'});
    process.env.AI_PROVIDER = 'api';
    assert.equal(result.status, 503);
    assert.match(result.error, /switched off/);
  });
});

describe('streaming from the local CLI', () => {
  const realProvider = process.env.AI_PROVIDER;
  const realKey = process.env.ANTHROPIC_API_KEY;

  before(() => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_PROVIDER = 'claude-code';
  });
  after(() => {
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
    if (realProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = realProvider;
  });

  it('asks for partial messages, and keeps every safety flag the buffered run uses', () => {
    const args = ai.cliArgs({prompt: 'hello', system: 'be brief', stream: true});
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    // The CLI rejects stream-json under --print without --verbose, and sends no
    // partial events unless asked, so all three flags travel together.
    assert.ok(args.includes('--include-partial-messages'));
    assert.ok(args.includes('--verbose'));
    assert.equal(args[args.indexOf('--effort') + 1], 'low');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.deepEqual(args[args.indexOf('--disallowedTools') + 1].split(' '), [...ai.FORBIDDEN_TOOLS]);
    assert.equal(args[args.indexOf('--system-prompt') + 1], 'be brief');
  });

  it('leaves the buffered command line exactly as it was', () => {
    const args = ai.cliArgs({prompt: 'hello'});
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.equal(args.includes('--include-partial-messages'), false);
    assert.equal(args.includes('--verbose'), false);
  });

  it('reports each delta and resolves to the whole answer', async () => {
    const {deltas, result} = await run({prompt: 'hello', system: 'be brief'});
    assert.deepEqual(deltas, ['Hello', ', world']);
    assert.deepEqual(result, {text: 'Hello, world'});
  });

  // A run that answers in one block emits no partial events. Without this the
  // answer would be complete on the CLI's stdout and lost on the way out.
  it('falls back to the final result when no delta ever arrives', async () => {
    const {deltas, result} = await run({prompt: 'no-deltas'});
    assert.deepEqual(deltas, []);
    assert.deepEqual(result, {text: 'the whole answer'});
  });

  it('reports a run that failed rather than passing its text off as an answer', async () => {
    const {result} = await run({prompt: 'refuse'});
    assert.equal(result.status, 502);
    assert.match(result.error, /error_max_turns/);
  });

  it('quotes the first line of the complaint when the run stops without answering', async () => {
    const {result} = await run({prompt: 'die'});
    assert.equal(result.status, 502);
    assert.match(result.error, /SECURITY WARNING/);
  });

  it('runs somewhere with nothing of this project nearby', async () => {
    const {result} = await run({prompt: 'echo-args'});
    assert.match(result.text, /--print echo-args/);
    assert.ok(fs.existsSync(process.env.AI_WORKDIR), 'the working directory it was given');
  });

  // The buffered path hands execFile a maxBuffer and lets it kill the run. This
  // one reads the pipe itself, so the same ceiling has to be applied by hand or
  // a runaway answer becomes a runaway server.
  it('stops a run that writes more than the output ceiling', async () => {
    const {result} = await run({prompt: 'flood'});
    assert.equal(result.status, 502);
    assert.match(result.error, /too large/);
  });

  it('stops the process when the caller goes away', async () => {
    const controller = new AbortController();
    const deltas = [];
    const running = ai.stream({
      prompt: 'slow',
      signal: controller.signal,
      onDelta: (text) => { deltas.push(text); controller.abort(); },
    });
    const result = await running;
    assert.deepEqual([result.status, result.error], [499, 'The AI request was cancelled.']);
    assert.deepEqual(deltas, ['starting'], 'and what had arrived was reported before it stopped');
  });

  // Each run is a whole Claude Code process. The rate limiter counts requests
  // per minute, which says nothing about how many are running at this instant.
  it('refuses a run beyond the concurrency limit instead of starting it', async () => {
    const controllers = [];
    const held = [];
    for (let i = 0; i < ai.MAX_CONCURRENT_CLI; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      held.push(ai.stream({prompt: 'slow', signal: controller.signal, onDelta: () => {}}));
    }
    const refused = await ai.stream({prompt: 'hello'});
    assert.equal(refused.status, 503);
    assert.match(refused.error, /busy with another request/);

    for (const controller of controllers) controller.abort();
    await Promise.all(held);
    // And the slot is given back, so the limit is a limit and not a fuse.
    assert.deepEqual((await run({prompt: 'no-deltas'})).result, {text: 'the whole answer'});
  });
});

describe('streaming from local Codex', () => {
  it('returns only the completed assistant message', async () => {
    const {deltas, result} = await run({provider: 'codex', prompt: 'hello'});
    assert.deepEqual(deltas, ['Hello from Codex']);
    assert.deepEqual(result, {text: 'Hello from Codex'});
  });

  it('uses an ephemeral read-only invocation in the isolated work directory', async () => {
    const {result} = await run({provider: 'codex', prompt: 'echo-codex-args'});
    for (const expected of ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox read-only']) {
      assert.match(result.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(result.text, /\.mochi-lab\/ai|mochi-ai-stream/);
  });

  it('reports a failed Codex turn', async () => {
    const {result} = await run({provider: 'codex', prompt: 'codex-refuse'});
    assert.deepEqual(result, {error: 'model unavailable', status: 502});
  });

  it('stops Codex when the caller cancels', async () => {
    const controller = new AbortController();
    const deltas = [];
    const running = ai.stream({
      provider: 'codex',
      prompt: 'codex-slow',
      signal: controller.signal,
      onDelta: text => { deltas.push(text); controller.abort(); },
    });
    assert.deepEqual(await running, {error: 'The AI request was cancelled.', status: 499});
    assert.deepEqual(deltas, ['starting']);
  });
});
