#!/usr/bin/env node
/**
 * Mochi Lab's command-line client: mirror a workspace's files into a local
 * folder and keep the two in sync, the way Dropbox keeps a folder in sync.
 *
 *   mochi login <server>                                sign in and keep a session token
 *   mochi clone <server> <workspace> <dir> [folder...]  download a workspace, or only these top-level folders, into a new folder
 *   mochi sync <dir>                                    keep that folder in sync until stopped
 *   mochi online-only <dir> <path>                      keep a folder or file in the workspace only
 *   mochi download <dir> <path>                         keep it in the local folder again
 *   mochi publish <server> <github-url>                 publish a plugin to the marketplace, or update it
 *
 * The server stays the source of truth and every write goes through the
 * workspace file system API (/fs), with the same permissions and revision
 * checks as the Workspace page. A synced folder holds its settings in .mochi/config.yaml and the last synced state in
 * .mochi/state.json.
 */
import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {STATE_DIR, abortsCycle, connect, filesApi, syncOnce} from '../src/runner/sync.mjs';

const CREDENTIALS = path.join(os.homedir(), '.config', 'mochi', 'credentials.json');
const POLL_MS = 30_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function serverUrl(value) {
  if (!value) fail('Name the server, for example https://rush-lab.org');
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

const CLIENT_ID = 'mochi-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sign in through the device-authorization grant: the server hands out a code,
 * you approve it in a browser signed in with GitHub, and the server hands this
 * client a session token.
 */
async function login(server) {
  const request = connect(server);
  const {data: code} = await request('POST', '/api/auth/device/code', {body: {client_id: CLIENT_ID}});
  console.log(`Open ${code.verification_uri_complete}`);
  console.log(`and approve the code ${code.user_code} as your GitHub account.`);
  let interval = code.interval * 1000;
  let token = null;
  while (!token) {
    await sleep(interval);
    try {
      token = (await request('POST', '/api/auth/device/token', {
        body: {grant_type: DEVICE_GRANT, device_code: code.device_code, client_id: CLIENT_ID},
      })).data.access_token;
    } catch (error) {
      // A restarting server is unreachable or answers 502-504 for a moment; the code outlives it.
      if (error.message === 'authorization_pending' || error.status === 0 || error.status >= 502) continue;
      if (error.message === 'slow_down') {
        interval += 5000;
        continue;
      }
      fail(`Sign-in to ${server} failed: ${error.message}`);
    }
  }
  const {data: session} = await connect(server, token)('GET', '/api/auth/get-session');
  const credentials = await readCredentials();
  credentials[server] = {email: session.user.email, token};
  await fs.mkdir(path.dirname(CREDENTIALS), {recursive: true, mode: 0o700});
  await writeJson(CREDENTIALS, credentials, 0o600);
  console.log(`Signed in to ${server} as ${session.user.email}`);
}

async function readConfig(root) {
  const configFile = path.join(root, STATE_DIR, 'config.yaml');
  try {
    return yaml.load(await fs.readFile(configFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${root} is not a synced folder: ${configFile} is missing`);
    throw error;
  }
}

const writeConfig = (root, config) => fs.writeFile(path.join(root, STATE_DIR, 'config.yaml'), yaml.dump(config));

async function openFolder(folder) {
  const root = path.resolve(folder);
  const config = await readConfig(root);
  const statePath = path.join(root, STATE_DIR, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const api = filesApi(connect(config.server, await tokenFor(config.server)), config.workspace.id);
  const rejected = new Map();
  return {
    root,
    config,
    // Repeat while a cycle did work: a conflict leaves a copy for the next one to upload.
    // The config is read again each time, so `online-only` and `download` apply to a running sync.
    async sync() {
      while (await syncOnce({
        root, api, state, rejected,
        onlineOnly: (await readConfig(root)).online_only ?? [],
        saveState: value => writeJson(statePath, value),
        host: os.hostname().split('.')[0],
        day: new Date().toISOString().slice(0, 10),
        log: message => console.log(`${new Date().toLocaleTimeString()} ${message}`),
      }));
    },
  };
}

async function clone(server, workspace, folder, only) {
  if (!workspace || !folder) fail('Usage: mochi clone <server> <workspace> <folder> [top-level folder...]');
  const request = connect(server, await tokenFor(server));
  const {workspaces} = (await request('GET', '/api/workspaces')).data;
  const found = workspaces.find(candidate => candidate.slug === workspace || candidate.id === workspace);
  if (!found) fail(`No workspace "${workspace}". Yours: ${workspaces.map(candidate => candidate.slug).join(', ')}`);
  const root = path.resolve(folder);
  const existing = await fs.readdir(root).catch(error => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
  if (existing.length) fail(`${root} is not empty; clone into a new folder`);
  const config = {server, workspace: {id: found.id, slug: found.slug, name: found.name}};
  if (only.length) {
    // Every other top-level folder starts online only.
    const files = await filesApi(request, found.id).list();
    const folders = new Set(files.filter(file => file.path.includes('/')).map(file => file.path.split('/')[0]));
    const missing = only.filter(name => !folders.has(name));
    if (missing.length) fail(`No top-level folder ${missing.join(', ')} in ${found.name}. Its folders: ${[...folders].sort().join(', ')}`);
    config.online_only = [...folders].filter(name => !only.includes(name)).sort();
  }
  await fs.mkdir(path.join(root, STATE_DIR), {recursive: true});
  await writeConfig(root, config);
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

/** A workspace path as `online-only` and `download` take it: relative, without dot segments. */
function workspacePath(value) {
  const cleaned = String(value ?? '').replace(/^\/+|\/+$/g, '');
  if (!cleaned || cleaned.split('/').some(part => !part || part.startsWith('.'))) fail(`Not a workspace path: ${value}`);
  return cleaned;
}

/** Mark a path online only. The next sync cycle uploads any pending edit under it, then removes the local copy. */
async function onlineOnly(folder, value) {
  if (!folder) fail('Usage: mochi online-only <folder> <path>');
  const root = path.resolve(folder);
  const target = workspacePath(value);
  const config = await readConfig(root);
  const paths = config.online_only ?? [];
  const covering = paths.find(entry => target === entry || target.startsWith(`${entry}/`));
  if (covering) fail(`${target} is already online only (${covering})`);
  config.online_only = [...paths.filter(entry => !entry.startsWith(`${target}/`)), target].sort();
  await writeConfig(root, config);
  console.log(`${target} is online only; mochi sync removes its local copy.`);
}

/** Keep a path in the local folder again. The next sync cycle downloads it. */
async function download(folder, value) {
  if (!folder) fail('Usage: mochi download <folder> <path>');
  const root = path.resolve(folder);
  const target = workspacePath(value);
  const config = await readConfig(root);
  const paths = config.online_only ?? [];
  const covering = paths.find(entry => target.startsWith(`${entry}/`));
  if (covering) fail(`${target} is inside online-only ${covering}; download ${covering} instead`);
  const kept = paths.filter(entry => entry !== target && !entry.startsWith(`${target}/`));
  if (kept.length === paths.length) fail(`${target} is not online only`);
  config.online_only = kept;
  await writeConfig(root, config);
  console.log(`${target} will be downloaded; mochi sync downloads it.`);
}

/** Publish a NanoAgent plugin from a public GitHub repository, as the marketplace page does. */
async function publish(server, url) {
  if (!url) fail('Usage: mochi publish <server> <github-url>');
  const request = connect(server, await tokenFor(server));
  const {plugin} = (await request('POST', '/api/market', {body: {url}})).data;
  console.log(`Published ${plugin.id} ${plugin.version} to ${server}/marketplace`);
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  login: () => login(serverUrl(args[0])),
  clone: () => clone(serverUrl(args[0]), args[1], args[2], args.slice(3)),
  sync: () => sync(args[0]),
  'online-only': () => onlineOnly(args[0], args[1]),
  download: () => download(args[0], args[1]),
  publish: () => publish(serverUrl(args[0]), args[1]),
};
if (!commands[command]) {
  fail('Usage: mochi login <server> | mochi clone <server> <workspace> <folder> [top-level folder...] | mochi sync <folder>'
    + ' | mochi online-only <folder> <path> | mochi download <folder> <path> | mochi publish <server> <github-url>');
}
await commands[command]();
