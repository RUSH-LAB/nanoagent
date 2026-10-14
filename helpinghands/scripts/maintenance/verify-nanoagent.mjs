#!/usr/bin/env node

/**
 * Live contract check: every call Mochi's NanoAgent client makes, against a
 * running NanoAgent web host and a fake OpenAI API.
 *
 * NanoAgent is started from its own contract configuration
 * (nanoagent/deploy/contract/nanoagent.yaml), so this check holds for any pair
 * of checkouts: by default the adjacent one, or the one NANOAGENT_PROJECT_DIR
 * names. CI runs it across versions, this Mochi against production's NanoAgent
 * and production's Mochi against this NanoAgent. No provider credential is used.
 */

import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nanoagentProject = path.resolve(process.env.NANOAGENT_PROJECT_DIR || path.join(root, '..', 'nanoagent'));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function unusedPort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child, stderr) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`NanoAgent exited (${child.exitCode}): ${stderr()}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok && (await response.json()).service === 'nanoagent') return;
    } catch {
      // The process is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`NanoAgent did not become healthy: ${stderr()}`);
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise(resolve => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
  });
}

if (!fs.existsSync(path.join(nanoagentProject, 'pyproject.toml'))) {
  throw new Error(`NanoAgent checkout not found at ${nanoagentProject}`);
}

let modelRequest = null;
const fakeModel = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    modelRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const base = {id: 'chatcmpl-mochi-test', object: 'chat.completion.chunk', created: 0, model: 'fake'};
    send({...base, choices: [{index: 0, delta: {role: 'assistant', content: 'hello from '}, finish_reason: null}]});
    send({...base, choices: [{index: 0, delta: {content: 'nanoagent'}, finish_reason: null}]});
    send({...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
    send({...base, choices: [], usage: {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      prompt_tokens_details: {cached_tokens: 4},
    }});
    res.end('data: [DONE]\n\n');
  });
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-nanoagent-'));
let nanoagent = null;
try {
  const modelPort = await listen(fakeModel);
  const agentPort = await unusedPort();

  let stderr = '';
  nanoagent = spawn('uv', [
    'run', '--project', nanoagentProject, '--extra', 'web',
    'python', '-m', 'nanoagent', 'web',
    'web_cfg=deploy/contract/nanoagent.yaml',
    `model.base_url=http://127.0.0.1:${modelPort}/v1`,
    `port=${agentPort}`,
    `workspaces=${path.join(temporary, 'workspaces')}`,
  ], {cwd: nanoagentProject, stdio: ['ignore', 'ignore', 'pipe']});
  nanoagent.stderr.setEncoding('utf8');
  nanoagent.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });

  const url = `http://127.0.0.1:${agentPort}`;
  await waitForHealth(url, nanoagent, () => stderr);
  const gateway = createNanoAgentGateway({env: {NANOAGENT_URL: url}});

  const PLUGIN = 'meal-suggestion';
  const pluginRoot = path.join(nanoagentProject, 'plugins', PLUGIN);
  const workspace = `contract-${crypto.randomUUID()}`;
  const ok = result => {
    assert.equal(result.error, undefined, `NanoAgent answered ${result.status}: ${result.error}`);
    return result.value;
  };
  let offered = null;
  let installed = null;

  // One check per method of the client, in order; a method without one fails the run.
  const checks = {
    describe() {
      assert.equal(gateway.describe().available, true);
    },
    async profiles() {
      assert.equal((await gateway.profiles()).defaultProfile, 'nanoagent-fake');
    },
    async stream() {
      const deltas = [];
      const result = await gateway.stream({
        input: 'Say where this answer came from.',
        messages: [{role: 'user', content: 'This is a prior turn.'}],
        instructions: 'Answer briefly.',
        onDelta: text => deltas.push(text),
      });
      assert.equal(result.text, 'hello from nanoagent');
      assert.equal(result.profile, 'nanoagent-fake');
      assert.equal(result.harness, 'nanoagent');
      assert.equal(result.model, 'fake');
      assert.deepEqual(deltas, ['hello from ', 'nanoagent']);
      assert.equal(result.stopReason, 'answer');
      assert.equal(result.usage.total_tokens, 10);
      assert.equal(result.usage.cached_tokens, 4);
      assert.equal(result.metrics.steps.length, 1);
      assert.equal(result.metrics.steps[0].usage.cached_tokens, 4);
      assert.ok(result.metrics.steps[0].model_calls[0].ttft_s >= 0);
      assert.ok(result.metrics.steps[0].model_calls[0].generation_s >= 0);
      assert.ok(result.metrics.duration_s >= result.metrics.model_s);
      assert.equal(modelRequest.stream, true);
      assert.match(modelRequest.messages[0].content, /deterministic integration verifier/);
      assert.match(modelRequest.messages[0].content, /Application instructions:\nAnswer briefly\./);
      assert.deepEqual(modelRequest.messages.slice(1), [
        {role: 'user', content: 'This is a prior turn.'},
        {role: 'user', content: 'Say where this answer came from.'},
      ]);
    },
    local() {
      // A gateway to NANOAGENT_URL is not a member's own computer's.
      assert.equal(gateway.local, false);
    },
    async models() {
      // A NanoAgent that lets runs choose their model is a member's own (run_models); this is not.
      assert.equal((await gateway.models()).status, 404);
    },
    async complete() {
      assert.equal((await gateway.complete({input: 'Again.'})).text, 'hello from nanoagent');
    },
    async packages() {
      const entry = ok(await gateway.packages()).packages.find(item => item.id === PLUGIN);
      assert.ok(entry, `${PLUGIN} is not offered as a package`);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      offered = entry;
    },
    async packageFile() {
      const data = ok(await gateway.packageFile(PLUGIN));
      assert.equal(crypto.createHash('sha256').update(data).digest('hex'), offered.sha256);
    },
    async packageSource() {
      // A source archive as GitHub sends one: a tree under one top folder, here NanoAgent's
      // tracked files as they are now (`git stash create` commits them without touching anything).
      const git = args => execFileSync('git', args, {cwd: nanoagentProject, maxBuffer: 64 * 1024 * 1024});
      const tree = git(['stash', 'create']).toString('utf8').trim() || 'HEAD';
      const archive = git(['archive', '--format=tar.gz', '--prefix=nanoagent-contract/', tree, `plugins/${PLUGIN}`]);
      const packed = ok(await gateway.packageSource(archive, `plugins/${PLUGIN}`));
      assert.equal(packed.package.id, PLUGIN);
      assert.ok(Buffer.from(packed.data, 'base64').length > 0);
    },
    async install() {
      // A fresh NanoAgent has installed nothing.
      assert.equal((await gateway.install(offered.sha256)).status, 404);
    },
    async installPackage() {
      const plugin = ok(await gateway.installPackage(offered.sha256, ok(await gateway.packageFile(PLUGIN)))).plugin;
      assert.equal(plugin.id, PLUGIN);
      assert.match(plugin.readme, /\S/);
      assert.ok(plugin.tasks.every(task => task.inputSchema));
      assert.deepEqual(ok(await gateway.install(offered.sha256)).plugin, plugin);
      installed = plugin;
    },
    async installUiFile() {
      // The page is NanoAgent's own (plugin/page/); the plugin's ui/ holds the rest.
      const page = ok(await gateway.installUiFile(offered.sha256, installed.uiVersion, 'index.html'));
      assert.deepEqual(page, fs.readFileSync(path.join(nanoagentProject, 'src', 'nanoagent', 'plugin', 'page', 'index.html')));
      const script = ok(await gateway.installUiFile(offered.sha256, installed.uiVersion, 'app.js'));
      assert.deepEqual(script, fs.readFileSync(path.join(pluginRoot, 'ui', 'app.js')));
    },
    async saveWorkspaceFile() {
      ok(await gateway.saveWorkspaceFile(workspace, 'notes/a.md', Buffer.from('# A'), {create: true}));
      assert.equal((await gateway.saveWorkspaceFile(workspace, 'notes/a.md', Buffer.from('x'), {create: true})).status, 409);
    },
    async workspaceFiles() {
      const listing = ok(await gateway.workspaceFiles(workspace));
      assert.deepEqual(listing.files.map(file => file.path), ['notes/a.md']);
      assert.deepEqual(listing.folders, ['notes']);
    },
    async workspaceFile() {
      assert.equal(ok(await gateway.workspaceFile(workspace, 'notes/a.md')).toString('utf8'), '# A');
    },
    async deleteWorkspace() {
      assert.deepEqual(ok(await gateway.deleteWorkspace(workspace)), {deleted: true});
      assert.deepEqual(ok(await gateway.workspaceFiles(workspace)).files, []);
    },
  };

  assert.deepEqual(
    Object.keys(gateway).sort(), Object.keys(checks).sort(),
    'every method of the NanoAgent client needs a check here, and every check a method',
  );
  for (const [name, check] of Object.entries(checks)) {
    await check();
    console.log(`ok ${name}`);
  }
  console.log(`NanoAgent contract verified against ${nanoagentProject}: all ${Object.keys(checks).length} client calls.`);
} finally {
  await stop(nanoagent);
  await new Promise(resolve => fakeModel.close(resolve));
  fs.rmSync(temporary, {recursive: true, force: true});
}
