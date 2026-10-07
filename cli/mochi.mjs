#!/usr/bin/env node
/**
 * Mochi Lab's command-line client: mirror a workspace's files into a local
 * folder and keep the two in sync, the way Dropbox keeps a folder in sync.
 *
 *   mochi login <server>                    sign in and keep a session token
 *   mochi clone <server> <workspace> <dir>  download a workspace into a new folder
 *   mochi sync <dir>                        keep that folder in sync until stopped
 *
 * The server stays the source of truth and every write goes through the
 * workspace file system API (/fs), with the same permissions and revision
 * checks as the Workspace page; the server must run with CONTENT_STORE=fs. A synced folder holds
 * its settings in .mochi/config.yaml and the last synced state in
 * .mochi/state.json.
 */
import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import yaml from 'js-yaml';
import {STATE_DIR, abortsCycle, syncOnce} from './sync.mjs';

const CREDENTIALS = path.join(os.homedir(), '.config', 'mochi', 'credentials.json');
const POLL_MS = 30_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function serverUrl(value) {
  if (!value) fail('Name the server, for example https://mochi-lab.org');
  const url = new URL(value);
  return url.origin;
}

async function writeJson(file, value, mode) {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {mode});
  await fs.rename(temp, file);
}

async function readCredentials() {
  try {
    return JSON.parse(await fs.readFile(CREDENTIALS, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function tokenFor(server) {
  const token = (await readCredentials())[server]?.token;
  if (!token) fail(`Not signed in to ${server}. Run: mochi login ${server}`);
  return token;
}

/** A client for one server. Errors carry the HTTP status, or 0 when the server is unreachable. */
function connect(server, token) {
  return async function request(method, route, {body, headers = {}, raw = false} = {}) {
    let response;
    try {
      response = await fetch(`${server}${route}`, {
        method,
        headers: {
          // Node's fetch sends Fetch Metadata headers, which make Better Auth
          // require an origin. The server's own origin is a trusted one.
          Origin: server,
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
          ...(body === undefined ? {} : {'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json'}),
          ...headers,
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
    } catch (error) {
      throw Object.assign(new Error(`Cannot reach ${server}: ${error.cause?.message ?? error.message}`), {status: 0});
    }
    if (response.status === 304) return {response, data: null};
    if (raw && response.ok) return {response, data: Buffer.from(await response.arrayBuffer())};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(data.error || data.message || `${method} ${route} failed with ${response.status}`),
        {status: response.status});
    }
    return {response, data};
  };
}

/** The file system API `syncOnce` expects, over one workspace's /fs endpoints. */
function filesApi(request, workspaceId) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/fs`;
  const query = filePath => `path=${encodeURIComponent(filePath)}`;
  let etag = null;
  let files = null;
  return {
    async list() {
      const {response, data} = await request('GET', `${base}/tree`, {headers: etag ? {'If-None-Match': etag} : {}});
      if (data) {
        etag = response.headers.get('etag');
        files = data.nodes.filter(node => node.kind === 'file').map(node => ({path: node.path, id: node.id, rev: node.rev}));
      }
      return files;
    },
    async get(filePath) {
      const {response, data} = await request('GET', `${base}/file?${query(filePath)}`, {raw: true});
      return {body: data, id: response.headers.get('x-node-id'), rev: Number(response.headers.get('x-rev'))};
    },
    async put(filePath, body, baseRev) {
      return (await request('PUT', `${base}/file?${query(filePath)}&baseRev=${baseRev}`, {body})).data.node;
    },
    async remove(filePath, baseRev) {
      await request('DELETE', `${base}/node?${query(filePath)}&baseRev=${baseRev}`);
    },
    async move(from, to, baseRev) {
      return (await request('POST', `${base}/move`, {body: {from, to, baseRev}})).data.node;
    },
  };
}

async function ask(question, {hidden = false} = {}) {
  const prompt = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
  if (hidden) {
    // Echo the question but not the keystrokes that answer it.
    prompt._writeToOutput = text => { if (text.includes(question)) process.stdout.write(question); };
  }
  try {
    return (await prompt.question(question)).trim();
  } finally {
    if (hidden) process.stdout.write('\n');
    prompt.close();
  }
}

async function login(server) {
  const email = await ask('Email: ');
  const password = await ask('Password: ', {hidden: true});
  const {response, data} = await connect(server)('POST', '/api/auth/sign-in/email', {body: {email, password}});
  const token = response.headers.get('set-auth-token');
  if (!token) fail(`${server} did not return a session token`);
  const credentials = await readCredentials();
  credentials[server] = {email: data.user?.email ?? email, token};
  await fs.mkdir(path.dirname(CREDENTIALS), {recursive: true, mode: 0o700});
  await writeJson(CREDENTIALS, credentials, 0o600);
  console.log(`Signed in to ${server} as ${credentials[server].email}`);
}

async function openFolder(folder) {
  const root = path.resolve(folder);
  const configFile = path.join(root, STATE_DIR, 'config.yaml');
  let config;
  try {
    config = yaml.load(await fs.readFile(configFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${root} is not a synced folder: ${configFile} is missing`);
    throw error;
  }
  const statePath = path.join(root, STATE_DIR, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const api = filesApi(connect(config.server, await tokenFor(config.server)), config.workspace.id);
  const rejected = new Map();
  return {
    root,
    config,
    // Repeat while a cycle did work: a conflict leaves a copy for the next one to upload.
    async sync() {
      while (await syncOnce({
        root, api, state, rejected,
        saveState: value => writeJson(statePath, value),
        host: os.hostname().split('.')[0],
        day: new Date().toISOString().slice(0, 10),
        log: message => console.log(`${new Date().toLocaleTimeString()} ${message}`),
      }));
    },
  };
}

async function clone(server, workspace, folder) {
  if (!workspace || !folder) fail('Usage: mochi clone <server> <workspace> <folder>');
  const request = connect(server, await tokenFor(server));
  const {workspaces} = (await request('GET', '/api/workspaces')).data;
  const found = workspaces.find(candidate => candidate.slug === workspace || candidate.id === workspace);
  if (!found) fail(`No workspace "${workspace}". Yours: ${workspaces.map(candidate => candidate.slug).join(', ')}`);
  const root = path.resolve(folder);
  const existing = await fs.readdir(root).catch(error => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
  if (existing.length) fail(`${root} is not empty; clone into a new folder`);
  await fs.mkdir(path.join(root, STATE_DIR), {recursive: true});
  await fs.writeFile(path.join(root, STATE_DIR, 'config.yaml'), yaml.dump({
    server,
    workspace: {id: found.id, slug: found.slug, name: found.name},
  }));
  await writeJson(path.join(root, STATE_DIR, 'state.json'), {files: {}});
  await (await openFolder(root)).sync();
  console.log(`Cloned ${found.name} into ${root}. Keep it in sync with: mochi sync ${folder}`);
}

async function sync(folder) {
  if (!folder) fail('Usage: mochi sync <folder>');
  const synced = await openFolder(folder);
  let running = false;
  let pending = false;
  let pausedUntil = 0;
  const cycle = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        if (Date.now() < pausedUntil) break;
        try {
          await synced.sync();
        } catch (error) {
          if (!abortsCycle(error)) fail(`Sync stopped: ${error.message}`);
          if (error.status === 401) fail(`Your session for ${synced.config.server} ended. Run: mochi login ${synced.config.server}`);
          if (error.status === 429) pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
          console.error(`${new Date().toLocaleTimeString()} sync paused: ${error.message}`);
        }
      } while (pending);
    } finally {
      running = false;
    }
  };

  let debounce;
  watch(synced.root, {recursive: true}, (event, filename) => {
    if (!filename || filename.split(path.sep).some(part => part.startsWith('.'))) return;
    clearTimeout(debounce);
    debounce = setTimeout(cycle, 500);
  });
  setInterval(cycle, POLL_MS);
  console.log(`Syncing ${synced.root} with ${synced.config.workspace.name} on ${synced.config.server}. Press Ctrl+C to stop.`);
  await cycle();
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  login: () => login(serverUrl(args[0])),
  clone: () => clone(serverUrl(args[0]), args[1], args[2]),
  sync: () => sync(args[0]),
};
if (!commands[command]) fail('Usage: mochi login <server> | mochi clone <server> <workspace> <folder> | mochi sync <folder>');
await commands[command]();
