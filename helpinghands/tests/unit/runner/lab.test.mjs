import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {keyHint, keyStatus, nanoagentCommand, parseEnv, providerKeys, relayEnv, systemEnv, writeKeys} from '../../../src/runner/lab.mjs';

test('hints at a key without giving it away', () => {
  assert.equal(keyHint('sk-or-v1-0123456789abcdef'), 'sk-or-…cdef');
  assert.equal(keyHint('short-key'), '…');
});

test('reads env lines as Mochi does', () => {
  const values = parseEnv('# comment\n\nA=1\r\nexport B="two words"\nC=\'x=y\'\nD=\n');
  assert.deepEqual(values, {A: '1', B: 'two words', C: 'x=y', D: ''});
});

test('refuses lines that are not assignments', () => {
  assert.throws(() => parseEnv('A=1\nnot an assignment\n'), /invalid line: not an assignment/);
  assert.throws(() => parseEnv('1A=1\n'), /invalid line/);
  assert.throws(() => parseEnv('A B=1\n'), /invalid line/);
});

test('lists every provider key, set or not, with only a hint of its value', () => {
  const keys = keyStatus({OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef', OPENAI_API_KEY: '', OTHER: 'x'});
  assert.equal(keys.length, 14);
  assert.deepEqual(keys[0], {env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: true, hint: 'sk-or-…cdef'});
  assert.deepEqual(keys.find(key => key.env === 'OPENAI_API_KEY'), {env: 'OPENAI_API_KEY', label: 'OpenAI', set: false, hint: null});
  assert.deepEqual(providerKeys({OPENROUTER_API_KEY: 'a', OPENAI_API_KEY: '', OTHER: 'x'}), {OPENROUTER_API_KEY: 'a'});
});

test('writes keys readable only by this user, keeping only provider keys', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-keys-'));
  const file = path.join(folder, 'data', 'settings.env');
  writeKeys(file, {OPENROUTER_API_KEY: '  sk-or-1  ', ANTHROPIC_API_KEY: 'sk-ant-1'});
  assert.equal(fs.readFileSync(file, 'utf8'), 'ANTHROPIC_API_KEY=sk-ant-1\nOPENROUTER_API_KEY=sk-or-1\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.appendFileSync(file, 'STRAY=1\n');
  writeKeys(file, {ANTHROPIC_API_KEY: null});
  assert.equal(fs.readFileSync(file, 'utf8'), 'OPENROUTER_API_KEY=sk-or-1\n');
  assert.throws(() => writeKeys(file, {PATH: '/bin'}), /PATH is not a key Mochi Lab holds/);
  assert.throws(() => writeKeys(file, {OPENAI_API_KEY: ' '}), /must be one key, without spaces/);
  assert.throws(() => writeKeys(file, {OPENAI_API_KEY: 'two keys'}), /must be one key, without spaces/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'OPENROUTER_API_KEY=sk-or-1\n');
  fs.rmSync(folder, {recursive: true});
});

test('gives the services only the system basics, the bundled runtimes first on PATH', () => {
  const system = systemEnv({HOME: '/Users/m', USER: 'm', PATH: '/opt/homebrew/bin', OPENROUTER_API_KEY: 'k', SECRET: 's'}, '/app/bin');
  assert.deepEqual(system, {HOME: '/Users/m', USER: 'm', PATH: '/app/bin:/usr/bin:/bin:/usr/sbin:/sbin'});
});

test('starts NanoAgent compiled, sandboxed, with its keys and token', () => {
  const data = '/Users/m/Library/Application Support/lab.mochi.lab';
  const command = nanoagentCommand({
    nanoagent: '/app/nanoagent', data, port: 47311, sandbox: 'seatbelt', system: {HOME: '/Users/m', PATH: '/app/bin'},
    keys: {OPENROUTER_API_KEY: 'k'}, token: 't',
  });
  assert.equal(command.program, '/app/nanoagent/.venv/bin/python');
  assert.deepEqual(command.args, [
    '-I', '-c', 'from nanoagent.__main__ import main; raise SystemExit(main())', 'web',
    'web_cfg=deploy/railway/nanoagent.yaml', 'host=127.0.0.1', 'port=47311', 'sandbox=seatbelt', 'run_models=true',
    `workspaces="${data}/agent-workspaces"`,
    `installs="${data}/nanoagent-installs"`,
    `uv_cache="${data}/nanoagent-uv-cache"`,
    'plugin_python="/app/nanoagent/.venv/bin/python"',
  ]);
  assert.deepEqual(command.env, {HOME: '/Users/m', PATH: '/app/bin', OPENROUTER_API_KEY: 'k', NANOAGENT_API_TOKEN: 't'});
});

test('tells the relay where Mochi, NanoAgent and its files are', () => {
  const keys = [{env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: false, hint: null}];
  assert.deepEqual(relayEnv({system: {HOME: '/Users/m'}, site: 'https://rush-lab.org', port: 47311, token: 't', data: '/d', keys, files: '/Users/m/rushlab'}), {
    HOME: '/Users/m',
    MOCHI_SITE_URL: 'https://rush-lab.org',
    NANOAGENT_URL: 'http://127.0.0.1:47311',
    NANOAGENT_API_TOKEN: 't',
    RUNNER_CREDENTIALS: '/d/runner-credentials.json',
    RUNNER_KEYS: JSON.stringify(keys),
    RUNNER_FILES: '/Users/m/rushlab',
  });
});
