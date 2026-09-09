#!/usr/bin/env node

/**
 * Live contract check: Mochi adapter -> NanoAgent web host -> fake OpenAI API.
 *
 * No provider credential is used. By default this verifies the bundled
 * NanoAgent service; set NANOAGENT_PROJECT_DIR to verify another checkout.
 */

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
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
const nanoagentProject = path.resolve(process.env.NANOAGENT_PROJECT_DIR || path.join(root, 'services/nanoagent'));

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  const configPath = path.join(temporary, 'web.yaml');
  fs.writeFileSync(configPath, `default_profile: native-fake
profiles:
  native-fake:
    label: Fake model · NanoAgent
    model: fake
    harness:
      type: native
      command: null
      cwd: null
      options: {}
    model_overrides: {}
model:
  model: fake
  backend: sglang
  base_url: http://127.0.0.1:${modelPort}/v1
  api_key: null
  temperature: 0.0
  max_tokens: 64
  request_timeout: 5.0
  max_retries: 0
  extra_body: {}
  input_price: 0.0
  output_price: 0.0
agent:
  system_prompt: You are Mochi's deterministic integration verifier.
  max_steps: 2
  cost_limit: null
  token_limit: 1000
  context_window: null
  hooks: []
  skills: null
  context_files: []
  events: null
tools: []
tools_dir: null
allowed_tools: []
host: 127.0.0.1
port: ${agentPort}
api_token: null
max_concurrency: 2
request_timeout: 10.0
max_request_bytes: 16384
max_output_chars: 1000
heartbeat_seconds: 1.0
include_reasoning: false
`, 'utf8');

  let stderr = '';
  nanoagent = spawn('uv', [
    'run', '--project', nanoagentProject, '--extra', 'web',
    'python', '-m', 'nanoagent', 'web', `web_cfg=${configPath}`,
  ], {cwd: nanoagentProject, stdio: ['ignore', 'ignore', 'pipe']});
  nanoagent.stderr.setEncoding('utf8');
  nanoagent.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });

  const url = `http://127.0.0.1:${agentPort}`;
  await waitForHealth(url, nanoagent, () => stderr);
  const deltas = [];
  const gateway = createNanoAgentGateway({env: {NANOAGENT_URL: url}});
  const profiles = await gateway.profiles();
  assert.equal(profiles.defaultProfile, 'native-fake');
  const result = await gateway.stream({
    input: 'Say where this answer came from.',
    messages: [{role: 'user', content: 'This is a prior turn.'}],
    instructions: 'Answer briefly.',
    onDelta: text => deltas.push(text),
  });

  assert.equal(result.text, 'hello from nanoagent');
  assert.equal(result.profile, 'native-fake');
  assert.equal(result.harness, 'native');
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
  console.log('NanoAgent integration verified: streamed text, token/cache usage, timing profile, history, instructions, and completion.');
} finally {
  await stop(nanoagent);
  await new Promise(resolve => fakeModel.close(resolve));
  fs.rmSync(temporary, {recursive: true, force: true});
}
