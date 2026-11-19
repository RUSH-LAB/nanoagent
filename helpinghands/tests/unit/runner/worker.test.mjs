import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {benchmarkWorker, hostSupport, mintCredential, workerCommand} from '../../../src/runner/worker.mjs';
import {readConcurrency, writeConcurrency} from '../../../src/runner/lab.mjs';
import {workerNotice} from '../../../src/components/PluginFrame/worker.js';

const PROOF_LINES = ['plugin sandbox verified', 'leftover reaping passed', 'images ready', 'guest tools ready', 'tracer probe passed: python-3', 'egress fence verified', 'advertised capabilities: {}'];
const CLAIMING_LINE = 'claiming from RUSH: openrouter';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/**
 * A fake process runner: each `run` is recorded with its program, arguments and environment, plays `logLines` to `onLine`, and
 * runs until `exit(code)` or until it is killed (each kill recorded; `killMs` delays the exit a kill causes).
 */
function setup({key = 'sk-or-one', session = 'session', platform = 'darwin', arch = 'arm64', logLines = [...PROOF_LINES, CLAIMING_LINE], killMs = 0, mint} = {}) {
  const runs = [];
  const kills = [];
  const state = {key, session, concurrency: 1};
  const snapshots = [];
  const logs = [];
  const run = (program, args, {cwd, env, onLine}) => {
    let finish;
    const exited = new Promise(resolve => { finish = resolve; });
    const entry = {program, args, cwd, env, finish, live: true};
    const child = {
      kill(signal) {
        kills.push(signal);
        setTimeout(() => { entry.live = false; finish({code: null, signal}); }, killMs);
      },
    };
    runs.push(entry);
    queueMicrotask(() => logLines.forEach(onLine));
    return {child, exited};
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'));
  const minted = [];
  const worker = benchmarkWorker({
    site: 'https://rush-lab.org', device: 'laptop', product: 'RUSH Lab', logFile: path.join(folder, 'worker.log'),
    python: '/bundle/nanoagent/.venv/bin/python', nanoagent: '/bundle/nanoagent', folder: '/data/connections/c1', system: {PATH: '/usr/bin'},
    readKey: () => state.key, readConcurrency: () => state.concurrency, writeConcurrency: value => { state.concurrency = value; }, readSession: () => state.session,
    report: snapshot => snapshots.push(snapshot), log: message => logs.push(message), run,
    mint: mint ?? (async arguments_ => { minted.push(arguments_); return {token: `rwk_${minted.length}`}; }),
    sleep: () => new Promise(resolve => setTimeout(resolve, 5)), platform, arch, kvm: () => true,
  });
  const exit = code => runs.filter(entry => entry.live).forEach(entry => { entry.live = false; entry.finish({code, signal: null}); });
  return {worker, state, runs, kills, snapshots, logs, minted, exit, last: () => snapshots.at(-1)};
}
const states = snapshot => Object.fromEntries(snapshot.checks.map(check => [check.id, check.state]));

test('a healthy start runs every check in order, then the worker, and reaches ready', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  assert.deepEqual(states(t.last()), {host: 'pass', key: 'pass', proofs: 'pass', claims: 'pass'});
  assert.equal(t.last().state, 'ready');
  assert.equal(t.runs.length, 1);
  const [run] = t.runs;
  assert.equal(run.program, '/bundle/nanoagent/.venv/bin/python');
  assert.equal(run.cwd, '/bundle/nanoagent');
  assert.deepEqual(run.args.slice(0, 4), ['-I', '-m', 'nanoagent.uploaded.worker', 'config=deploy/worker/worker.openrouter.yaml']);
  assert.ok(run.args.includes('rush.base_url=https://rush-lab.org') && run.args.includes('worker_id=lab-laptop'));
  assert.ok(run.args.includes(`scratch=${JSON.stringify('/data/connections/c1/worker')}`), 'the scratch is the connection\'s own');
  // The secrets travel in the environment, never on the command line.
  assert.equal(run.env.OPENROUTER_API_KEY, 'sk-or-one');
  assert.equal(run.env.RUSH_WORKER_TOKEN, 'rwk_1');
  assert.equal(run.env.PATH, '/usr/bin');
  assert.ok(!run.args.join(' ').includes('sk-or-one') && !run.args.join(' ').includes('rwk_1'));
  assert.deepEqual(t.minted, [{site: 'https://rush-lab.org', token: 'session', name: 'RUSH Lab on laptop'}]);
});

test('the worker reaches RUSH only when it says it claimed: proofs alone leave the check running, an outage warns, recovery passes', async () => {
  const t = setup({logLines: PROOF_LINES});
  await t.worker.start();
  await settle();
  assert.equal(states(t.last()).proofs, 'pass');
  assert.match(t.last().checks.find(check => check.id === 'proofs').message, /plugin sandbox, leftover cleanup, images, guest tools, toolchain probes, egress fence/);
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

test('the images the worker pulls as it starts are its progress, in bytes, until they are ready', async () => {
  const pulling = ['plugin sandbox verified', 'leftover reaping passed', 'INFO:nanoagent:pulling images: 0 of 0 bytes', 'INFO:nanoagent:pulling images: 5000000 of 20000000 bytes'];
  const t = setup({logLines: pulling});
  await t.worker.start();
  await settle();
  assert.deepEqual(t.last().progress, {done: 5000000, total: 20000000});
  assert.equal(t.last().state, 'starting');
  assert.match(t.last().checks.find(check => check.id === 'proofs').message, /Pulling images: 5000000 of 20000000 bytes/);
  assert.match(workerNotice({connected: true, worker: t.last()}).text, /preparing: 5 of 20 MB/);
  const ready = setup({logLines: [...pulling, ...PROOF_LINES.slice(2)]});
  await ready.worker.start();
  await settle();
  assert.equal(ready.last().progress, null);
});

test('a computer the sandboxes cannot run on is unsupported, says why, and runs nothing', async () => {
  for (const [platform, arch, message] of [['darwin', 'x64', /Apple silicon/], ['freebsd', 'x64', /do not run on freebsd/]]) {
    const t = setup({platform, arch});
    await t.worker.start();
    await settle();
    assert.equal(t.last().state, 'unsupported');
    assert.match(t.last().message, message);
    assert.deepEqual(states(t.last()), {host: 'fail', key: 'pending', proofs: 'pending', claims: 'pending'});
    assert.deepEqual([t.runs.length, t.minted.length], [0, 0]);
  }
});

test('sandbox support: Apple silicon, Linux with KVM, Windows checked by the worker itself', () => {
  assert.equal(hostSupport({platform: 'darwin', arch: 'arm64'})[0], 'pass');
  assert.equal(hostSupport({platform: 'darwin', arch: 'x64'})[0], 'fail');
  assert.equal(hostSupport({platform: 'linux', arch: 'x64', kvm: () => true})[0], 'pass');
  const noKvm = hostSupport({platform: 'linux', arch: 'arm64', kvm: () => false});
  assert.deepEqual([noKvm[0], /\/dev\/kvm/.test(noKvm[1]), /KVM/.test(noKvm[2])], ['fail', true, true]);
  assert.equal(hostSupport({platform: 'linux', arch: 'ia32', kvm: () => true})[0], 'fail');
  assert.equal(hostSupport({platform: 'win32', arch: 'x64'})[0], 'pass');
});

test('the first launch without a key waits: the host check ran, nothing is minted or run', async () => {
  const t = setup({key: null});
  await t.worker.start();
  await settle();
  assert.equal(t.last().state, 'no-key');
  assert.match(t.last().message, /Add your OpenRouter key in Settings/);
  assert.deepEqual(states(t.last()), {host: 'pass', key: 'wait', proofs: 'pending', claims: 'pending'});
  assert.deepEqual([t.minted.length, t.runs.length], [0, 0]);
});

test('a key added later starts the worker from the key check', async () => {
  const t = setup({key: null});
  await t.worker.start();
  t.state.key = 'sk-or-new';
  await t.worker.keysChanged();
  await settle();
  assert.equal(t.last().state, 'ready');
  assert.equal(t.runs[0].env.OPENROUTER_API_KEY, 'sk-or-new');
});

test('a key changed restarts the worker with the new key; stopping it first', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  t.state.key = 'sk-or-two';
  await t.worker.keysChanged();
  await settle();
  assert.deepEqual(t.kills, ['SIGTERM']);
  assert.deepEqual(t.runs.map(run => run.env.OPENROUTER_API_KEY), ['sk-or-one', 'sk-or-two']);
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'ready');
});

test('two settings changes within the stop window launch one worker, with the later setting', async () => {
  const t = setup({killMs: 60});
  await t.worker.start();
  await settle();
  t.state.key = 'sk-or-two';
  const first = t.worker.keysChanged();
  await new Promise(resolve => setTimeout(resolve, 20));
  t.state.key = 'sk-or-three';
  const second = t.worker.keysChanged();
  await Promise.all([first, second]);
  await settle();
  assert.deepEqual(t.runs.map(run => run.env.OPENROUTER_API_KEY), ['sk-or-one', 'sk-or-three']);
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'ready');
});

test('a key removed stops the worker and waits again', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  t.state.key = undefined;
  await t.worker.keysChanged();
  assert.deepEqual(t.kills, ['SIGTERM']);
  assert.equal(t.last().state, 'no-key');
  assert.equal(states(t.last()).proofs, 'pending');
});

test('stop on the connection ending stops the worker, and nothing is restarted after it', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  await t.worker.stop();
  assert.deepEqual(t.kills, ['SIGTERM']);
  await settle();
  assert.equal(t.runs.length, 1);
});

test('a worker that exits after its startup proofs is started again every time, with a new credential and a growing wait', async () => {
  const t = setup();
  await t.worker.start();
  await settle();
  for (let exits = 1; exits <= 3; exits += 1) {
    t.exit(1);
    await settle();
    assert.equal(t.runs.length, exits + 1);
    assert.equal(t.minted.length, exits + 1);
    assert.equal(t.last().state, 'ready');
  }
  assert.deepEqual(t.logs.filter(line => line.includes('starting it again')), [1, 2, 4].map(s => `The worker exited (status 1); starting it again in ${s}s.`));
  await t.worker.stop();
  await settle();
  assert.equal(t.runs.length, 4);  // a stopped worker stays stopped
});

test('a crash in startup is restarted once with a new credential, then fails clearly with the last log lines', async () => {
  const t = setup({logLines: ['plugin sandbox verified', 'worker: HTTP 401 unauthorized']});
  await t.worker.start();
  await settle();
  t.exit(1);
  await settle();
  assert.equal(t.minted.length, 2);
  t.exit(1);
  await settle();
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().state, 'failed');
  assert.match(t.last().message, /RUSH rejected the worker's credential/);
  assert.match(t.last().message, /401 unauthorized/);
  assert.equal(states(t.last()).proofs, 'fail');
  // Restart is the member's, and tries again.
  await t.worker.restart();
  await settle();
  assert.equal(t.minted.length, 3);
});

test('a credential RUSH cannot give while it restarts (5xx, no answer) is tried again until it can; a refusal fails', async () => {
  const answers = [Object.assign(new Error('http://localhost:3000 answered 504'), {status: 504}), new TypeError('fetch failed')];
  const t = setup({mint: async () => {
    if (answers.length) throw answers.shift();
    return {token: 'rwk'};
  }});
  await t.worker.start();
  await settle();
  assert.equal(t.runs.length, 1);
  assert.equal(t.last().state, 'ready');
  const refused = setup({mint: async () => { throw Object.assign(new Error('Sign in again'), {status: 401}); }});
  await refused.worker.start();
  await settle();
  assert.equal(refused.last().state, 'failed');
  assert.match(refused.last().message, /Could not get a worker credential from https:\/\/rush-lab\.org: Sign in again/);
});

test('a worker that exits in startup is reported with its status', async () => {
  const t = setup({logLines: PROOF_LINES.slice(0, -1)});
  await t.worker.start();
  await settle();
  t.exit(2);
  await settle();
  t.exit(2);
  await settle();
  assert.match(t.last().message, /The worker exited \(status 2\)/);
});

test('re-check of a worker not running starts it', async () => {
  const t = setup({key: null});
  await t.worker.start();
  t.state.key = 'sk-or-one';
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
  await settle();
  assert.equal(t.minted.length, 1);
});

test('the worker command runs NanoAgent\'s worker with the connection\'s folders and no secret', () => {
  const [program, args] = workerCommand({python: '/p', folder: '/data/c 1', site: 'http://localhost:3000', worker: 'lab-x', concurrency: 3});
  assert.equal(program, '/p');
  assert.deepEqual(args, [
    '-I', '-m', 'nanoagent.uploaded.worker', 'config=deploy/worker/worker.openrouter.yaml', 'home="/data/c 1/worker-run"',
    '--', 'rush.base_url=http://localhost:3000', 'worker_id=lab-x', 'scratch="/data/c 1/worker"', 'limits.concurrency=3',
  ]);
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
  assert.match(say({state: 'unsupported', message: 'Benchmarks need a Mac with Apple silicon.'}), /Apple silicon/);
  assert.match(say({state: 'failed', message: 'RUSH rejected the worker\'s credential'}), /failed: RUSH rejected/);
});

test('the runner concurrency goes to the worker, and changing it restarts the worker like a key change', async () => {
  const t = setup({logLines: [...PROOF_LINES.slice(0, 5), 'advertised capabilities: {"concurrency": 2}', CLAIMING_LINE]});
  await t.worker.start();
  await settle();
  assert.deepEqual(t.last().concurrency, {setting: 1, cpus: os.availableParallelism(), effective: 2});
  await t.worker.setConcurrency(4);
  await settle();
  assert.deepEqual(t.runs.map(run => run.args.at(-1)), ['limits.concurrency=1', 'limits.concurrency=4']);
  assert.equal(t.minted.length, 2);
  assert.equal(t.last().concurrency.setting, 4);
  // The same value again restarts nothing.
  await t.worker.setConcurrency(4);
  assert.equal(t.runs.length, 2);
});

test('advertised capabilities the app cannot read fail the proofs and stop the worker', async () => {
  const t = setup({logLines: [...PROOF_LINES.slice(0, 5), 'advertised capabilities: {not json', CLAIMING_LINE]});
  await t.worker.start();
  await settle();
  assert.equal(states(t.last()).proofs, 'fail');
  assert.equal(states(t.last()).claims, 'pending');
  assert.match(t.last().message, /advertised capabilities are not readable/);
  assert.deepEqual(t.kills, ['SIGTERM']);
});

test('a runner concurrency the worker cannot read fails the start with the reason', async () => {
  const t = setup();
  Object.defineProperty(t.state, 'concurrency', {get() { throw new Error('worker.json holds no runner concurrency'); }});
  await t.worker.start();
  await settle();
  assert.equal(t.last().state, 'failed');
  assert.match(t.last().message, /holds no runner concurrency/);
  assert.equal(t.runs.length, 0);
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

test('a stop during a Restart is not undone: no new worker, no credential', async () => {
  const t = setup({killMs: 100});
  await t.worker.start();
  await settle();
  const mintedBefore = t.minted.length;
  const restarting = t.worker.restart();
  await settle();
  await t.worker.stop();
  await restarting;
  await settle();
  assert.equal(t.runs.length, 1);
  assert.equal(t.minted.length, mintedBefore);
});

test('a superseded launch blocked in its credential mint cannot start a second worker', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { entered = resolve; });
  let minted = 0;
  const t = setup({mint: async () => {
    minted += 1;
    if (minted === 1) { entered(); await gate; }
    return {token: `credential-${minted}`};
  }});
  const old = t.worker.start();
  await blocked;
  const current = t.worker.start();
  await settle();
  assert.equal(t.runs.length, 0, 'the new launch waits for the old transition to leave');
  release();
  await Promise.all([old, current]);
  await settle();
  assert.equal(t.runs.length, 1, 'only the current launch runs a worker');
  assert.equal(t.runs[0].env.RUSH_WORKER_TOKEN, 'credential-2');
  assert.equal(t.last().state, 'ready');
  await t.worker.stop();
});
