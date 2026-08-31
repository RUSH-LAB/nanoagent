/**
 * server/ai.js: which provider answers, and on what terms.
 *
 * Nothing here spawns Claude or calls an API. What is worth pinning is the
 * decision and the command line: that a production server never shells out to
 * the local CLI, that the CLI is never handed a tool, and that output it did
 * not expect becomes a reported failure rather than a crash. Those are the
 * parts that would be dangerous or silent if they broke.
 */
import {describe, it, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const ai = require('../../../src/server/ai.js');

/** resolveProvider takes its world as an argument, so no environment is touched. */
const resolve = (env, opts = {}) => ai.resolveProvider({env, hasCli: false, isProduction: false, ...opts});

describe('choosing a provider', () => {
  it('prefers the key when there is one, because a server should not shell out', () => {
    assert.equal(resolve({ANTHROPIC_API_KEY: 'sk-ant-x'}, {hasCli: true}).provider, 'api');
  });

  it('falls back to the local CLI, which is the point: no key needed', () => {
    assert.equal(resolve({}, {hasCli: true}).provider, 'claude-code');
  });

  it('explains itself when neither is available, naming both ways out', () => {
    const {provider, error} = resolve({}, {hasCli: false});
    assert.equal(provider, undefined);
    assert.match(error, /ANTHROPIC_API_KEY/);
    assert.match(error, /Claude Code/);
  });

  // The CLI runs a local program holding this machine's credentials on behalf
  // of whoever reached the endpoint. On a laptop that is you; in production it
  // is the internet.
  it('never uses the local CLI in production, asked for or not', () => {
    assert.match(resolve({}, {hasCli: true, isProduction: true}).error, /development only|No AI provider/);
    assert.match(
      resolve({AI_PROVIDER: 'claude-code'}, {hasCli: true, isProduction: true}).error,
      /development only/,
    );
  });

  it('still uses the key in production', () => {
    assert.equal(resolve({ANTHROPIC_API_KEY: 'sk-ant-x'}, {isProduction: true}).provider, 'api');
  });

  const ASKED = [
    ['api', {AI_PROVIDER: 'api', ANTHROPIC_API_KEY: 'sk-ant-x'}, {}, 'api'],
    ['claude-code', {AI_PROVIDER: 'claude-code'}, {hasCli: true}, 'claude-code'],
  ];
  for (const [name, env, opts, expected] of ASKED) {
    it(`honours AI_PROVIDER=${name}`, () => {
      assert.equal(resolve(env, opts).provider, expected);
    });
  }

  it('refuses AI_PROVIDER=api without a key rather than quietly using the CLI', () => {
    assert.match(resolve({AI_PROVIDER: 'api'}, {hasCli: true}).error, /ANTHROPIC_API_KEY is not set/);
  });

  it('can be switched off outright, even with both available', () => {
    const {error} = resolve({AI_PROVIDER: 'off', ANTHROPIC_API_KEY: 'sk-ant-x'}, {hasCli: true});
    assert.match(error, /switched off/);
  });
});

describe('the command line the CLI is given', () => {
  const args = ai.cliArgs({prompt: 'hello', system: 'be brief'});

  it('asks for one printed answer as JSON', () => {
    assert.deepEqual(args.slice(0, 2), ['--print', 'hello']);
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  });

  // A completion endpoint answers a text box on a web page. Reading a file or
  // running a command is never part of that, and the request that asks for it
  // is either a mistake or an attack.
  it('denies every tool by name', () => {
    const denied = args[args.indexOf('--disallowedTools') + 1].split(' ');
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task']) {
      assert.ok(denied.includes(tool), `${tool} is denied`);
    }
    assert.deepEqual(denied, [...ai.FORBIDDEN_TOOLS], 'and the list is the one the module publishes');
  });

  it('loads no MCP servers and writes no session history', () => {
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--no-session-persistence'));
  });

  it('passes the system prompt, and omits the flag when there is none', () => {
    assert.equal(args[args.indexOf('--system-prompt') + 1], 'be brief');
    assert.equal(ai.cliArgs({prompt: 'hello'}).includes('--system-prompt'), false);
  });

  // The prompt is one argument to execFile, never a shell string, so quotes and
  // semicolons in it are text.
  it('keeps a prompt full of shell metacharacters as a single argument', () => {
    const nasty = '"; rm -rf / #';
    assert.deepEqual(ai.cliArgs({prompt: nasty}).slice(0, 2), ['--print', nasty]);
  });
});

// The HTTP provider, exercised through a stubbed fetch. This moved here out of
// the references route suite when the request moved out of the route.
describe('the direct API', () => {
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

  it('sends the key, the version, and the message, and returns the text', async () => {
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = {url, headers: init.headers, body: JSON.parse(init.body)};
      return {ok: true, json: async () => ({content: [{text: 'the continuation'}]})};
    };
    const result = await ai.complete({prompt: 'Write something', system: 'be brief'});
    assert.deepEqual(result, {text: 'the continuation'});
    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sent.headers['x-api-key'], 'sk-test');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(sent.body.messages, [{role: 'user', content: 'Write something'}]);
    assert.equal(sent.body.system, 'be brief');
  });

  it('omits the system field entirely when there is none', async () => {
    let sent;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return {ok: true, json: async () => ({content: [{text: 'x'}]})};
    };
    await ai.complete({prompt: 'p'});
    assert.equal('system' in sent, false);
  });

  it('falls back to a placeholder when the reply carries no text', async () => {
    globalThis.fetch = async () => ({ok: true, json: async () => ({})});
    assert.deepEqual(await ai.complete({prompt: 'p'}), {text: 'No response generated'});
  });

  it('answers 502 when the upstream refuses', async () => {
    globalThis.fetch = async () => ({ok: false, json: async () => ({error: 'nope'})});
    const {status, error} = await ai.complete({prompt: 'p'});
    assert.equal(status, 502);
    assert.match(error, /returned an error/);
  });

  it('answers 504 when the request is aborted on the timeout', async () => {
    globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), {name: 'AbortError'}); };
    const {status, error} = await ai.complete({prompt: 'p'});
    assert.equal(status, 504);
    assert.match(error, /timed out/);
  });

  it('answers 502 when the service cannot be reached at all', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal((await ai.complete({prompt: 'p'})).status, 502);
  });
});

describe('reading what the CLI printed', () => {
  it('takes the result out of a successful run', () => {
    const out = JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'hello there'});
    assert.deepEqual(ai.parseCliOutput(out), {text: 'hello there'});
  });

  it('reports an errored run rather than passing its text off as an answer', () => {
    const out = JSON.stringify({type: 'result', subtype: 'error_max_turns', is_error: true, result: 'nope'});
    const {error, status} = ai.parseCliOutput(out);
    assert.equal(status, 502);
    assert.match(error, /error_max_turns/);
  });

  // The CLI prints a banner or a warning and stops sometimes; that has a reason
  // worth passing on, and it is not JSON.
  it('quotes the first line when the output is not JSON at all', () => {
    const {error, status} = ai.parseCliOutput('SECURITY WARNING: this directory\nmore text');
    assert.equal(status, 502);
    assert.match(error, /SECURITY WARNING/);
  });

  it('survives empty output', () => {
    assert.equal(ai.parseCliOutput('').status, 502);
  });

  it('answers something when the run succeeded with nothing to say', () => {
    const out = JSON.stringify({subtype: 'success', is_error: false, result: ''});
    assert.equal(ai.parseCliOutput(out).text, 'No response generated');
  });
});
