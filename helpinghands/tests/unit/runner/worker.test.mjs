import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {benchmarkWorker, containerName, containerSite, mintCredential, queueRemoval, removeWorkerData, retryRemovals, WORKER_IMAGE, workerArgs} from '../../../src/runner/worker.mjs';
import {installOptions, startOptions} from '../../../src/runner/docker-help.js';
import {readConcurrency, writeConcurrency} from '../../../src/runner/lab.mjs';
import {workerNotice} from '../../../src/components/Benchmark/worker.js';

const INFO = {ServerVersion: '29.8', NCPU: 8, MemTotal: 16 * 1024 ** 3, SecurityOptions: ['name=seccomp,profile=builtin']};
const PROOF_LINES = ['leftover reaping passed', 'collector probe passed: python-3', 'egress filter verified', 'advertised capabilities: {}'];
const CLAIMING_LINE = 'claiming from RUSH: openrouter';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/**
 * A fake docker: `script(args)` answers what it knows (a result, or a function of the call's options); every call is recorded.
 * `docker logs` plays `logLines` and ends when `docker wait` is released with `exit(code)`.
 */
function setup({key = 'sk-or-one', session = 'session', info = INFO, installed = true, running = true, present = true, pullFails = false, logLines = [...PROOF_LINES, CLAIMING_LINE], retryMs = 5, stopMs = 0} = {}) {
  const calls = [];
  const state = {key, running, installed, present, session, concurrency: 1};
  const snapshots = [];
  const logs = [];
  let release;
  const waits = [];
  const docker = async (args, options = {}) => {
    calls.push({args, env: options.env});
    const [verb] = args;
    if (verb === '--version') return state.installed ? {code: 0, tail: ['Docker version 29.8']} : {code: null, error: Object.assign(new Error('spawn docker ENOENT'), {code: 'ENOENT'}), tail: []};
    if (verb === 'info') return state.running ? {code: 0, tail: [JSON.stringify(info)]} : {code: 1, tail: ['Cannot connect to the Docker daemon']};
    if (verb === 'image') return {code: state.present ? 0 : 1, tail: []};
    if (verb === 'pull') {
      options.onLine?.('aaaaaaaaaaaa: Pulling fs layer');
      options.onLine?.('aaaaaaaaaaaa: Pull complete');
      return pullFails ? {code: 1, tail: ['denied']} : {code: 0, tail: []};
    }
    if (verb === 'logs') {
      for (const line of logLines) options.onLine(line);
      return new Promise(resolve => waits.push(() => resolve({code: 0, tail: []})));
    }
    if (verb === 'stop' && stopMs) await new Promise(resolve => setTimeout(resolve, stopMs));
    if (verb === 'wait') return new Promise(resolve => { release = code => { waits.splice(0).forEach(done => done()); resolve({code: 0, tail: [String(code)]}); }; });
    return {code: 0, tail: []};
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'));
  const minted = [];
  const worker = benchmarkWorker({
    id: 'rush-lab.org-u1', site: 'https://rush-lab.org', device: 'laptop', product: 'RUSH Lab', logFile: path.join(folder, 'worker.log'),
    readKey: () => state.key, readConcurrency: () => state.concurrency, writeConcurrency: value => { state.concurrency = value; }, readSession: () => state.session, dockerEnv: async () => ({PATH: '/usr/bin'}),
    report: snapshot => snapshots.push(snapshot), log: message => logs.push(message),
    docker, mint: async arguments_ => { minted.push(arguments_); return {token: `rwk_${minted.length}`}; },
    sleep: () => new Promise(resolve => setTimeout(resolve, retryMs)), retryMs, platform: 'darwin',
  });
  const verbs = () => calls.map(call => call.args[0]);
  return {worker, state, calls, snapshots, logs, minted, verbs, exit: code => release(code), last: () => snapshots.at(-1)};
}
const states = snapshot => Object.fromEntries(snapshot.checks.map(check => [check.id, check.state]));

test('a healthy start runs every check in order, then the worker, and reaches ready', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  assert.deepEqual(states(t.last()), {
    'docker-cli': 'pass', 'docker-daemon': 'pass', privileged: 'pass', resources: 'pass', image: 'pass', key: 'pass', proofs: 'pass', claims: 'pass',
  });
  assert.equal(t.last().state, 'ready');
  assert.deepEqual(t.verbs().slice(0, 6), ['--version', 'info', 'image', 'rm', 'run', 'logs']);
  const run = t.calls.find(call => call.args[0] === 'run');
  assert.ok(run.args.includes(WORKER_IMAGE));
  // The secrets travel by name in the environment, never on the command line.
  assert.equal(run.env.OPENROUTER_API_KEY, 'sk-or-one');
  assert.equal(run.env.RUSH_WORKER_TOKEN, 'rwk_1');
  assert.ok(!run.args.join(' ').includes('sk-or-one') && !run.args.join(' ').includes('rwk_1'));
  assert.deepEqual(t.minted, [{site: 'https://rush-lab.org', token: 'session', name: 'RUSH Lab on laptop'}]);
});

test('the worker reaches RUSH only when it says it claimed: proofs alone leave the check running, an outage warns, recovery passes', async () => {
  const t = setup({logLines: PROOF_LINES});
  await t.worker.start();
  await settle();
  assert.equal(states(t.last()).proofs, 'pass');
  assert.equal(states(t.last()).claims, 'running');
  assert.equal(t.last().state, 'starting');
  assert.equal(t.last().platform, 'darwin');
  const outage = setup({logLines: [...PROOF_LINES, 'RUSH is unreachable, retrying until it returns: down']});
  await outage.worker.start();
  await settle();
  assert.equal(states(outage.last()).claims, 'warn');
  const recovered = setup({logLines: [...PROOF_LINES, 'RUSH is unreachable, retrying until it returns: down', 'RUSH is reachable again', CLAIMING_LINE]});
  await recovered.worker.start();
  await settle();
  assert.equal(states(recovered.last()).claims, 'pass');
  assert.equal(recovered.last().state, 'ready');
});

test('each failing check stops the chain with its own message and leaves the rest pending', async () => {
  const cases = [
    [{installed: false}, 'docker-cli', 'no-docker', /not installed/, ['docker-daemon', 'privileged', 'resources', 'image', 'key', 'proofs', 'claims']],
    [{running: false}, 'docker-daemon', 'no-docker', /not running/, ['privileged', 'resources', 'image', 'key', 'proofs', 'claims']],
    [{info: {...INFO, SecurityOptions: ['name=rootless']}}, 'privileged', 'no-docker', /rootless/, ['resources', 'image', 'key', 'proofs', 'claims']],
    [{present: false, pullFails: true}, 'image', 'failed', /Could not pull/, ['key', 'proofs', 'claims']],
  ];
  for (const [options, failing, state, message, pending] of cases) {
    const t = setup(options);
    t.worker.start();
    await settle();
    const snapshot = t.last();
    assert.equal(states(snapshot)[failing], 'fail', failing);
    assert.equal(snapshot.state, state);
    assert.match(snapshot.message, message);
    for (const id of pending) assert.equal(states(snapshot)[id], 'pending', `${failing}: ${id}`);
    assert.ok(!t.verbs().includes('run'), failing);
    await t.worker.stop();
  }
});

test('the privileged check passes with a plain "Allowed."', async () => {
  const t = setup();
  t.worker.start();
  await settle();
  assert.equal(t.last().checks.find(check => check.id === 'privileged').message, 'Allowed.');
  await t.worker.stop();
});

test('Docker missing is found again once it is installed, without pressing anything', async () => {
  const t = setup({installed: false});
  t.worker.start();
  await settle();
  assert.equal(t.last().state, 'no-docker');
  t.state.installed = true;
  await settle();
  await settle();
  assert.equal(t.last().state, 'ready');
});

test('low Docker resources warn and the worker still starts', async () => {
  const t = setup({info: {...INFO, NCPU: 1}});
  await t.worker.start();
  await settle();
  assert.equal(states(t.last()).resources, 'warn');
  assert.match(t.last().checks.find(check => check.id === 'resources').message, /at least 2 CPUs and 4 GiB/);
  assert.equal(t.last().state, 'ready');
});

test('the image is pulled, with progress, when it is not there', async () => {
  const t = setup({present: false});
  await t.worker.start();
  await settle();
  assert.ok(t.verbs().includes('pull'));
  assert.ok(t.snapshots.some(snapshot => snapshot.state === 'pulling' && snapshot.progress?.total === 1));
  assert.equal(t.last().state, 'ready');
});

test('the first launch without a key waits: every earlier check ran, nothing is minted or run', async () => {
  const t = setup({key: null, present: false});
  await t.worker.start();
  await settle();
  assert.equal(t.last().state, 'no-key');
  assert.match(t.last().message, /Add your OpenRouter key in Settings/);
  assert.deepEqual(states(t.last()), {
    'docker-cli': 'pass', 'docker-daemon': 'pass', privileged: 'pass', resources: 'pass', image: 'pass', key: 'wait', proofs: 'pending', claims: 'pending',
  });
  assert.deepEqual([t.minted.length, t.verbs().includes('run')], [0, false]);
});

test('a key added later starts the worker from the key check, without the earlier checks again', async () => {
  const t = setup({key: null});
  await t.worker.start();
  const before = t.calls.length;
  t.state.key = 'sk-or-new';
  await t.worker.keysChanged();
  await settle();
  assert.equal(t.last().state, 'ready');
  assert.ok(!t.calls.slice(before).some(call => ['--version', 'info', 'pull'].includes(call.args[0])));
  assert.equal(t.calls.find(call => call.args[0] === 'run').env.OPENROUTER_API_KEY, 'sk-or-new');
});

test('a key changed restarts the worker with the new key; stopping it first', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  t.state.key = 'sk-or-two';
  const pending = t.worker.keysChanged();
  t.exit(143);
  await pending;
  await settle();
  const verbs = t.verbs();
  assert.ok(verbs.indexOf('stop') > verbs.indexOf('run'));
  assert.deepEqual(t.calls.find(call => call.args[0] === 'stop').args.slice(0, 3), ['stop', '--time', '10']);
  const runs = t.calls.filter(call => call.args[0] === 'run');
  assert.deepEqual(runs.map(call => call.env.OPENROUTER_API_KEY), ['sk-or-one', 'sk-or-two']);
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'ready');
});

test('two settings changes within the stop window launch one worker, with the later setting', async () => {
  const t = setup({stopMs: 60});
  await t.worker.start();
  await settle();
  t.state.key = 'sk-or-two';
  const first = t.worker.keysChanged();
  await new Promise(resolve => setTimeout(resolve, 20));
  t.state.key = 'sk-or-three';
  const second = t.worker.keysChanged();
  t.exit(143);
  await Promise.all([first, second]);
  await settle();
  assert.deepEqual(t.calls.filter(call => call.args[0] === 'run').map(call => call.env.OPENROUTER_API_KEY), ['sk-or-one', 'sk-or-three']);
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'ready');
});

test('a settings change during a start does not launch a second worker', async () => {
  const t = setup({stopMs: 60});
  await t.worker.start();
  await settle();
  t.state.key = 'sk-or-two';
  const changed = t.worker.keysChanged();
  await new Promise(resolve => setTimeout(resolve, 20));
  const restarted = t.worker.start();
  t.exit(143);
  await Promise.all([changed, restarted]);
  await settle();
  assert.equal(t.verbs().filter(verb => verb === 'run').length, 2);
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'ready');
});

test('a removed connection\'s container and both volumes are removed', async () => {
  const t = setup();
  await removeWorkerData('rush-lab.org-u1', {dockerEnv: async () => ({}), docker: async args => { t.calls.push({args}); return {code: 0, tail: []}; }});
  assert.deepEqual(t.calls.map(call => call.args), [
    ['rm', '--force', 'rush-lab-worker-rush-lab.org-u1'],
    ['volume', 'rm', '--force', 'rush-lab-worker-rush-lab.org-u1-docker', 'rush-lab-worker-rush-lab.org-u1-home'],
  ]);
});

test('a removal Docker refuses is an error, not passed over', async () => {
  await assert.rejects(
    removeWorkerData('rush-lab.org-u1', {dockerEnv: async () => ({}), docker: async () => ({code: 1, tail: ['Cannot connect to the Docker daemon']})}),
    /docker rm --force for rush-lab-worker-rush-lab\.org-u1 failed: Cannot connect to the Docker daemon/,
  );
});

test('a key removed stops the worker and waits again', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  t.state.key = undefined;
  const pending = t.worker.keysChanged();
  t.exit(143);
  await pending;
  assert.ok(t.verbs().includes('stop'));
  assert.equal(t.last().state, 'no-key');
  assert.equal(states(t.last()).proofs, 'pending');
});

test('stop on the connection ending stops and removes the container', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  const stopping = t.worker.stop();
  t.exit(143);
  await stopping;
  const tail = t.verbs().slice(-2);
  assert.deepEqual(tail, ['stop', 'rm']);
  // Nothing is restarted after it, whatever the old container's exit said.
  await settle();
  assert.equal(t.verbs().filter(verb => verb === 'run').length, 1);
});

test('a crash is restarted once with a new credential, then fails clearly with the last log lines', async () => {
  const t = setup({logLines: [...PROOF_LINES, CLAIMING_LINE, 'worker: HTTP 401 unauthorized']});
  await t.worker.start();
  await settle();
  t.exit(1);
  await settle();
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'ready');
  t.exit(1);
  await settle();
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'failed');
  assert.match(t.last().message, /RUSH rejected the worker's credential/);
  assert.match(t.last().message, /401 unauthorized/);
  assert.equal(states(t.last()).claims, 'fail');
  // Restart is the member's, and tries again.
  await t.worker.restart();
  await settle();
  assert.equal(t.minted.length, 3);
});

test('re-check runs the checks again; a worker not running is started', async () => {
  const t = setup({running: false});
  t.worker.start();
  await settle();
  assert.equal(t.last().state, 'no-docker');
  t.state.running = true;
  await t.worker.recheck();
  await settle();
  assert.equal(t.last().state, 'ready');
});

test('the worker waits for the member to sign in before it gets a credential', async () => {
  const t = setup({session: null});
  t.worker.start();
  await settle();
  assert.equal(t.minted.length, 0);
  t.state.session = 'session';
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(t.minted.length, 1);
});

test('names the container and reaches a local site as the host', () => {
  assert.equal(containerName('localhost-3000-u 1'), 'rush-lab-worker-localhost-3000-u-1');
  assert.equal(containerSite('http://localhost:3000'), 'http://host.docker.internal:3000');
  assert.equal(containerSite('https://rush-lab.org/'), 'https://rush-lab.org');
  const args = workerArgs({name: 'n', site: 'https://rush-lab.org', worker: 'lab-x'});
  assert.deepEqual(args.slice(0, 6), ['run', '-d', '--init', '--privileged', '--cgroupns=private', '--name']);
  assert.ok(args.includes('rush.base_url=https://rush-lab.org'));
});

test('mints a credential after revoking this device\'s earlier ones', async () => {
  const seen = [];
  const answers = {
    'GET /worker-credentials': {credentials: [{credential_id: 'a', name: 'RUSH Lab on laptop', revoked_at: null}, {credential_id: 'b', name: 'other', revoked_at: null}, {credential_id: 'c', name: 'RUSH Lab on laptop', revoked_at: 'x'}]},
    'DELETE /worker-credentials/a': {},
    'POST /worker-credentials': {token: 'rwk_new'},
  };
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${url.replace('https://rush-lab.org/api/benchmark', '')}`;
    seen.push([key, init.headers.Authorization]);
    return {ok: key in answers, status: 500, json: async () => answers[key] ?? {}};
  };
  const credential = await mintCredential({site: 'https://rush-lab.org', token: 'tok', name: 'RUSH Lab on laptop', fetchImpl});
  assert.equal(credential.token, 'rwk_new');
  assert.deepEqual(seen.map(([key]) => key), ['GET /worker-credentials', 'DELETE /worker-credentials/a', 'POST /worker-credentials']);
  assert.ok(seen.every(([, auth]) => auth === 'Bearer tok'));
});

test('a credential answer that is not JSON fails with the route, and an error answer without JSON with its status', async () => {
  const notJson = async () => { throw new SyntaxError('Unexpected token <'); };
  const ok = async () => ({ok: true, status: 200, json: notJson});
  await assert.rejects(mintCredential({site: 'https://rush-lab.org', token: 'tok', name: 'n', fetchImpl: ok}), /answered GET \/worker-credentials with something that is not JSON: Unexpected token </);
  const failing = async () => ({ok: false, status: 502, json: notJson});
  await assert.rejects(mintCredential({site: 'https://rush-lab.org', token: 'tok', name: 'n', fetchImpl: failing}), /^Error: https:\/\/rush-lab\.org answered 502$/);
});

test('the Benchmark screens say what each worker state needs', () => {
  assert.equal(workerNotice(null), null);
  assert.match(workerNotice({connected: false}).text, /Open RUSH Lab/);
  const say = worker => workerNotice({connected: true, worker}).text;
  assert.equal(say({state: 'ready'}), 'Benchmark worker ready.');
  assert.match(say({state: 'no-key'}), /Add your OpenRouter key in Settings/);
  assert.equal(workerNotice({connected: true, worker: {state: 'no-key'}}).tone, 'bad');
  assert.equal(workerNotice({connected: true, worker: {state: 'ready'}}).tone, 'ok');
  assert.match(say({state: 'no-docker', message: 'Docker is not installed. Install Docker Desktop'}), /Install Docker Desktop/);
  assert.match(say({state: 'pulling', progress: {done: 2, total: 5}}), /2 of 5 layers/);
  assert.match(say({state: 'failed', message: 'RUSH rejected the worker\'s credential'}), /failed: RUSH rejected/);
});

test('Docker install and start commands per OS live in one place', () => {
  assert.deepEqual(installOptions('darwin').map(option => option.commands[0]), ['brew install --cask docker', 'brew install colima docker']);
  assert.deepEqual(installOptions('win32')[0].commands, ['winget install -e --id Docker.DockerDesktop']);
  assert.deepEqual(installOptions('linux')[0].commands, ['curl -fsSL https://get.docker.com | sh', 'sudo usermod -aG docker $USER']);
  assert.deepEqual(startOptions('darwin').flatMap(option => option.commands ?? []), ['colima start']);
  assert.deepEqual(startOptions('linux')[0].commands, ['sudo systemctl start docker']);
});

test('the runner concurrency goes to the container, and changing it restarts the worker like a key change', async () => {
  const t = setup({logLines: [...PROOF_LINES.slice(0, 3), 'advertised capabilities: {"concurrency": 2}', CLAIMING_LINE]});
  await t.worker.start();
  await settle();
  assert.deepEqual(t.last().concurrency, {setting: 1, cpus: 8, effective: 2});
  assert.ok(t.calls.find(call => call.args[0] === 'run').args.includes('limits.concurrency=1'));
  const pending = t.worker.setConcurrency(4);
  t.exit(143);
  await pending;
  await settle();
  const runs = t.calls.filter(call => call.args[0] === 'run');
  assert.deepEqual(runs.map(call => call.args.at(-1)), ['limits.concurrency=1', 'limits.concurrency=4']);
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().concurrency.setting, 4);
  // The same value again restarts nothing.
  await t.worker.setConcurrency(4);
  assert.equal(t.calls.filter(call => call.args[0] === 'run').length, 2);
});

test('advertised capabilities the app cannot read fail the proofs and stop the worker', async () => {
  const t = setup({logLines: [...PROOF_LINES.slice(0, 3), 'advertised capabilities: {not json', CLAIMING_LINE]});
  await t.worker.start();
  await settle();
  assert.equal(states(t.last()).proofs, 'fail');
  assert.equal(states(t.last()).claims, 'pending');
  assert.match(t.last().message, /advertised capabilities are not readable/);
  assert.ok(t.verbs().includes('stop'));
});

test('a runner concurrency the worker cannot read fails the start with the reason', async () => {
  const t = setup();
  Object.defineProperty(t.state, 'concurrency', {get() { throw new Error('worker.json holds no runner concurrency'); }});
  await t.worker.start();
  await settle();
  assert.equal(t.last().state, 'failed');
  assert.match(t.last().message, /holds no runner concurrency/);
  assert.ok(!t.verbs().includes('run'));
});

test('an invalid runner concurrency is refused and not kept', async () => {
  const t = setup();
  await t.worker.start();
  for (const value of [0, -1, 1.5, NaN, '2', null]) await assert.rejects(t.worker.setConcurrency(value), /whole number of at least 1/);
  assert.equal(t.state.concurrency, 1);
});

test('the runner concurrency persists in a file of the connection, 1 until set, and refuses invalid values', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-')), 'nested', 'worker.json');
  assert.equal(readConcurrency(file), 1);
  writeConcurrency(file, 3);
  assert.equal(readConcurrency(file), 3);
  assert.throws(() => writeConcurrency(file, 0), /whole number/);
  assert.throws(() => writeConcurrency(file, 2.5), /whole number/);
  assert.equal(readConcurrency(file), 3);
  fs.writeFileSync(file, '{"concurrency": "x"}');
  assert.throws(() => readConcurrency(file), /holds no runner concurrency/);
  fs.writeFileSync(file, '{"concurrency":');
  assert.throws(() => readConcurrency(file), /worker\.json: /);
});

/** A fake docker whose `run` takes a while and names its container by id (`rm` by name removes whichever holds the name), as the reviewer's races needed. */
function raceSetup() {
  const containers = new Map();
  const events = [];
  const state = {key: 'sk-one', nextId: 0, onRun: null};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const docker = async (args, options = {}) => {
    const [verb] = args;
    if (verb === '--version') return {code: 0, tail: ['Docker 29']};
    if (verb === 'info') return {code: 0, tail: [JSON.stringify(INFO)]};
    if (verb === 'image' || verb === 'stop') return {code: 0, tail: []};
    if (verb === 'rm') {
      const target = args.at(-1);
      const found = [...containers.entries()].find(([name, entry]) => name === target || entry.id === target);
      if (found) {
        events.push(`rm ${found[1].id}`);
        containers.delete(found[0]);
        found[1].waiters.forEach(done => done());
      }
      return {code: 0, tail: []};
    }
    if (verb === 'run') {
      const name = args[args.indexOf('--name') + 1];
      state.onRun?.();
      state.onRun = null;
      if (containers.has(name)) return {code: 125, tail: ['Conflict. The container name is already in use']};
      const entry = {id: `c${++state.nextId}`, waiters: []};
      containers.set(name, entry);
      await sleep(60);
      return {code: 0, tail: [entry.id]};
    }
    if (verb === 'logs') {
      const entry = containers.get(args.at(-1));
      for (const line of [...PROOF_LINES, CLAIMING_LINE]) options.onLine(line);
      return new Promise(resolve => (entry ? entry.waiters.push(() => resolve({code: 0, tail: []})) : resolve({code: 0, tail: []})));
    }
    if (verb === 'wait') {
      const entry = containers.get(args.at(-1));
      return new Promise(resolve => (entry ? entry.waiters.push(() => resolve({code: 0, tail: ['137']})) : resolve({code: 0, tail: ['1']})));
    }
    return {code: 0, tail: []};
  };
  const snapshots = [];
  const worker = benchmarkWorker({
    id: 'x', site: 'https://rush-lab.org', device: 'laptop', product: 'RUSH Lab', logFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-')), 'worker.log'),
    readKey: () => state.key, readSession: () => 'session', dockerEnv: async () => ({}), report: snapshot => snapshots.push(snapshot), log: () => {},
    docker, mint: async () => ({token: 't'}), sleep: () => sleep(2), platform: 'darwin',
  });
  return {worker, state, containers, events, last: () => snapshots.at(-1), sleep};
}

test('a key change in the middle of docker run leaves only the newest container, which keeps running (stale launch removed the newer one)', async () => {
  const t = raceSetup();
  t.state.onRun = () => { t.state.key = 'sk-two'; t.worker.keysChanged(); };
  await t.worker.start();
  await t.sleep(400);
  assert.deepEqual([...t.containers.values()].map(entry => entry.id), ['c2']);
  assert.equal(t.last().state, 'ready');
  // The stale run's container was removed by its id, and the newer one was never removed.
  assert.ok(t.events.includes('rm c1'));
  assert.ok(!t.events.includes('rm c2'));
});

test('two key changes racing docker run within the stable window still end ready with a container', async () => {
  const t = raceSetup();
  t.state.onRun = () => { t.state.key = 'sk-two'; t.worker.keysChanged(); };
  await t.worker.start();
  await t.sleep(400);
  t.state.onRun = () => { t.state.key = 'sk-four'; t.worker.keysChanged(); };
  t.state.key = 'sk-three';
  await t.worker.keysChanged();
  await t.sleep(400);
  assert.equal(t.containers.size, 1);
  assert.equal(t.last().state, 'ready');
});

test('stop during docker run waits for it and leaves no container behind', async () => {
  const t = raceSetup();
  t.state.onRun = () => { t.worker.stop(); };
  await t.worker.start();
  await t.sleep(300);
  assert.equal(t.containers.size, 0);
  // stop() resolves only after the run it interrupted has been cleaned up.
  const again = raceSetup();
  let stopped = false;
  again.state.onRun = () => { again.worker.stop().then(() => { stopped = true; assert.equal(again.containers.size, 0); }); };
  await again.worker.start();
  await again.sleep(300);
  assert.ok(stopped);
});

test('a removal that failed stays queued and is retried until it succeeds, then dropped', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pending-')), 'pending-removals.json');
  let down = true;
  const calls = [];
  const docker = async args => { calls.push(args[0]); return down ? {code: 1, tail: ['Cannot connect to the Docker daemon']} : {code: 0, tail: []}; };
  queueRemoval(file, 'a');
  queueRemoval(file, 'a');
  queueRemoval(file, 'b');
  const failed = await retryRemovals(file, {dockerEnv: async () => ({}), docker});
  assert.deepEqual(failed.map(entry => entry.id), ['a', 'b']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['a', 'b']);
  down = false;
  assert.deepEqual(await retryRemovals(file, {dockerEnv: async () => ({}), docker}), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
  assert.ok(calls.includes('volume'));
});
