import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  addConnection, adoptLegacy, bundledCommand, commandLauncher, connectableSite, connectionId, draftSupervisor, draftsToInstall, installCommand, installsFolder, linkMember,
  linkSession, keyHint, keyStatus, nanoagentCommand, newPlugin, onPath, parseEnv, pathAdvice, previewConnection, previewOutcome, providerKeys, readDrafts, relayEnv, removeDraft,
  removeOtherSites, rushlab, rushlabCommand, systemEnv, writeDraft, writeKeys,
} from '../../../src/runner/lab.mjs';

const CONFIG = {product_name: 'RUSH Lab', site_url: 'https://rush-lab.org', command: 'rushlab'};

test('installs once, its own site\'s files apart from RUSH Lab Dev\'s', () => {
  const config = YAML.parse(fs.readFileSync(new URL('../../../desktop/config.yaml', import.meta.url), 'utf8'));
  assert.deepEqual([config.label, config.files_folder], ['lab.mochi.lab', 'rushlab']);
  assert.deepEqual([config.dev.label, config.dev.files_folder], ['lab.mochi.lab.dev', 'rushlab-dev']);
});

test('names a connection by its site and member', () => {
  assert.equal(connectionId('https://rush-lab.org', 'tdjxZH_X-1'), 'rush-lab.org-tdjxZH_X-1');
  assert.equal(connectionId('http://localhost:3000', 'abc'), 'localhost-3000-abc');
  assert.throws(() => connectionId('https://rush-lab.org', '../x'), /not a member id/);
});

test('connects only to its own site', () => {
  assert.equal(connectableSite(CONFIG, 'https://rush-lab.org/'), 'https://rush-lab.org');
  for (const site of ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://evil.example', 'http://rush-lab.org', 'not a url', '']) {
    assert.throws(() => connectableSite(CONFIG, site), /is not a site RUSH Lab connects to: it serves only https:\/\/rush-lab\.org$/, site);
  }
  const dev = {product_name: 'RUSH Lab Dev', site_url: 'http://localhost:3000'};
  assert.equal(connectableSite(dev, 'http://localhost:3000'), 'http://localhost:3000');
  for (const site of ['https://rush-lab.org', 'http://127.0.0.1:3000', 'http://localhost:3001']) {
    assert.throws(() => connectableSite(dev, site), /is not a site RUSH Lab Dev connects to: it serves only http:\/\/localhost:3000$/, site);
  }
});

test('removes each connection to another site at startup, saying why, its member\'s files left as they are', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-data-'));
  const own = await addConnection(data, CONFIG, 'https://rush-lab.org', {session: 'tok-a', member: {id: 'alice', login: 'alice-gh'}});
  const other = await addConnection(data, CONFIG, 'http://localhost:3000', {session: 'tok-b', member: {id: 'alice', login: 'alice-gh'}});
  const said = [];
  const write = console.log;
  console.log = line => said.push(line);
  try {
    assert.deepEqual(removeOtherSites(data, CONFIG), [other]);
  } finally {
    console.log = write;
  }
  assert.deepEqual(fs.readdirSync(path.join(data, 'connections')), [own]);
  assert.equal(said.length, 1);
  assert.match(said[0], new RegExp(`\\[${other}\\] Removed the connection to http://localhost:3000: RUSH Lab serves only https://rush-lab\\.org\\. Its member's files are left as they are\\.$`));
  assert.deepEqual(removeOtherSites(data, CONFIG), []);
  // A folder an adopt left before writing `installed` is not a connection yet, and is left as it is.
  fs.mkdirSync(path.join(data, 'connections', 'half'));
  assert.deepEqual(removeOtherSites(data, CONFIG), []);
  assert.deepEqual(fs.readdirSync(path.join(data, 'connections')).sort(), ['half', own]);
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
  const alice = await addConnection(data, CONFIG, SITE, {session: 's-alice', member: {id: 'alice', login: 'alice-gh'}});
  const bob = await addConnection(data, CONFIG, 'http://localhost:3000', {session: 's-bob', member: {id: 'bob', login: 'bob-gh'}});
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
  await addConnection(data, CONFIG, SITE, {session: 's-alice-2', member: {id: 'alice', login: 'alice-gh'}});
  assert.equal(JSON.parse(read(folder, 'runner-credentials.json')).token, 's-alice-2');
  assert.notEqual(read(folder, 'installed'), installed);
  assert.equal(JSON.parse(read(data, 'connections', bob, 'runner-credentials.json')).token, 's-bob');
  await assert.rejects(addConnection(data, CONFIG, SITE, {session: 'bad session', member: {id: 'c', login: 'c'}}), /no valid session/);
  await assert.rejects(addConnection(data, CONFIG, SITE, {session: 's', member: {id: 'c'}}), /no GitHub login/);
  fs.rmSync(data, {recursive: true});
});

/** A data folder as an install from before connections left it, signed in with `token`. */
function legacyInstall(token, site = SITE) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-legacy-'));
  fs.writeFileSync(path.join(data, 'site'), `${site}\n`);
  fs.writeFileSync(path.join(data, 'runner-credentials.json'), JSON.stringify({site, token}));
  fs.writeFileSync(path.join(data, 'settings.env'), 'OPENROUTER_API_KEY=sk-or-1\n');
  fs.mkdirSync(path.join(data, 'agent-workspaces'));
  fs.mkdirSync(path.join(data, 'python'));
  return data;
}

test('makes an install from before connections its member\'s connection, as the site says whose it is', async () => {
  const data = legacyInstall('old');
  const member = async (site, token) => (site === SITE && token === 'old' ? {id: 'alice', login: 'alice-gh'} : false);
  // Bob installs: Alice's sign-in, keys and folders become her connection, and Bob gets his.
  assert.equal(await addConnection(data, CONFIG, SITE, {session: 's-bob', member: {id: 'bob', login: 'bob-gh'}}, {member}), 'rush-lab.org-bob');
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
  assert.equal(await adoptLegacy(forgotten, CONFIG, {member: async () => false}), null);
  assert.deepEqual(fs.readdirSync(forgotten), ['python']);
  fs.rmSync(forgotten, {recursive: true});
  const unreachable = legacyInstall('old');
  await assert.rejects(adoptLegacy(unreachable, CONFIG, {member: async () => null}), /could not reach https:\/\/rush-lab\.org/);
  assert.ok(fs.existsSync(path.join(unreachable, 'runner-credentials.json')));
  fs.rmSync(unreachable, {recursive: true});
});

test('drops a sign-in from before connections to another site without asking it', async () => {
  const data = legacyInstall('old', 'http://localhost:3000');
  const member = async () => assert.fail('asked the other site whose the sign-in is');
  assert.equal(await addConnection(data, CONFIG, SITE, {session: 's-bob', member: {id: 'bob', login: 'bob-gh'}}, {member}), 'rush-lab.org-bob');
  assert.deepEqual(fs.readdirSync(path.join(data, 'connections')), ['rush-lab.org-bob']);
  assert.deepEqual(fs.readdirSync(data).sort(), ['connections', 'python']);
  fs.rmSync(data, {recursive: true});
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
  assert.throws(() => writeKeys(file, {PATH: '/bin'}), /PATH is not a key RUSH Lab holds/);
  assert.throws(() => writeKeys(file, {OPENAI_API_KEY: ' '}), /must be one key, without spaces/);
  assert.throws(() => writeKeys(file, {OPENAI_API_KEY: 'two keys'}), /must be one key, without spaces/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'OPENROUTER_API_KEY=sk-or-1\n');
  fs.rmSync(folder, {recursive: true});
});

test('gives the services only the system basics, the bundled runtimes first on PATH', () => {
  const system = systemEnv({HOME: '/Users/m', USER: 'm', PATH: '/opt/homebrew/bin', OPENROUTER_API_KEY: 'k', SECRET: 's'}, '/app/bin', '/data');
  assert.deepEqual(system, {HOME: '/Users/m', USER: 'm', PATH: '/app/bin:/app/git/bin:/usr/bin:/bin:/usr/sbin:/sbin', UV_PYTHON_INSTALL_DIR: '/data/python'});
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

test('installs a connection\'s plugins in its folder, or on Windows in a short folder of their own', () => {
  const data = path.join(os.tmpdir(), 'lab.mochi.lab');
  const connection = path.join(data, 'connections', 'rush-lab.org-alice');
  assert.equal(installsFolder(data, connection, false), path.join(connection, 'nanoagent-installs'));
  const windows = installsFolder(data, connection, true);
  assert.equal(path.dirname(windows), path.join(data, 'installs'));
  assert.match(path.basename(windows), /^[0-9a-f]{12}$/);
  assert.notEqual(windows, installsFolder(data, path.join(data, 'connections', 'rush-lab.org-bob'), true));
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

test('keeps a draft whole, its draft.json last, and removes one whose folder is gone', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-data-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-plugin-'));
  assert.deepEqual(readDrafts(data), []);
  const draft = {id: 'my-draft', name: 'My Draft', version: '0.2.0', folder, sha256: 'e'.repeat(64), connection: 'rush-lab.org-alice'};
  writeDraft(data, draft, Buffer.from('package'));
  assert.deepEqual(readDrafts(data), [draft]);
  assert.equal(read(data, 'drafts', 'my-draft', 'package.tar.gz'), 'package');
  assert.deepEqual(fs.readdirSync(path.join(data, 'drafts', 'my-draft')).sort(), ['draft.json', 'package.tar.gz']);
  // One being written, its draft.json not there yet, is not a draft yet.
  fs.mkdirSync(path.join(data, 'drafts', 'half'));
  assert.deepEqual(readDrafts(data), [draft]);
  fs.rmSync(folder, {recursive: true});
  assert.deepEqual(readDrafts(data), []);
  assert.equal(fs.existsSync(path.join(data, 'drafts', 'my-draft')), false);
});

test('installs a draft that is new or changed, and none installed as it is', () => {
  const drafts = [{id: 'new', sha256: 'a'.repeat(64)}, {id: 'changed', sha256: 'b'.repeat(64)}, {id: 'same', sha256: 'c'.repeat(64)}];
  const installed = new Map([['changed', {sha256: 'd'.repeat(64)}], ['same', {sha256: 'c'.repeat(64)}]]);
  assert.deepEqual(draftsToInstall(installed, drafts).map(draft => draft.id), ['new', 'changed']);
  assert.deepEqual(draftsToInstall(new Map(), []), []);
});

test('says how a preview stands, from its draft\'s status', () => {
  const sha256 = 'a'.repeat(64);
  assert.deepEqual(previewOutcome(null, sha256), {done: false, ok: false, state: null});
  assert.deepEqual(previewOutcome({sha256: 'b'.repeat(64), state: 'installed', error: null}, sha256), {done: false, ok: false, state: null});
  assert.deepEqual(previewOutcome({sha256, state: 'installing', error: null}, sha256), {done: false, ok: false, state: 'installing'});
  assert.deepEqual(previewOutcome({sha256, state: 'installed', error: null}, sha256), {done: true, ok: true, state: 'installed'});
  assert.deepEqual(previewOutcome({sha256, state: 'failed', error: 'uv sync failed'}, sha256), {done: true, ok: false, state: 'failed: uv sync failed'});
});

/**
 * A data folder with the draft `my-draft` of `bytes` for the connection `a`, and the supervisor of
 * its drafts over the running connections `a` and `b`, whose NanoAgent answers each install with
 * `answer(connection)`: what it installed, told the relays, and whether a draft installed each
 * time `busy` changed, are in `installs`, `told` and `busy`.
 */
function supervised(answer, bytes = Buffer.from('package')) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-data-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-plugin-'));
  const draft = {id: 'my-draft', name: 'My Draft', version: '0.2.0', folder, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), connection: 'a'};
  writeDraft(data, draft, bytes);
  const running = id => ({id, state: 'running', token: 't', drafts: new Map(), failedDrafts: new Map(), installing: null});
  const connections = new Map([['a', running('a')], ['b', running('b')]]);
  const installs = [];
  const told = [];
  const busy = [];
  const supervisor = draftSupervisor({
    config: CONFIG,
    data,
    connections,
    install: (connection, sha256, got) => {
      installs.push([connection.id, sha256, got.toString()]);
      return answer(connection);
    },
    tellRelay: (connection, message) => told.push([connection.id, message]),
    markBusy: () => busy.push([...connections.values()].some(connection => connection.installing)),
  });
  const status = () => JSON.parse(read(data, 'drafts', 'my-draft', 'status.json'));
  return {data, draft, connections, supervisor, installs, told, busy, status};
}

test('installs a draft on its own connection alone, busy while it does, telling its relay nothing of its folder', async () => {
  const {draft, connections, supervisor, installs, told, busy, status} = supervised(async () => ({status: 200, body: '{}'}));
  await supervisor.sync();
  assert.deepEqual(installs, [['a', draft.sha256, 'package']]);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(told, [['a', {drafts: [{id: 'my-draft', name: 'My Draft', version: '0.2.0', sha256: draft.sha256}]}]]);
  assert.deepEqual(status(), {sha256: draft.sha256, state: 'installed', error: null});
  assert.equal(connections.get('b').drafts.size, 0);
  // Installed as it is: not again.
  await supervisor.sync();
  assert.equal(installs.length, 1);
});

test('says why a draft did not install, as NanoAgent answered, and tries it again only once it is previewed again', async () => {
  const answers = [{status: 500, body: 'Internal Server Error'}, null];
  const {data, draft, supervisor, installs, status} = supervised(async () => answers.shift());
  await supervisor.sync();
  assert.deepEqual(status(), {sha256: draft.sha256, state: 'failed', error: 'NanoAgent refused the draft (500): Internal Server Error'});
  await supervisor.sync();
  assert.equal(installs.length, 1);
  writeDraft(data, draft, Buffer.from('package'));
  await supervisor.sync();
  assert.equal(installs.length, 2);
  assert.deepEqual(status(), {sha256: draft.sha256, state: 'failed', error: 'NanoAgent did not answer'});
});

test('installs no package that changed since its draft.json was read', async () => {
  const {data, draft, supervisor, installs, status} = supervised(async () => assert.fail('not installed'));
  fs.writeFileSync(path.join(data, 'drafts', 'my-draft', 'package.tar.gz'), 'another package');
  await supervisor.sync();
  assert.deepEqual(installs, []);
  assert.deepEqual(status(), {sha256: draft.sha256, state: 'installing', error: null});
});

test('keeps nothing of an install that ends after its connection started again', async () => {
  let answer;
  const {connections, supervisor, told} = supervised(() => new Promise(resolve => { answer = resolve; }));
  const synced = supervisor.sync();
  const connection = connections.get('a');
  assert.equal(connection.installing.id, 'my-draft');
  // As startConnection starts it again.
  Object.assign(connection, {drafts: new Map(), failedDrafts: new Map(), installing: null});
  answer({status: 200, body: '{}'});
  await synced;
  assert.deepEqual([connection.drafts.size, connection.installing, told], [0, null, []]);
});

test('says a draft failed while its connection is not running, and forgets one removed', async () => {
  const {data, draft, connections, supervisor, told, status} = supervised(async () => ({status: 200, body: '{}'}));
  await supervisor.sync();
  connections.get('a').state = 'failed';
  await supervisor.sync();
  assert.deepEqual(status(), {sha256: draft.sha256, state: 'failed', error: 'RUSH Lab is not connected to this account: open RUSH Lab and sign in'});
  connections.get('a').state = 'running';
  removeDraft(data, 'my-draft');
  await supervisor.sync();
  assert.deepEqual(told.at(-1), ['a', {drafts: []}]);
  assert.equal(connections.get('a').drafts.size, 0);
});

/** What `run` logged with console.log and console.error, without the log's time. */
async function said(run) {
  const lines = [];
  const {log, error} = console;
  console.log = line => lines.push(line.replace(/^\S+Z /, ''));
  console.error = line => lines.push(line);
  try {
    return {result: await run(), lines};
  } finally {
    Object.assign(console, {log, error});
  }
}

test('reads the command\'s arguments, and says how to use it, exiting 2, for any it does not know', async () => {
  assert.deepEqual(rushlabCommand(['preview']), {folder: '.', to: null});
  assert.deepEqual(rushlabCommand(['preview', 'plugin', '--to', 'localhost-3000-abc']), {folder: 'plugin', to: 'localhost-3000-abc'});
  assert.deepEqual(rushlabCommand(['preview', '--to', 'x', 'plugin']), {folder: 'plugin', to: 'x'});
  assert.deepEqual(rushlabCommand(['preview', '--stop', 'my-draft']), {stop: 'my-draft'});
  assert.deepEqual(rushlabCommand(['new', 'my-plugin']), {new: 'my-plugin'});
  assert.deepEqual(rushlabCommand(['nanoagent', 'plugin', 'inspect', '.', '--to']), {run: 'nanoagent', args: ['plugin', 'inspect', '.', '--to']});
  assert.deepEqual(rushlabCommand(['uv', 'lock']), {run: 'uv', args: ['lock']});
  assert.deepEqual(rushlabCommand(['uv']), {run: 'uv', args: []});
  for (const args of [[], ['publish'], ['new'], ['new', 'a', 'b'], ['preview', 'a', 'b'], ['preview', '--to'], ['preview', '--to', 'x', '--to', 'y'], ['preview', '--stop'],
    ['preview', '--stop', 'a', 'b'], ['preview', '--force']]) {
    assert.equal(rushlabCommand(args), null, args.join(' '));
  }
  const {result, lines} = await said(() => rushlab(['preview', '--stop'], {config: {...CONFIG, product_name: 'RUSH Lab Dev', command: 'rushlab-dev'}}));
  assert.equal(result, 2);
  assert.equal(lines[0], [
    'usage:',
    '  rushlab-dev new <id>                               make the plugin <id> in ./<id>, for an AI CLI there to design with you',
    '  rushlab-dev preview [folder] [--to <connection>]   open the plugin in folder (. by default) in RUSH Lab Dev, as a draft',
    '                                                     of the account connected as <connection>, which only more than one needs',
    '  rushlab-dev preview --stop <id>                    remove the draft <id>',
    '  rushlab-dev nanoagent <args>                       run RUSH Lab Dev\'s NanoAgent',
    '  rushlab-dev uv <args>                              run RUSH Lab Dev\'s uv',
  ].join('\n'));
});

test('writes the command as one sh script on the bundled node, every path quoted', () => {
  const root = '/Users/o\'brien/Library/Application Support/lab.mochi.lab/app/7/mochi-lab';
  assert.deepEqual(commandLauncher({home: '/Users/o\'brien', root, config: CONFIG, windows: false}), {
    file: '/Users/o\'brien/.local/bin/rushlab',
    text: [
      '#!/bin/sh',
      '# Written by RUSH Lab at each start, for the build it runs (src/runner/lab.mjs).',
      '[ -e \'/Users/o\'\\\'\'brien/Library/Application Support/lab.mochi.lab/app/7/mochi-lab/bin/node\' ]'
        + ' || { echo \'RUSH Lab is not set up here: open RUSH Lab, which writes rushlab again\' >&2; exit 1; }',
      'exec \'/Users/o\'\\\'\'brien/Library/Application Support/lab.mochi.lab/app/7/mochi-lab/bin/node\''
        + ' \'/Users/o\'\\\'\'brien/Library/Application Support/lab.mochi.lab/app/7/mochi-lab/runner/lab.mjs\' rushlab "$@"',
      '',
    ].join('\n'),
  });
});

test('runs the command on the build\'s node, its words whole, and says so once that build is gone', {skip: process.platform === 'win32'}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lab home '));
  const root = path.join(home, 'Application Support', 'mochi-lab');
  fs.mkdirSync(path.join(root, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(root, 'bin', 'node'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', {mode: 0o755});
  const {file, text} = commandLauncher({home, root, config: CONFIG, windows: false});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text, {mode: 0o755});
  const ran = spawnSync(file, ['preview', 'a b', '--to', 'x'], {encoding: 'utf8'});
  assert.deepEqual([ran.status, ran.stdout], [0, `${path.join(root, 'runner', 'lab.mjs')}\nrushlab\npreview\na b\n--to\nx\n`]);
  fs.rmSync(path.join(root, 'bin', 'node'));
  const gone = spawnSync(file, ['preview'], {encoding: 'utf8'});
  assert.deepEqual([gone.status, gone.stderr], [1, 'RUSH Lab is not set up here: open RUSH Lab, which writes rushlab again\n']);
});

test('writes the command on Windows as a .cmd in %USERPROFILE%\\.local\\bin', () => {
  const root = 'C:\\Users\\Ada B\\AppData\\Local\\lab.mochi.lab.dev\\app\\7\\mochi-lab';
  assert.deepEqual(commandLauncher({home: 'C:\\Users\\Ada B', root, config: {...CONFIG, product_name: 'RUSH Lab Dev', command: 'rushlab-dev'}, windows: true}), {
    file: 'C:\\Users\\Ada B\\.local\\bin\\rushlab-dev.cmd',
    text: [
      '@echo off',
      'rem Written by RUSH Lab Dev at each start, for the build it runs (src/runner/lab.mjs).',
      `if not exist "${root}\\bin\\node.exe" (`,
      '  echo RUSH Lab Dev is not set up here: open RUSH Lab Dev, which writes rushlab-dev again 1>&2',
      '  exit /b 1',
      ')',
      `"${root}\\bin\\node.exe" "${root}\\runner\\lab.mjs" rushlab %*`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n'),
  });
});

test('tells whether a folder is on PATH, and how to put ~/.local/bin there', () => {
  assert.equal(onPath('/Users/a/.local/bin', '/usr/bin:/Users/a/.local/bin/:/bin', false), true);
  assert.equal(onPath('/Users/a/.local/bin', '/usr/bin::/bin', false), false);
  assert.equal(onPath('/Users/a/.local/bin', '/Users/A/.local/bin', false), false);
  assert.equal(onPath('C:\\Users\\a\\.local\\bin', 'C:\\Windows;c:\\users\\A\\.local\\bin\\', true), true);
  assert.equal(pathAdvice('/bin/zsh', false), 'add this line to ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"');
  assert.equal(pathAdvice('/bin/bash', false), 'add this line to ~/.bash_profile: export PATH="$HOME/.local/bin:$PATH"');
  assert.equal(pathAdvice('/bin/ksh', false), 'add this line to ksh\'s startup file: export PATH="$HOME/.local/bin:$PATH"');
  assert.equal(pathAdvice('/opt/homebrew/bin/fish', false), 'run this: fish_add_path ~/.local/bin');
  assert.match(pathAdvice(null, true), /^run this in PowerShell: \[Environment\]::SetEnvironmentVariable\('Path', "\$env:USERPROFILE\\\.local\\bin;" \+/);
});

test('installs the command at each start, saying when the member\'s terminal does not find it', {skip: process.platform === 'win32'}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-home-'));
  const file = path.join(home, '.local', 'bin', 'rushlab');
  const install = readPath => said(() => installCommand({home, root: '/r', config: CONFIG, shell: '/bin/zsh', windows: false, readPath}));
  assert.deepEqual((await install(async () => '/usr/bin:/bin')).lines, [
    `Wrote ${file}, but ${path.dirname(file)} is not on your terminal's PATH, so rushlab is not found there: `
      + 'add this line to ~/.zshrc: export PATH="$HOME/.local/bin:$PATH", then open a new terminal window',
  ]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.match(fs.readFileSync(file, 'utf8'), /^exec '\/r\/bin\/node' '\/r\/runner\/lab\.mjs' rushlab "\$@"$/m);
  fs.writeFileSync(file, 'an older build\'s');
  assert.deepEqual((await install(async () => `/usr/bin:${path.dirname(file)}`)).lines, [`Wrote ${file}: run rushlab in a terminal`]);
  assert.equal(fs.readFileSync(file, 'utf8'), commandLauncher({home, root: '/r', config: CONFIG, windows: false}).text);
  assert.deepEqual((await install(async () => { throw new Error('/bin/zsh printed no PATH (exit status: 1)'); })).lines, [
    `Wrote ${file}, but could not tell whether your terminal finds rushlab: /bin/zsh printed no PATH (exit status: 1)`,
  ]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['rushlab']);
});

test('runs the bundled NanoAgent with the bundled runtimes and git first on its PATH, and the bundled uv as it is', () => {
  const root = path.join('/data', 'mochi-lab');
  const python = process.platform === 'win32' ? path.join(root, 'nanoagent', '.venv', 'Scripts', 'python.exe') : path.join(root, 'nanoagent', '.venv', 'bin', 'python');
  const git = path.join(root, 'git', process.platform === 'win32' ? 'cmd' : 'bin');
  assert.deepEqual(bundledCommand(root, 'nanoagent', ['plugin', 'inspect', '.'], {HOME: '/h', PATH: '/usr/bin'}), {
    program: python,
    args: ['-I', '-m', 'nanoagent', 'plugin', 'inspect', '.'],
    env: {HOME: '/h', PATH: [path.join(root, 'bin'), git, '/usr/bin'].join(path.delimiter)},
  });
  assert.deepEqual(bundledCommand(root, 'nanoagent', [], {Path: 'C:\\Windows'}).env, {Path: [path.join(root, 'bin'), git, 'C:\\Windows'].join(path.delimiter)});
  const env = {HOME: '/h', PATH: '/usr/bin'};
  assert.deepEqual(bundledCommand(root, 'uv', ['lock', '--check'], env), {
    program: path.join(root, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'), args: ['lock', '--check'], env,
  });
});

/** A build whose NanoAgent's `plugin new` runs `script` (sh, its folder in $6), and the skill. */
function fakeBuild(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab build '));
  fs.mkdirSync(path.join(root, 'nanoagent', '.venv', 'bin'), {recursive: true});
  fs.writeFileSync(path.join(root, 'nanoagent', '.venv', 'bin', 'python'), `#!/bin/sh\n${script}\n`, {mode: 0o755});
  fs.mkdirSync(path.join(root, 'runner', 'plugin-project'), {recursive: true});
  fs.writeFileSync(path.join(root, 'runner', 'plugin-project', 'project.md'), '# The plugin {{id}}\n\nRun `{{command}} preview .` for {{id}}.\n');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '# Build and publish a NanoAgent plugin\n');
  return {root, config: {...CONFIG, command: 'rushlab-dev'}, skill: path.join(root, 'SKILL.md')};
}

test('makes a plugin with the bundled NanoAgent, and writes the preface and the skill into it for each AI CLI', {skip: process.platform === 'win32'}, async () => {
  const build = fakeBuild('mkdir "$6" && printf \'%s\\n\' "$*" "$PATH" > "$6/made"');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cwd-'));
  const folder = await newPlugin(build, 'my-plugin', cwd);
  assert.equal(folder, path.join(cwd, 'my-plugin'));
  assert.deepEqual(fs.readdirSync(folder).sort(), ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'made']);
  const [args, PATH] = fs.readFileSync(path.join(folder, 'made'), 'utf8').split('\n');
  assert.equal(args, `-I -m nanoagent plugin new ${folder}`);
  assert.equal(PATH.split(':').slice(0, 2).join(':'), `${path.join(build.root, 'bin')}:${path.join(build.root, 'git', 'bin')}`);
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    assert.equal(fs.readFileSync(path.join(folder, name), 'utf8'), '# The plugin my-plugin\n\nRun `rushlab-dev preview .` for my-plugin.\n\n# Build and publish a NanoAgent plugin\n');
  }
  await assert.rejects(newPlugin(build, 'my-plugin', cwd), {message: `${folder} already exists`});
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8').startsWith('# The plugin my-plugin'), true);
});

test('refuses an id no plugin has, and removes a plugin it could not finish, saying why', {skip: process.platform === 'win32'}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cwd-'));
  const failing = fakeBuild('mkdir "$6"; echo \'git config user.name is not set\' >&2; exit 1');
  for (const id of ['My-Plugin', 'my--plugin', '-my', 'my_plugin', '../x', '']) {
    await assert.rejects(newPlugin(failing, id, cwd), {message: `${id} is not a plugin id: lowercase letters and numbers, in words joined by single hyphens`});
  }
  await assert.rejects(newPlugin(failing, 'my-plugin', cwd), {
    message: `Could not make the plugin my-plugin, so ${path.join(cwd, 'my-plugin')} is removed: git config user.name is not set`,
  });
  const silent = fakeBuild('exit 3');
  await assert.rejects(newPlugin(silent, 'my-plugin', cwd), {message: 'Could not make the plugin my-plugin: nanoagent plugin new failed (exit status: 3)'});
  const noSkill = {...fakeBuild('mkdir "$6"'), skill: path.join(cwd, 'missing', 'SKILL.md')};
  await assert.rejects(newPlugin(noSkill, 'my-plugin', cwd), /no such file or directory/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('removes only a draft this computer has, by a plugin id', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-data-'));
  assert.throws(() => removeDraft(data, '../connections'), /^Error: \.\.\/connections is not a plugin id$/);
  assert.throws(() => removeDraft(data, 'my-draft'), /^Error: No draft named my-draft is on this computer$/);
  fs.mkdirSync(path.join(data, 'drafts', 'my-draft'), {recursive: true});
  removeDraft(data, 'my-draft');
  assert.equal(fs.existsSync(path.join(data, 'drafts', 'my-draft')), false);
});

test('previews a draft for the one connection on this computer, or the one named of several', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-data-'));
  assert.throws(() => previewConnection(data, CONFIG, null), /^Error: No account is connected on this computer: open RUSH Lab and sign in$/);
  const alice = await addConnection(data, CONFIG, 'https://rush-lab.org', {session: 'tok-a', member: {id: 'alice', login: 'alice-gh'}});
  assert.deepEqual(previewConnection(data, CONFIG, null), {id: alice, login: 'alice-gh', site: 'https://rush-lab.org'});
  const dev = await addConnection(data, CONFIG, 'http://localhost:3000', {session: 'tok-b', member: {id: 'alice', login: 'alice-gh'}});
  assert.throws(() => previewConnection(data, CONFIG, null), error => error.message === [
    'More than one account is connected on this computer: name the draft\'s with --to <connection>:',
    `  ${dev}  @alice-gh on http://localhost:3000`,
    `  ${alice}  @alice-gh on https://rush-lab.org`,
  ].join('\n'));
  assert.deepEqual(previewConnection(data, CONFIG, dev), {id: dev, login: 'alice-gh', site: 'http://localhost:3000'});
  assert.throws(() => previewConnection(data, CONFIG, 'other'), /^Error: No connection other is on this computer\. Its connections:\n/);
});
