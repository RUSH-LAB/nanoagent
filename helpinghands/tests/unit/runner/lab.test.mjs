import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {spawnSync} from 'node:child_process';
import {
  addConnection, adoptLegacy, bundledCommand, commandLauncher, connectableSite, connectionId, installCommand, installsFolder, isServerUrl, linkMember,
  linkSession, keyHint, keyStatus, memberFiles, nanoagentCommand, newPlugin, onPath, parseEnv, pathAdvice, providerKeys, relayEnv,
  removeOtherSites, rushlab, rushlabCommand, SERVER_URLS, systemEnv, writeKeys,
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

test('reads env lines as RUSH does', () => {
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
  assert.equal(keys.length, 18);
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

test('keeps the member\'s own servers beside their keys, each address shown whole as it holds no secret', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-servers-'));
  const file = path.join(folder, 'settings.env');
  assert.deepEqual(SERVER_URLS, ['VLLM_BASE_URL', 'SGLANG_BASE_URL']);
  writeKeys(file, {VLLM_BASE_URL: 'http://gpu.lab:8000/v1', VLLM_API_KEY: 'vllm-key-0123456789', SGLANG_BASE_URL: 'https://[::1]:30000/v1'});
  const keys = keyStatus(parseEnv(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(keys.filter(key => key.set).map(({env, hint}) => [env, hint]), [
    ['VLLM_BASE_URL', 'http://gpu.lab:8000/v1'],
    ['VLLM_API_KEY', 'vllm-k…6789'],
    ['SGLANG_BASE_URL', 'https://[::1]:30000/v1'],
  ]);
  assert.deepEqual(keys.find(key => key.env === 'SGLANG_API_KEY'), {env: 'SGLANG_API_KEY', label: 'SGLang', set: false, hint: null});
  // NanoAgent gets them as it gets the keys.
  assert.deepEqual(Object.keys(providerKeys(parseEnv(fs.readFileSync(file, 'utf8')))).sort(), ['SGLANG_BASE_URL', 'VLLM_API_KEY', 'VLLM_BASE_URL']);
  for (const address of ['gpu.lab:8000/v1', 'ftp://gpu.lab/v1', 'http://user:secret@gpu.lab/v1', 'http://gpu.lab/v1?key=secret', 'http://gpu.lab/v1?', 'http://gpu.lab/v1#x', 'http://gpu.lab:99999/v1']) {
    assert.equal(isServerUrl(address), false, address);
    assert.throws(() => writeKeys(file, {VLLM_BASE_URL: address}), /VLLM_BASE_URL must be an http:\/\/ or https:\/\/ address/, address);
  }
  assert.match(fs.readFileSync(file, 'utf8'), /VLLM_BASE_URL=http:\/\/gpu.lab:8000\/v1\n/);
  // A server's key goes only to the address it was saved with: an address changed without its key
  // drops the key, in the file and in what NanoAgent is handed, so nothing can send it elsewhere.
  assert.deepEqual(writeKeys(file, {VLLM_BASE_URL: 'http://elsewhere.example/v1'}), {VLLM_BASE_URL: 'http://elsewhere.example/v1', VLLM_API_KEY: null});
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /VLLM_API_KEY/);
  assert.deepEqual(writeKeys(file, {VLLM_API_KEY: 'k2'}), {VLLM_API_KEY: 'k2'});
  assert.deepEqual(writeKeys(file, {VLLM_BASE_URL: null}), {VLLM_BASE_URL: null, VLLM_API_KEY: null});
  assert.equal(fs.readFileSync(file, 'utf8'), 'SGLANG_BASE_URL=https://[::1]:30000/v1\n');
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

test('keeps a member\'s files in a folder named for their login, which follows them to a new one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rushlab-files-'));
  try {
    const folder = memberFiles(root, {id: 'u1', login: 'ada'});
    fs.mkdirSync(path.join(folder, 'comp-480'));
    fs.writeFileSync(path.join(folder, 'comp-480', 'notes.md'), 'mine');
    assert.equal(memberFiles(root, {id: 'u1', login: 'ada'}), folder);
    // Renamed on GitHub: the folder is renamed, not downloaded again.
    const renamed = memberFiles(root, {id: 'u1', login: 'ada-l'});
    assert.equal(fs.readFileSync(path.join(renamed, 'comp-480', 'notes.md'), 'utf8'), 'mine');
    assert.deepEqual(fs.readdirSync(root), ['ada-l']);
    // A folder another member's files are in is never taken.
    assert.throws(() => memberFiles(root, {id: 'u2', login: 'ada-l'}), /holds another member's files/);
    // One made before folders said whose they are becomes its login's member's.
    fs.mkdirSync(path.join(root, 'bob'));
    assert.equal(memberFiles(root, {id: 'u3', login: 'bob'}), path.join(root, 'bob'));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('tells a connection\'s relay where RUSH, NanoAgent and its files are', () => {
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
  assert.deepEqual(rushlabCommand(['new', 'my-plugin']), {new: 'my-plugin'});
  assert.deepEqual(rushlabCommand(['nanoagent', 'plugin', 'inspect', '.', '--to']), {run: 'nanoagent', args: ['plugin', 'inspect', '.', '--to']});
  assert.deepEqual(rushlabCommand(['uv', 'lock']), {run: 'uv', args: ['lock']});
  assert.deepEqual(rushlabCommand(['uv']), {run: 'uv', args: []});
  for (const args of [[], ['publish'], ['new'], ['new', 'a', 'b'], ['preview'], ['preview', '.'], ['preview', '--stop', 'a']]) {
    assert.equal(rushlabCommand(args), null, args.join(' '));
  }
  const {result, lines} = await said(() => rushlab(['preview', '.'], {config: {...CONFIG, product_name: 'RUSH Lab Dev', command: 'rushlab-dev'}}));
  assert.equal(result, 2);
  assert.equal(lines[0], [
    'usage:',
    '  rushlab-dev new <id>           make the plugin <id> in ./<id>, for an AI CLI there to design with you',
    '  rushlab-dev nanoagent <args>   run RUSH Lab Dev\'s NanoAgent',
    '  rushlab-dev uv <args>          run RUSH Lab Dev\'s uv',
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
  const ran = spawnSync(file, ['nanoagent', 'a b', '--to', 'x'], {encoding: 'utf8'});
  assert.deepEqual([ran.status, ran.stdout], [0, `${path.join(root, 'runner', 'lab.mjs')}\nrushlab\nnanoagent\na b\n--to\nx\n`]);
  fs.rmSync(path.join(root, 'bin', 'node'));
  const gone = spawnSync(file, ['uv'], {encoding: 'utf8'});
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
  fs.writeFileSync(path.join(root, 'runner', 'plugin-project', 'project.md'), '# The plugin {{id}}\n\nRun `{{command}} uv run pytest` for {{id}}.\n');
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
    assert.equal(fs.readFileSync(path.join(folder, name), 'utf8'), '# The plugin my-plugin\n\nRun `rushlab-dev uv run pytest` for my-plugin.\n\n# Build and publish a NanoAgent plugin\n');
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
