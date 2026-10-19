#!/usr/bin/env node
/**
 * node scripts/check-install.mjs <target> [--app <file>] [--engine <folder>]: RUSH Lab, as built for
 * <target> (npm run build:release), or the app <file> (rush-lab.org's, for a release that changes
 * only the engine), installed and run as a member does, on this computer, which CI runs on each
 * target's own runner. With --engine, the second install runs the engine in <folder>
 * (scripts/engine.mjs) in place of the app's own, installed as the app installs one its site serves
 * (src-tauri/src/engine.rs, lab.rs).
 * It serves the build as the site serves it, from a site of its own on 127.0.0.1, and twice runs
 * the command the site gives (curl -fsSL <site>/install.sh | sh on macOS, irm <site>/install.ps1 | iex
 * on Windows), the second replacing the RUSH Lab the first opened, as an update does. Each time it
 * waits for the app to set up Python, connects a member to its site (lab.mjs's addConnection, once
 * lab.mjs has removed connections to sites other than the app's own) and asks their NanoAgent for
 * its profiles through the relay, as RUSH does. Then it quits RUSH Lab and fails if anything it
 * started is still running. When a step fails, it prints the app's logs.
 */
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {addConnection} from '../../src/runner/lab.mjs';

const require = createRequire(import.meta.url);
const {macScript, windowsScript} = require('../../src/server/lab-install.js');
const {releaseApp} = require('../../src/server/lab-app.js');
const {PATH} = require('../../src/runner/protocol.js');

// The first start downloads Python and NanoAgent's dependencies.
const SETUP_TIMEOUT_MS = 15 * 60_000;
const QUIT_TIMEOUT_MS = 90_000;
const POLL_MS = 500;
const MEMBER = {id: 'check', login: 'check'};
const TOKEN = crypto.randomBytes(16).toString('hex');

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target, ...flags] = process.argv.slice(2);
const flag = name => (flags.includes(name) ? path.resolve(flags[flags.indexOf(name) + 1]) : null);
const windows = process.platform === 'win32';
const {productName, label} = releaseApp();
const bundleFolder = path.join(desktop, 'src-tauri', 'target', target ?? '', 'release', 'bundle', windows ? 'nsis' : 'dmg');
// What the install puts here: the app, and the data folder it runs everything from (src-tauri/src/lab.rs).
const appFolder = windows ? path.join(process.env.LOCALAPPDATA, productName) : `/Applications/${productName}.app`;
const data = windows ? path.join(process.env.LOCALAPPDATA, label) : path.join(os.homedir(), 'Library', 'Application Support', label);

// Windows PowerShell, which a member runs the command in, with its own modules: this process's
// PSModulePath, when CI's PowerShell 7 started it, names PowerShell 7's, which it cannot load.
const powershell = {program: 'powershell.exe', env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = message => console.log(`${new Date().toISOString()} ${message}`);

/** Wait for `ready` to return something, failing with `what` after `timeoutMs`. */
async function waitFor(what, timeoutMs, ready) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ready();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs / 1000}s`);
    await sleep(POLL_MS);
  }
}

/**
 * The site: the install scripts, the build at /api/lab/bundles/<target>, and as RUSH the member's
 * session, their workspaces (none) and the relay's socket, which hands each socket that says hello
 * to `onRelay`.
 */
async function serve(bundle, onRelay) {
  const body = fs.readFileSync(bundle);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const signedIn = request => request.headers.authorization === `Bearer ${TOKEN}`;
  let site;
  const server = http.createServer((request, response) => {
    const json = value => response.setHeader('Content-Type', 'application/json').end(JSON.stringify(value));
    if (request.url === '/install.sh') return response.end(macScript(site));
    if (request.url === '/install.ps1') return response.end(windowsScript(site));
    if (request.url === `/api/lab/bundles/${target}`) return response.setHeader('X-Lab-Sha256', sha256).end(body);
    if (request.url === '/api/auth/get-session' && signedIn(request)) return json({user: {id: MEMBER.id, githubLogin: MEMBER.login}});
    if (request.url === '/api/workspaces' && signedIn(request)) return json({workspaces: []});
    response.statusCode = 404;
    response.end();
  });
  const sockets = new WebSocketServer({noServer: true});
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== PATH || !signedIn(request)) return socket.destroy();
    sockets.handleUpgrade(request, socket, head, relay => {
      relay.once('message', message => {
        if (JSON.parse(String(message)).type === 'hello') onRelay(relay);
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${server.address().port}`;
  return {site, close: () => { sockets.close(); server.close(); }};
}

/** `GET route` of the member's NanoAgent through `relay`, as RUSH asks it: {status, body}. */
function ask(relay, route) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let status;
    const chunks = [];
    relay.on('message', message => {
      const frame = JSON.parse(String(message));
      if (frame.id !== id) return;
      if (frame.type === 'head') status = frame.status;
      else if (frame.type === 'chunk') chunks.push(Buffer.from(frame.data, 'base64'));
      else if (frame.type === 'end') resolve({status, body: Buffer.concat(chunks).toString('utf8')});
      else if (frame.type === 'error') reject(new Error(`the relay answered ${route}: ${frame.message}`));
    });
    relay.send(JSON.stringify({type: 'request', id, method: 'GET', path: route, headers: {}}));
  });
}

/** The command the site gives, run as a member runs it, while this process goes on serving the site it downloads from. */
async function install(site) {
  const [program, args] = windows
    ? [powershell.program, ['-NoProfile', '-Command', `irm ${site}/install.ps1 | iex`]]
    : ['/bin/sh', ['-c', `curl -fsSL ${site}/install.sh | sh`]];
  const [code, signal] = await new Promise((resolve, reject) => {
    spawn(program, args, {stdio: 'inherit', ...(windows && {env: powershell.env})}).on('error', reject).on('exit', (...exit) => resolve(exit));
  });
  if (code !== 0) throw new Error(`the install command exited with ${code ?? signal}`);
}

/**
 * Install the engine in `folder` beside the app's own, as the app installs one its site serves:
 * unpacked into the data folder's app/<stamp>/mochi-lab/, with the shell's config.json, git and
 * runtimes beside it, so the app runs it, the newest for its shell, at its next start.
 */
function placeEngine(folder) {
  const stamp = fs.readFileSync(path.join(folder, 'stamp'), 'utf8').trim();
  const resources = windows ? appFolder : path.join(appFolder, 'Contents', 'Resources');
  const bin = windows ? appFolder : path.join(appFolder, 'Contents', 'MacOS');
  const shell = fs.readFileSync(path.join(resources, 'shell'), 'utf8').trim();
  const engineShell = fs.readFileSync(path.join(folder, 'shell'), 'utf8').trim();
  if (engineShell !== shell) throw new Error(`the engine is for shell ${engineShell}, and the app is ${shell}`);
  const root = path.join(data, 'app', stamp, 'mochi-lab');
  fs.mkdirSync(root, {recursive: true});
  const tar = windows ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', path.join(folder, 'engine.tar.gz'), '-C', root]);
  fs.cpSync(path.join(resources, 'git'), path.join(root, 'git'), {recursive: true, verbatimSymlinks: true});
  fs.copyFileSync(path.join(resources, 'config.json'), path.join(root, 'config.json'));
  fs.mkdirSync(path.join(root, 'bin'));
  for (const name of windows ? ['node.exe', 'uv.exe'] : ['node', 'uv']) fs.copyFileSync(path.join(bin, name), path.join(root, 'bin', name));
  return stamp;
}

/** Whether lab.mjs said, at its last start, that it runs the engine `stamp`. */
function runs(stamp) {
  const lines = fs.readFileSync(path.join(data, 'logs', 'lab.log'), 'utf8').split('\n').filter(line => / \S+ \d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-f]+$/.test(line));
  return lines.at(-1)?.endsWith(` ${stamp}`) ?? false;
}

/** What lab.mjs says it is setting up (src/runner/lab.mjs's setup.json), or null. */
function setup() {
  try {
    return JSON.parse(fs.readFileSync(path.join(data, 'setup.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Every process running from the app or its data folder: `pid path` lines. */
function running() {
  const lines = windows
    ? execFileSync(powershell.program, ['-NoProfile', '-Command', 'Get-Process | Where-Object Path | ForEach-Object { "$($_.Id) $($_.Path)" }'], {encoding: 'utf8', env: powershell.env})
    : execFileSync('/bin/ps', ['-axo', 'pid=,command='], {encoding: 'utf8'});
  const inside = folder => line => line.toLowerCase().includes(`${folder}${path.sep}`.toLowerCase());
  return lines.split(/\r?\n/).map(line => line.trim()).filter(line => [appFolder, data].some(folder => inside(folder)(line)));
}

/** Quit RUSH Lab as a member does: from its menu on macOS, and on Windows as install.ps1 does, with every process it started. */
function quit() {
  if (windows) {
    for (const line of running().filter(line => line.toLowerCase().includes(`${appFolder}${path.sep}`.toLowerCase()))) {
      spawnSync('taskkill', ['/PID', line.split(' ')[0], '/T', '/F'], {stdio: 'ignore'});
    }
  } else {
    execFileSync('osascript', ['-e', `quit app id "${label}"`]);
  }
}

/** The end of each log the app keeps. */
function printLogs() {
  const logs = [];
  const walk = folder => {
    for (const entry of fs.existsSync(folder) ? fs.readdirSync(folder, {withFileTypes: true}) : []) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && entry.name !== 'app' && entry.name !== 'python') walk(file);
      else if (entry.isFile() && entry.name.endsWith('.log')) logs.push(file);
    }
  };
  walk(data);
  for (const file of logs) {
    console.log(`\n===== ${file} =====\n${fs.readFileSync(file, 'utf8').split('\n').slice(-80).join('\n')}`);
  }
}

async function main() {
  if (!target) throw new Error('usage: node scripts/check-install.mjs <target> [--app <file>] [--engine <folder>]');
  let app = flag('--app');
  if (!app) {
    const bundles = fs.readdirSync(bundleFolder).filter(name => name.endsWith(windows ? '-setup.exe' : '.dmg'));
    if (bundles.length !== 1) throw new Error(`expected one build in ${bundleFolder}, found ${bundles.length}`);
    app = path.join(bundleFolder, bundles[0]);
  }
  const engine = flag('--engine');
  let relay = null;
  let engineStamp = null;
  const site = await serve(app, socket => { relay = socket; });
  try {
    for (const round of [1, 2]) {
      say(`Install ${round}: ${site.site}`);
      relay = null;
      if (round === 2 && engine) {
        // The engine goes in while the app is not running, as the install puts the app back.
        quit();
        await waitFor(`${productName} did not quit`, QUIT_TIMEOUT_MS, () => running().length === 0);
        engineStamp = placeEngine(engine);
        say(`Placed the engine ${engineStamp}.`);
      }
      await install(site.site);
      // The app removes the last run's setup.json, and lab.mjs writes `python` once it has removed
      // connections to other sites, this site's from the round before among them.
      await waitFor(`${productName} did not start setting up Python`, QUIT_TIMEOUT_MS, () => setup()?.stage === 'python');
      await addConnection(data, {site_url: site.site}, site.site, {session: TOKEN, member: MEMBER});
      say('Connected the member; waiting for their NanoAgent and relay…');
      await waitFor(`the relay did not connect (setup.json: ${JSON.stringify(setup())})`, SETUP_TIMEOUT_MS, () => {
        const error = setup()?.error;
        if (error) throw new Error(`${productName} stopped setting up at ${setup().stage}: ${error}`);
        return relay;
      });
      const {status, body} = await ask(relay, '/v1/profiles');
      const catalog = status === 200 ? JSON.parse(body) : null;
      if (!catalog?.profiles?.some(profile => profile.id === catalog.defaultProfile)) {
        throw new Error(`NanoAgent answered /v1/profiles through the relay with ${status}: ${body}`);
      }
      say(`NanoAgent answered through the relay, its default profile ${catalog.defaultProfile}.`);
      if (engineStamp && !runs(engineStamp)) throw new Error(`${productName} did not run the engine ${engineStamp}`);
    }
    say(`Quitting ${productName}…`);
    quit();
    const deadline = Date.now() + QUIT_TIMEOUT_MS;
    while (running().length && Date.now() < deadline) await sleep(POLL_MS);
    const left = running();
    if (left.length) throw new Error(`still running ${QUIT_TIMEOUT_MS / 1000}s after ${productName} quit:\n${left.join('\n')}`);
    say(`${productName} quit, and nothing it started is still running.`);
  } finally {
    site.close();
  }
}

main().then(() => process.exit(0), error => {
  printLogs();
  console.error(`\n${error.message}`);
  process.exit(1);
});
