import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  addConnection, adoptLegacy, connectableSite, connectionId, filesFolderFor, linkMember, linkSession, keyHint, keyStatus, nanoagentCommand, parseEnv, providerKeys, relayEnv, systemEnv, writeKeys,
} from '../../../src/runner/lab.mjs';

test('installs once, keeping its own site\'s files apart from any other\'s', () => {
  const config = YAML.parse(fs.readFileSync(new URL('../../../desktop/config.yaml', import.meta.url), 'utf8'));
  assert.equal(config.label, 'lab.mochi.lab');
  assert.equal(filesFolderFor(config, 'https://rush-lab.org'), 'rushlab');
  assert.equal(filesFolderFor(config, 'http://localhost:3000'), 'rushlab-dev');
});

test('names a connection by its site and member', () => {
  assert.equal(connectionId('https://rush-lab.org', 'tdjxZH_X-1'), 'rush-lab.org-tdjxZH_X-1');
  assert.equal(connectionId('http://localhost:3000', 'abc'), 'localhost-3000-abc');
  assert.throws(() => connectionId('https://rush-lab.org', '../x'), /not a member id/);
});

test('connects only to its own site, or a development checkout\'s on this computer', () => {
  const config = {site_url: 'https://rush-lab.org'};
  assert.equal(connectableSite(config, 'https://rush-lab.org/'), 'https://rush-lab.org');
  for (const site of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) assert.equal(connectableSite(config, site), site);
  for (const site of ['https://evil.example', 'http://rush-lab.org', 'https://localhost:3000', 'http://localhost.evil.example', 'not a url', '']) {
    assert.throws(() => connectableSite(config, site), /is not a site RUSH Lab connects to/, site);
  }
});

test('asks the site whose a connect link is, and then for their session, saying why it refuses', async () => {
  const server = http.createServer((req, res) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    res.setHeader('Content-Type', 'application/json');
    if (token !== 'good') return res.writeHead(401).end(JSON.stringify({error: 'This connect link is invalid or has expired.'}));
    const member = {id: 'alice', login: 'alice-gh'};
    res.end(JSON.stringify(req.method === 'GET' ? {member} : {session: 's-alice', member}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await linkMember(site, 'good'), {id: 'alice', login: 'alice-gh'});
    assert.deepEqual(await linkSession(site, 'good'), {session: 's-alice', member: {id: 'alice', login: 'alice-gh'}});
    await assert.rejects(linkMember(site, 'bad'), /invalid or has expired/);
    await assert.rejects(linkSession(site, 'bad'), /invalid or has expired/);
  } finally {
    server.close();
  }
});

const SITE = 'https://rush-lab.org';
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('keeps each member\'s session as a connection of their own, another member\'s left as it is', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-data-'));
  const alice = await addConnection(data, SITE, {session: 's-alice', member: {id: 'alice', login: 'alice-gh'}});
  const bob = await addConnection(data, 'http://localhost:3000', {session: 's-bob', member: {id: 'bob', login: 'bob-gh'}});
  assert.equal(alice, 'rush-lab.org-alice');
  assert.equal(bob, 'localhost-3000-bob');
  const folder = path.join(data, 'connections', alice);
  assert.equal(read(folder, 'site'), `${SITE}\n`);
  assert.deepEqual(JSON.parse(read(folder, 'member.json')), {id: 'alice', login: 'alice-gh'});
  assert.deepEqual(JSON.parse(read(folder, 'runner-credentials.json')), {site: SITE, token: 's-alice'});
  assert.equal(fs.statSync(path.join(folder, 'runner-credentials.json')).mode & 0o777, 0o600);
  // Installed again, only that connection's sign-in and `installed` change.
  const installed = read(folder, 'installed');
  await new Promise(resolve => setTimeout(resolve, 5));
  await addConnection(data, SITE, {session: 's-alice-2', member: {id: 'alice', login: 'alice-gh'}});
  assert.equal(JSON.parse(read(folder, 'runner-credentials.json')).token, 's-alice-2');
  assert.notEqual(read(folder, 'installed'), installed);
  assert.equal(JSON.parse(read(data, 'connections', bob, 'runner-credentials.json')).token, 's-bob');
  await assert.rejects(addConnection(data, SITE, {session: 'bad session', member: {id: 'c', login: 'c'}}), /no valid session/);
  await assert.rejects(addConnection(data, SITE, {session: 's', member: {id: 'c'}}), /no GitHub login/);
  fs.rmSync(data, {recursive: true});
});

/** A data folder as an install from before connections left it, signed in with `token`. */
function legacyInstall(token) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-legacy-'));
  fs.writeFileSync(path.join(data, 'site'), `${SITE}\n`);
  fs.writeFileSync(path.join(data, 'runner-credentials.json'), JSON.stringify({site: SITE, token}));
  fs.writeFileSync(path.join(data, 'settings.env'), 'OPENROUTER_API_KEY=sk-or-1\n');
  fs.mkdirSync(path.join(data, 'agent-workspaces'));
  fs.mkdirSync(path.join(data, 'python'));
  return data;
}

test('makes an install from before connections its member\'s connection, as the site says whose it is', async () => {
  const data = legacyInstall('old');
  const member = async (site, token) => (site === SITE && token === 'old' ? {id: 'alice', login: 'alice-gh'} : false);
  // Bob installs: Alice's sign-in, keys and folders become her connection, and Bob gets his.
  assert.equal(await addConnection(data, SITE, {session: 's-bob', member: {id: 'bob', login: 'bob-gh'}}, {member}), 'rush-lab.org-bob');
  const alice = path.join(data, 'connections', 'rush-lab.org-alice');
  assert.equal(read(alice, 'settings.env'), 'OPENROUTER_API_KEY=sk-or-1\n');
  assert.deepEqual(JSON.parse(read(alice, 'runner-credentials.json')), {site: SITE, token: 'old'});
  assert.ok(fs.existsSync(path.join(alice, 'agent-workspaces')));
  for (const gone of ['site', 'runner-credentials.json', 'settings.env', 'agent-workspaces']) assert.ok(!fs.existsSync(path.join(data, gone)), gone);
  assert.ok(fs.existsSync(path.join(data, 'python')));
  fs.rmSync(data, {recursive: true});
});

test('drops a sign-in from before connections the site knows no more, and stops when it cannot be reached', async () => {
  const forgotten = legacyInstall('old');
  assert.equal(await adoptLegacy(forgotten, {member: async () => false}), null);
  assert.deepEqual(fs.readdirSync(forgotten), ['python']);
  fs.rmSync(forgotten, {recursive: true});
  const unreachable = legacyInstall('old');
  await assert.rejects(adoptLegacy(unreachable, {member: async () => null}), /could not reach https:\/\/rush-lab\.org/);
  assert.ok(fs.existsSync(path.join(unreachable, 'runner-credentials.json')));
  fs.rmSync(unreachable, {recursive: true});
});

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
  const system = systemEnv({HOME: '/Users/m', USER: 'm', PATH: '/opt/homebrew/bin', OPENROUTER_API_KEY: 'k', SECRET: 's'}, '/app/bin', '/data');
  assert.deepEqual(system, {HOME: '/Users/m', USER: 'm', PATH: '/app/bin:/usr/bin:/bin:/usr/sbin:/sbin', UV_PYTHON_INSTALL_DIR: '/data/python'});
});

test('starts a connection\'s NanoAgent sandboxed, in its own folders, with its keys and token', () => {
  const data = '/Users/m/Library/Application Support/lab.mochi.lab';
  const connection = `${data}/connections/rush-lab.org-alice`;
  const command = nanoagentCommand({
    nanoagent: '/app/nanoagent', data, connection, port: 47311, sandbox: 'seatbelt', system: {HOME: '/Users/m', PATH: '/app/bin'},
    keys: {OPENROUTER_API_KEY: 'k'}, token: 't',
  });
  assert.equal(command.program, '/app/nanoagent/.venv/bin/python');
  assert.deepEqual(command.args, [
    '-I', '-m', 'nanoagent', 'web',
    'web_cfg=deploy/railway/nanoagent.yaml', 'host=127.0.0.1', 'port=47311', 'sandbox=seatbelt', 'run_models=true', 'include_reasoning=true',
    `workspaces="${connection}/agent-workspaces"`,
    `installs="${connection}/nanoagent-installs"`,
    `uv_cache="${data}/nanoagent-uv-cache"`,
    'plugin_python="/app/nanoagent/.venv/bin/python"',
  ]);
  assert.deepEqual(command.env, {HOME: '/Users/m', PATH: '/app/bin', OPENROUTER_API_KEY: 'k', NANOAGENT_API_TOKEN: 't'});
});

test('tells a connection\'s relay where Mochi, NanoAgent and its files are', () => {
  const keys = [{env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: false, hint: null}];
  assert.deepEqual(relayEnv({system: {HOME: '/Users/m'}, site: 'https://rush-lab.org', port: 47311, token: 't', connection: '/d', keys, files: '/Users/m/rushlab/alice'}), {
    HOME: '/Users/m',
    MOCHI_SITE_URL: 'https://rush-lab.org',
    NANOAGENT_URL: 'http://127.0.0.1:47311',
    NANOAGENT_API_TOKEN: 't',
    RUNNER_CREDENTIALS: '/d/runner-credentials.json',
    RUNNER_KEYS: JSON.stringify(keys),
    RUNNER_FILES: '/Users/m/rushlab/alice',
  });
});
