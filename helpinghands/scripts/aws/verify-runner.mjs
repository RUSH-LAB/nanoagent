#!/usr/bin/env node

/**
 * RUSH Lab cloud's runner check (docs/infra/aws-deployment.md): the runner image started as AWS
 * starts it (infra/aws/runner/run.sh), shown to confine every plugin and to bound what one may
 * use, through Mochi's own NanoAgent client (src/server/ai.js), with a scripted model.
 *
 *   npm run cloud:verify
 *
 * It builds the image from the NanoAgent checkout beside this one (NANOAGENT_PROJECT_DIR), or
 * uses RUNNER_IMAGE. It needs Docker and uv, and the network: the plugins install from PyPI and
 * GitHub, and the probe reaches pypi.org through the sandbox's egress proxy. On Ubuntu, the
 * kernel must let bubblewrap make user namespaces (sysctl
 * kernel.apparmor_restrict_unprivileged_userns=0), as NanoAgent's own CI sets.
 *
 * The plugin it installs, cloud-probe, is NanoAgent's template (`nanoagent plugin new`) with
 * scripts/aws/probe/ over it: its tasks report what the sandbox let them see, reach and use, and
 * its verifier decides whether the sandbox held. Each check prints a line; the first that fails
 * stops the check with what it saw.
 */

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {createNanoAgentGateway} = require('../../src/server/ai.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const nanoagent = path.resolve(process.env.NANOAGENT_PROJECT_DIR || path.join(root, '..', 'nanoagent'));
const runner = path.join(root, 'infra/aws/runner');
const PROBE_HOSTS = {declared: 'pypi.org', undeclared: 'example.com', private: 'localtest.me'};
// What the probe's template brings that the probe does not keep.
const TEMPLATE_ONLY = ['src/plugin/note.py', 'verifier/note.py', 'tests/test_note.py'];

const run = (command, args, options = {}) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options});
const docker = (...args) => run('docker', args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function check(name, operation) {
  const started = Date.now();
  const detail = await operation();
  console.log(`ok   ${name}${detail ? `: ${detail}` : ''} (${Date.now() - started} ms)`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * A model that calls the task its run's input names, then answers: "probe", "hog <megabytes>",
 * "swarm <count> <megabytes>", "forks <count> [<seconds held>]". It streams when asked, as
 * NanoAgent asks.
 */
function scriptedModel() {
  const decide = body => {
    const messages = body.messages ?? [];
    const last = messages.findLastIndex(message => message.role === 'user');
    const input = String(messages[last]?.content ?? '');
    if (messages.slice(last + 1).some(message => message.role === 'tool')) return {text: `done: ${input}`};
    const [verb, ...amounts] = input.split(' ');
    const [first, second] = amounts.map(Number);
    const args = verb === 'probe' ? PROBE_HOSTS
      : verb === 'hog' ? {megabytes: first}
        : verb === 'swarm' ? {count: first, megabytes: second}
          : {count: first, hold_seconds: second || 0};
    return {tool: {name: verb, arguments: JSON.stringify(args)}};
  };
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const choice = decide(body);
      const usage = {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15};
      const chunk = (delta, finish = null) => ({id: 'verify', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{index: 0, delta, finish_reason: finish}]});
      const frames = choice.tool
        ? [chunk({role: 'assistant', tool_calls: [{index: 0, id: 'call-1', type: 'function', function: {name: choice.tool.name, arguments: choice.tool.arguments}}]}), chunk({}, 'tool_calls')]
        : [chunk({role: 'assistant', content: choice.text}), chunk({}, 'stop')];
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      for (const frame of [...frames, {id: 'verify', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage}]) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
}

/** The probe plugin's package: NanoAgent's template, the probe's files over it, packed by NanoAgent. */
function packProbe(work) {
  const folder = path.join(work, 'cloud-probe');
  run('uv', ['run', '--quiet', '--project', nanoagent, '--extra', 'web', 'python', '-m', 'nanoagent', 'plugin', 'new', folder], {cwd: nanoagent});
  for (const file of TEMPLATE_ONLY) fs.rmSync(path.join(folder, file));
  fs.cpSync(path.join(here, 'probe'), folder, {recursive: true});
  return pack(folder, path.join(work, 'cloud-probe.tar.gz'));
}

function pack(folder, file) {
  run('uv', ['run', '--quiet', '--project', nanoagent, '--extra', 'web', 'python', '-m', 'nanoagent', 'plugin', 'pack', folder, file], {cwd: nanoagent});
  const data = fs.readFileSync(file);
  return {data, sha256: crypto.createHash('sha256').update(data).digest('hex')};
}

/** A data folder the runner's uid may write, as the rollout makes /var/lib/rush-lab/runner. */
function dataFolder(work, name) {
  const folder = path.join(work, name);
  fs.mkdirSync(folder);
  fs.chmodSync(folder, 0o777);
  return folder;
}

/**
 * NanoAgent's answer to /health, asked on a connection of its own: one the client kept from an
 * earlier ask can be closed by the server as the ask goes out, which fails it for no fault of NanoAgent's.
 */
function health(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/health`, {agent: false, timeout: 10_000}, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('timeout', () => request.destroy(new Error(`${url}/health did not answer within 10 s`)));
    request.on('error', reject);
  });
}

async function healthy(url, container, seconds = 120) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // Still starting.
    }
    await sleep(500);
  }
  throw new Error(`the runner did not become healthy:\n${docker('logs', '--tail', '30', container)}`);
}

/** Wait until the container's log, its output and its errors, says `pattern`; its log. */
async function logged(container, pattern, seconds = 90) {
  let log = '';
  for (let i = 0; i < seconds * 2; i += 1) {
    const {stdout, stderr} = spawnSync('docker', ['logs', container], {encoding: 'utf8'});
    log = `${stdout}${stderr}`;
    if (pattern.test(log)) return log;
    await sleep(500);
  }
  throw new Error(`the container never said ${pattern}:\n${log.slice(-2000)}`);
}

/** Remove the check's folder, the runner's files in it too: on Linux they are uid 10001's, so a root container removes those. */
function cleanUp(work, image) {
  try {
    fs.rmSync(work, {recursive: true, force: true});
  } catch {
    spawnSync('docker', ['run', '--rm', '--user', '0', '--entrypoint', 'rm', '--volume', `${work}:/work`, image, '-r', '/work/data', '/work/refused', '/work/swept']);
    fs.rmSync(work, {recursive: true, force: true});
  }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-lab-runner-'));
  const containers = [];
  const model = scriptedModel();
  const image = process.env.RUNNER_IMAGE || 'rush-lab-runner:verify';
  try {
    if (!process.env.RUNNER_IMAGE) {
      await check(`build ${image} from ${path.relative(process.cwd(), nanoagent) || '.'}`, () => {
        docker('build', '--quiet', '--tag', image, nanoagent);
      });
    }
    let probe;
    let other;
    await check('pack cloud-probe (the template and scripts/aws/probe) and word-check', () => {
      probe = packProbe(work);
      other = pack(path.join(nanoagent, 'test/plugins/word-check'), path.join(work, 'word-check.tar.gz'));
      return `${probe.sha256.slice(0, 12)}, ${other.sha256.slice(0, 12)}`;
    });
    const modelPort = await freePort();
    await new Promise(resolve => model.listen(modelPort, '0.0.0.0', resolve));
    const token = crypto.randomBytes(24).toString('hex');
    const envFile = path.join(work, 'runner.env');
    fs.writeFileSync(envFile, `NANOAGENT_API_TOKEN=${token}\nOPENROUTER_API_KEY=not-used-by-the-scripted-model\n`, {mode: 0o600});
    const overrides = ['model.provider=sglang', `model.base_url=http://host.docker.internal:${modelPort}/v1`, 'model.model=fake'];

    await check('refuses to start with Docker\'s default seccomp profile, which forbids bubblewrap', async () => {
      // run.sh and Docker's default profile in a folder of their own: every flag the same but the profile.
      const copy = path.join(work, 'default-profile');
      fs.mkdirSync(copy);
      for (const file of ['run.sh', 'bwrap']) {
        fs.copyFileSync(path.join(runner, file), path.join(copy, file));
        fs.chmodSync(path.join(copy, file), 0o755);
      }
      const {BUBBLEWRAP} = await import('./seccomp.mjs');
      const profile = JSON.parse(fs.readFileSync(path.join(runner, 'seccomp.json'), 'utf8'));
      fs.writeFileSync(path.join(copy, 'seccomp.json'), JSON.stringify({...profile, syscalls: profile.syscalls.filter(rule => rule.comment !== BUBBLEWRAP.comment)}));
      const name = `rush-lab-runner-refused-${process.pid}`;
      containers.push(name);
      run('bash', [path.join(copy, 'run.sh'), image, envFile, dataFolder(work, 'refused'), `127.0.0.1:${await freePort()}`, ...overrides], {env: {...process.env, RUNNER_NAME: name}});
      const log = await logged(name, /the bwrap sandbox does not confine plugins on this machine/);
      return log.match(/bwrap: [^\n]*/)?.[0];
    });

    const name = `rush-lab-runner-verify-${process.pid}`;
    containers.push(name);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    await check('starts with infra/aws/runner/run.sh and answers /health', async () => {
      run('bash', [path.join(runner, 'run.sh'), image, envFile, dataFolder(work, 'data'), `127.0.0.1:${port}`, ...overrides], {env: {...process.env, RUNNER_NAME: name}});
      await healthy(url, name);
    });

    await check('runs NanoAgent as uid 10001, with no capability, no new privileges, a seccomp filter and a read-only root', () => {
      const status = docker('exec', name, 'cat', '/proc/1/status');
      const field = key => status.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1].trim();
      assert.equal(field('Uid').split(/\s+/)[0], '10001');
      for (const set of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.equal(field(set), '0000000000000000', set);
      assert.equal(field('NoNewPrivs'), '1');
      assert.equal(field('Seccomp'), '2');
      assert.throws(() => docker('exec', name, 'touch', '/app/written'), /Read-only file system/);
    });

    const ai = createNanoAgentGateway({env: {NANOAGENT_URL: url, NANOAGENT_API_TOKEN: token, NANOAGENT_TIMEOUT_MS: '600000'}});
    const stranger = createNanoAgentGateway({env: {NANOAGENT_URL: url, NANOAGENT_API_TOKEN: 'not-the-token'}});
    await check('refuses a caller without its token', async () => {
      assert.equal((await stranger.install(probe.sha256)).status, 502);
      assert.equal((await fetch(`${url}/v1/installs/${probe.sha256}`)).status, 401);
    });
    await check('installs a plugin it is sent, once, in the sandbox, from PyPI and GitHub through the egress proxy', async () => {
      assert.equal((await ai.install(probe.sha256)).status, 404);
      const installed = await ai.installPackage(probe.sha256, probe.data);
      assert.ifError(installed.error);
      assert.equal(installed.value.plugin.status, 'ready');
      assert.deepEqual(installed.value.plugin.tasks.map(task => task.id), ['probe', 'hog', 'swarm', 'forks']);
      assert.equal((await ai.install(probe.sha256)).value.plugin.id, 'cloud-probe');
      assert.ifError((await ai.installPackage(other.sha256, other.data)).error);
    });

    // Another member's run folder, with their file in it.
    const theirs = crypto.randomBytes(16).toString('hex');
    const mine = crypto.randomBytes(16).toString('hex');
    await check('keeps a run\'s folder: a file saved, listed, read, and not replaced by a create', async () => {
      assert.ifError((await ai.saveWorkspaceFile(theirs, 'secret.txt', Buffer.from('theirs'), {create: true})).error);
      assert.ifError((await ai.saveWorkspaceFile(mine, 'notes/in.txt', Buffer.from('hello'), {create: true})).error);
      assert.equal((await ai.saveWorkspaceFile(mine, 'notes/in.txt', Buffer.from('again'), {create: true})).status, 409);
      assert.deepEqual((await ai.workspaceFiles(mine)).value.files.map(file => file.path), ['notes/in.txt']);
      assert.equal((await ai.workspaceFile(mine, 'notes/in.txt')).value.toString(), 'hello');
    });

    const task = async input => {
      const events = [];
      const result = await ai.stream({install: probe.sha256, workspace: mine, input, onEvent: event => events.push(event)});
      assert.ifError(result.error);
      const [call] = events.filter(event => event.type === 'tool.completed' || event.type === 'tool.failed');
      assert.ok(call, `${input}: no tool call`);
      return {failed: call.type === 'tool.failed', output: call.call.output};
    };
    const verdict = output => JSON.parse(output).verdict;

    await check('confines a plugin: its verifier finds every check of the sandbox held', async () => {
      const {failed, output} = await task('probe');
      assert.equal(failed, false, output);
      const found = verdict(output);
      assert.equal(found.valid, true, `${found.message}: ${JSON.stringify(found.details)}`);
      const held = Object.keys(found.details.held);
      // The two its bwrap (infra/aws/runner/bwrap) adds to NanoAgent's sandbox, and NanoAgent's own.
      for (const name of ['no user namespace of its own', 'the first stopped when memory runs out', 'no other run\'s folder']) {
        assert.ok(held.includes(name), `${name} was not checked: ${held.join(', ')}`);
      }
      assert.deepEqual((await ai.workspaceFiles(mine)).value.files.map(file => file.path).sort(), ['notes/in.txt', 'probe.txt']);
      return held.join('; ');
    });
    await check('confines two runs at once', async () => {
      const verdicts = await Promise.all([task('probe'), task('probe')]);
      assert.deepEqual(verdicts.map(({output}) => verdict(output).valid), [true, true]);
    });
    await check('stops a plugin starting more processes than the runner allows, and goes on', async () => {
      const {output} = await task('forks 4000');
      const found = verdict(output);
      assert.equal(found.valid, true, found.message);
      assert.equal(await health(url), 200);
      return found.message;
    });
    await check('ends a plugin\'s processes with its run, though it left them holding the process limit, answering meanwhile', async () => {
      // The container's tasks, from its cgroup: no process can start in it to look while the plugin holds them.
      const tasks = () => Number(docker('stats', '--no-stream', '--format', '{{.PIDs}}', name).trim());
      const run = ai.stream({install: probe.sha256, workspace: mine, input: 'forks 4000 15', onEvent: () => {}});
      let most = 0;
      for (const until = Date.now() + 12_000; Date.now() < until;) {
        most = Math.max(most, tasks());
        assert.equal(await health(url), 200, 'NanoAgent did not answer while the plugin held the process limit');
      }
      assert.ok(most > 900, `the container held only ${most} tasks`);
      const ended = await run;
      const sleeping = () => Number(docker('exec', name, 'python', '-c',
        "import os; print(sum(open(f'/proc/{p}/comm').read() == 'sleep\\n' for p in os.listdir('/proc') if p.isdigit()))").trim());
      let left = null;
      for (let i = 0; i < 40 && left !== 0; i += 1) {
        try {
          left = sleeping();
        } catch {
          // No process can start in the container yet.
        }
        if (left !== 0) await sleep(500);
      }
      assert.equal(left, 0, `${left} of its processes outlived the run`);
      assert.equal(verdict((await task('probe')).output).valid, true);
      return `the container at ${most} tasks for 15 s, none of its processes left once the run ended${ended.error ? ` (the run: ${ended.error})` : ''}`;
    });
    await check('stops a plugin holding more memory than the runner allows, and goes on', async () => {
      const {failed, output} = await task('hog 8000');
      assert.equal(failed, true, `the hog was not stopped: ${output}`);
      assert.equal(await health(url), 200);
      assert.equal(verdict((await task('probe')).output).valid, true);
      return output;
    });
    await check('stops a plugin\'s processes, never NanoAgent, when ones each smaller than NanoAgent fill the memory', async () => {
      const rss = Number(docker('exec', name, 'sed', '-n', 's/^VmRSS:[^0-9]*\\([0-9]*\\) kB$/\\1/p', '/proc/1/status').trim()) / 1024;
      const limit = Number(docker('inspect', '--format', '{{.HostConfig.Memory}}', name).trim()) / 1024 / 1024;
      // Each process a Python and its megabytes, together under NanoAgent's size; twice the memory in all.
      const megabytes = Math.max(16, Math.floor(rss / 2) - 12);
      const count = Math.ceil((2 * limit) / (megabytes + 12));
      const restarts = () => Number(docker('inspect', '--format', '{{.RestartCount}}', name).trim());
      const before = restarts();
      const events = [];
      await ai.stream({install: probe.sha256, workspace: mine, input: `swarm ${count} ${megabytes}`, onEvent: event => events.push(event)});
      assert.equal(restarts(), before, 'NanoAgent was stopped, and its container started again');
      assert.equal(await health(url), 200);
      assert.equal(verdict((await task('probe')).output).valid, true);
      const [call] = events.filter(event => event.type === 'tool.completed' || event.type === 'tool.failed');
      const outcome = call?.type === 'tool.completed' ? verdict(call.call.output).message : 'the kernel stopped the plugin itself';
      return `${count} processes of ${megabytes} MB in ${Math.round(limit)} MB, NanoAgent ${Math.round(rss)} MB: ${outcome}`;
    });
    await check('serves a plugin page file with NanoAgent\'s no-network policy', async () => {
      const plugin = (await ai.install(probe.sha256)).value.plugin;
      const file = await ai.installUiFile(probe.sha256, plugin.uiVersion, 'renderers.js');
      assert.ifError(file.error);
      assert.match(file.headers.get('content-security-policy'), /connect-src 'none'/);
      assert.match(file.headers.get('cache-control'), /immutable/);
    });
    await check('sweeps away run folders a day after their run last touched them, and nothing else (infra/aws/runner/sweep.sh)', async () => {
      const folders = path.join(dataFolder(work, 'swept'), 'nanoagent-workspaces');
      fs.mkdirSync(path.join(folders, 'abandoned'), {recursive: true});
      fs.writeFileSync(path.join(folders, 'abandoned', 'notes.md'), 'what a run left');
      fs.mkdirSync(path.join(folders, 'running'));
      fs.writeFileSync(path.join(folders, 'stray.txt'), 'not a run folder');
      for (const folder of [folders, path.join(folders, 'abandoned'), path.join(folders, 'running')]) fs.chmodSync(folder, 0o777);
      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(path.join(folders, 'abandoned'), dayAgo, dayAgo);
      fs.utimesSync(path.join(folders, 'stray.txt'), dayAgo, dayAgo);
      const sweeper = `rush-lab-sweep-verify-${process.pid}`;
      containers.push(sweeper);
      run('bash', [path.join(runner, 'sweep.sh'), image, path.dirname(folders)], {env: {...process.env, SWEEP_NAME: sweeper}});
      await logged(sweeper, /removed the run folder abandoned/);
      assert.deepEqual(fs.readdirSync(folders).sort(), ['running', 'stray.txt']);
      const config = JSON.parse(docker('inspect', '--format', '{{json .HostConfig}}', sweeper));
      assert.deepEqual({readOnly: config.ReadonlyRootfs, network: config.NetworkMode, capDrop: config.CapDrop}, {readOnly: true, network: 'none', capDrop: ['ALL']});
      assert.equal(JSON.parse(docker('inspect', '--format', '{{json .Config.User}}', sweeper)), '10001:10001');
    });
    await check('removes a run\'s folder, which it then lists as empty', async () => {
      assert.equal((await ai.deleteWorkspace(mine)).value.deleted, true);
      assert.deepEqual((await ai.workspaceFiles(mine)).value, {files: [], folders: [], truncated: false});
      assert.deepEqual((await ai.workspaceFiles(theirs)).value.files.map(file => file.path), ['secret.txt']);
    });
    console.log('the runner confines and bounds every plugin');
  } finally {
    for (const container of containers) {
      try {
        docker('rm', '--force', container);
      } catch {
        // Never started.
      }
    }
    model.close();
    cleanUp(work, image);
  }
}

main().catch(error => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
