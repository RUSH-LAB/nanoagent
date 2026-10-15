/**
 * Mochi Lab without its window: what desktop/src-tauri/src/supervisor.rs does behind the app's
 * window, for members who use Mochi in the browser. install.sh unpacks its bundle
 * (desktop/scripts/bundle-lab.mjs) and has launchd (systemd on Linux) run it at login, restarting
 * it when it exits with an error:
 *
 *   mochi-lab/stamp          names this bundle
 *   mochi-lab/config.json    desktop/config.yaml: its own site, the install's label, the files folders, Python's version
 *   mochi-lab/bin/{node,uv}  the runtimes, first on every service's PATH
 *   mochi-lab/runner/        this file, the relay (relay.mjs) and what it loads
 *   mochi-lab/nanoagent/     NanoAgent compiled by Nuitka (site/), its uv.lock, the PI runner's bundle, its config
 *
 * One install serves every connection on this computer's account: one member of one site each,
 * however many members and sites. The install's data folder, ~/Library/Application Support/<label>/
 * on macOS and ~/.local/share/<label>/ on Linux, holds what they share (app/, python/, the uv
 * cache, logs/lab.log) and connections/<id>/, one folder per connection (addConnection): its
 * site, its member, their sign-in (runner-credentials.json), their keys (settings.env), and
 * NanoAgent's folders and logs for them. The member's files are ~/<files folder>/<login>/.
 *
 * It runs `uv sync` for NanoAgent's dependencies once, then, for each connection, starts a
 * NanoAgent of its own on a free port, with that member's keys and the plugins Mochi installs in
 * the platform's sandbox, waits for its default profile, and starts a relay for it. It looks at
 * connections/ every few seconds: a new connection starts, a removed one stops, and one install.sh
 * wrote again restarts, while the others keep running. A connection whose service fails starts
 * again after a while; one another computer took the member's runs from stays stopped until it is
 * installed again. When a relay needs signing in, the device page opens in the browser; once it is
 * connected after that, the site does, at Settings → AI while there is no key. Keys come only from
 * Mochi, through the relay: kept in the connection's settings.env, handed to its NanoAgent
 * (PUT /v1/keys), and the relay is told which are set. SIGTERM stops every connection, cleanly.
 *
 * It runs on macOS, where plugins run in seatbelt, and on Linux, Windows's WSL2 included, where
 * they run in bwrap (PLATFORMS). Node's own modules are all it loads.
 */
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';

const NANOAGENT_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 250;
// How often connections/ is looked at, and how long a failed connection waits to start again.
const WATCH_MS = 2_000;
const RESTART_MS = 30_000;
const LOG_TAIL_LINES = 30;
// The API keys Mochi Lab holds, by the name NanoAgent's PI runner (pi-ai) reads each from, and
// whose models they reach. NanoAgent gets these and nothing else of the settings.
export const PROVIDER_KEYS = [
  ['OPENROUTER_API_KEY', 'OpenRouter'],
  ['ANTHROPIC_API_KEY', 'Anthropic'],
  ['OPENAI_API_KEY', 'OpenAI'],
  ['GEMINI_API_KEY', 'Google Gemini'],
  ['DEEPSEEK_API_KEY', 'DeepSeek'],
  ['XAI_API_KEY', 'xAI'],
  ['GROQ_API_KEY', 'Groq'],
  ['MISTRAL_API_KEY', 'Mistral'],
  ['CEREBRAS_API_KEY', 'Cerebras'],
  ['TOGETHER_API_KEY', 'Together AI'],
  ['FIREWORKS_API_KEY', 'Fireworks'],
  ['MOONSHOT_API_KEY', 'Moonshot'],
  ['ZAI_API_KEY', 'Z.ai'],
  ['HF_TOKEN', 'Hugging Face'],
];
// What the services see of this process's environment; everything else comes from settings.
const SYSTEM_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR'];
const isProviderKey = name => PROVIDER_KEYS.some(([env]) => env === name);
/**
 * Where it runs: the sandbox NanoAgent confines plugins in (nanoagent.plugin.sandbox), and how a
 * page opens in the member's browser. Under WSL2 that is
 * Windows's, through its interop; the page is in the log, and install.sh prints it, either way.
 */
export const PLATFORMS = {
  darwin: {sandbox: 'seatbelt', open: () => ['open']},
  linux: {
    sandbox: 'bwrap',
    open: () => (/microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')) ? ['/mnt/c/Windows/explorer.exe'] : ['xdg-open']),
  },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The folder in the home folder a connection to `site` keeps its member's files under, one folder
 * per login (config.yaml): the bundle's own site's, or another site's, so a development checkout's
 * files never mix with rush-lab.org's.
 */
export function filesFolderFor(config, site) {
  return site === config.site_url ? config.files_folder : config.other_site.files_folder;
}

/** A connection's folder name: its site's host and port, and its member's id. */
export function connectionId(site, memberId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(memberId ?? ''))) throw new Error(`${memberId} is not a member id`);
  return `${new URL(site).host.replace(':', '-')}-${memberId}`;
}

/** The member Mochi at `site` knows `token` as, {id, login}; false when it knows it no more; null when it cannot be reached. */
export async function memberOf(site, token) {
  try {
    const response = await fetch(`${site}/api/auth/get-session`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15_000)});
    if (!response.ok) return null;
    const user = (await response.json())?.user;
    return user?.id ? {id: user.id, login: user.githubLogin} : false;
  } catch {
    return null;
  }
}

const LEGACY = ['settings.env', 'agent-workspaces', 'nanoagent-installs'];

/**
 * An install from before connections kept one member's sign-in, keys and NanoAgent folders at the
 * top of its data folder. They become that member's connection, as Mochi says whose the sign-in
 * is; a sign-in Mochi knows no more is dropped with them. One whose site cannot be reached stops
 * the install: nothing is moved while it cannot be told whose they are.
 */
export async function adoptLegacy(data, {member = memberOf} = {}) {
  const credentials = path.join(data, 'runner-credentials.json');
  if (!fs.existsSync(credentials)) return null;
  const {site, token} = JSON.parse(fs.readFileSync(credentials, 'utf8'));
  const known = await member(site, token);
  if (known === null) throw new Error(`could not reach ${site} to tell whose RUSH Lab connection this computer has. Run this again once it can be reached.`);
  let adopted = null;
  if (known) {
    adopted = connectionId(site, known.id);
    const folder = path.join(data, 'connections', adopted);
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    for (const name of LEGACY) {
      if (fs.existsSync(path.join(data, name))) fs.renameSync(path.join(data, name), path.join(folder, name));
    }
    writeConnection(folder, {site, member: known, token});
  }
  for (const name of [...LEGACY, 'runner-credentials.json', 'site', 'services.pid']) fs.rmSync(path.join(data, name), {recursive: true, force: true});
  return adopted;
}

function writeConnection(folder, {site, member, token}) {
  fs.writeFileSync(path.join(folder, 'site'), `${site}\n`);
  fs.writeFileSync(path.join(folder, 'member.json'), `${JSON.stringify({id: member.id, login: member.login})}\n`);
  fs.writeFileSync(path.join(folder, 'runner-credentials.json'), `${JSON.stringify({site, token})}\n`, {mode: 0o600});
  // Written last: a change here is what restarts a running connection.
  fs.writeFileSync(path.join(folder, 'installed'), `${new Date().toISOString()}\n`);
}

/**
 * Keep `session` ({session, member: {id, login}}, from POST /api/lab/session) as the connection
 * of its member at `site`, after adopting an install from before connections: its id. Another
 * member's connection, or another site's, is left as it is.
 */
export async function addConnection(data, site, session, options) {
  const {session: token, member} = session;
  if (!/^[A-Za-z0-9._-]+$/.test(String(token ?? ''))) throw new Error(`${site} gave no valid session`);
  if (!member?.login || !/^[A-Za-z0-9-]+$/.test(member.login)) throw new Error(`${site} named no GitHub login for this member`);
  await adoptLegacy(data, options);
  const id = connectionId(site, member.id);
  const folder = path.join(data, 'connections', id);
  fs.mkdirSync(folder, {recursive: true, mode: 0o700});
  writeConnection(folder, {site, member, token});
  return id;
}

const log = (message, connection) => console.log(`${new Date().toISOString()} ${connection ? `[${connection}] ` : ''}${message}`);

/** KEY=VALUE lines, as scripts/db/postgres.mjs's parseEnv reads Mochi's .env. */
export function parseEnv(text) {
  const values = {};
  for (const original of text.split(/\r?\n/)) {
    const trimmed = original.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const line = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
    const at = line.indexOf('=');
    if (at < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, at))) throw new Error(`invalid line: ${original}`);
    const value = line.slice(at + 1).trim();
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    values[line.slice(0, at)] = quoted ? value.slice(1, -1) : value;
  }
  return values;
}

/**
 * Enough of a key for its owner to tell which it is: its first six characters and its last four,
 * or only an ellipsis for a key too short to spare them.
 */
export function keyHint(value) {
  const chars = [...value];
  if (chars.length < 16) return '…';
  return `${chars.slice(0, 6).join('')}…${chars.slice(-4).join('')}`;
}

/** The settings in `file`, or none while there is no file yet; a file that is not settings throws. */
function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

/** Each provider's key in `settings`, set or not, and how it begins and ends: never its value. */
export function keyStatus(settings) {
  return PROVIDER_KEYS.map(([env, label]) => {
    const value = settings[env] || null;
    return {env, label, set: value !== null, hint: value && keyHint(value)};
  });
}

/** The provider keys in `settings`, with a value. */
export function providerKeys(settings) {
  return Object.fromEntries(PROVIDER_KEYS.map(([env]) => [env, settings[env]]).filter(([, value]) => value));
}

/**
 * Keep `changes` ({NAME: key, or null to remove it}) in the settings `file`, readable only by this
 * user, beside the keys it holds; an empty value, or one with spaces, is refused.
 */
export function writeKeys(file, changes) {
  const keys = Object.fromEntries(Object.entries(readSettings(file)).filter(([name]) => isProviderKey(name)));
  for (const [name, value] of Object.entries(changes)) {
    if (!isProviderKey(name)) throw new Error(`${name} is not a key Mochi Lab holds`);
    if (value === null) {
      delete keys[name];
      continue;
    }
    const key = String(value).trim();
    if (!key || /\s/.test(key)) throw new Error(`${name} must be one key, without spaces`);
    keys[name] = key;
  }
  const contents = Object.keys(keys).sort().map(name => `${name}=${keys[name]}\n`).join('');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, contents, {mode: 0o600});
}

/**
 * What every service sees: the system basics, the bundled runtimes first on PATH, and the folder uv
 * installs Python into, the data folder's python/. NanoAgent's plugin sandbox lets plugins, and its
 * own helpers there, read that folder whole (nanoagent.plugin.sandbox), so every link uv makes in it
 * resolves inside the sandbox too.
 */
export function systemEnv(env, bin, data) {
  const system = Object.fromEntries(SYSTEM_ENV.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  return {...system, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, UV_PYTHON_INSTALL_DIR: path.join(data, 'python')};
}

/**
 * How NanoAgent starts for a connection, in the bundle's `nanoagent` folder: its own folders in the
 * connection's, the uv cache the install's, with the member's `keys` and its bearer `token`.
 */
export function nanoagentCommand({nanoagent, data, connection, port, sandbox, system, keys, token}) {
  const python = path.join(nanoagent, '.venv', 'bin', 'python');
  return {
    program: python,
    args: [
      // A compiled NanoAgent has no code object for `-m nanoagent` (nanoagent/__main__.py).
      '-I', '-c', 'from nanoagent.__main__ import main; raise SystemExit(main())', 'web',
      'web_cfg=deploy/railway/nanoagent.yaml',
      'host=127.0.0.1',
      `port=${port}`,
      // Mochi's marketplace is anyone's, and this is the member's own computer: every plugin runs confined.
      `sandbox=${sandbox}`,
      // The member's runs choose any model their keys reach, and settings of their own.
      'run_models=true',
      `workspaces=${JSON.stringify(path.join(connection, 'agent-workspaces'))}`,
      `installs=${JSON.stringify(path.join(connection, 'nanoagent-installs'))}`,
      `uv_cache=${JSON.stringify(path.join(data, 'nanoagent-uv-cache'))}`,
      // Plugins run on the Python NanoAgent runs on; its environment holds no PATH to find `python` on.
      `plugin_python=${JSON.stringify(python)}`,
    ],
    // The keys are all NanoAgent is given of the settings.
    env: {...system, ...keys, NANOAGENT_API_TOKEN: token},
  };
}

/** A connection's relay's environment (relay.mjs). */
export function relayEnv({system, site, port, token, connection, keys, files}) {
  return {
    ...system,
    MOCHI_SITE_URL: site,
    NANOAGENT_URL: `http://127.0.0.1:${port}`,
    NANOAGENT_API_TOKEN: token,
    RUNNER_CREDENTIALS: path.join(connection, 'runner-credentials.json'),
    RUNNER_KEYS: JSON.stringify(keys),
    RUNNER_FILES: files,
  };
}

function tail(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return `${file}:\n${lines.slice(-LOG_TAIL_LINES).join('\n')}`;
}

/** A log file, emptied, open for appending by this process and the services it is handed to. */
function openLog(file) {
  fs.writeFileSync(file, '');
  return fs.openSync(file, 'a');
}

/** A loopback port nothing listens on now, for a connection's NanoAgent. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** `method path` on NanoAgent with its bearer `token`: the status and body, or null when nothing answers. */
async function nanoagentRequest(port, method, route, token, body) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {Authorization: `Bearer ${token}`, ...(body ? {'Content-Type': 'application/json'} : {})},
      body,
      signal: AbortSignal.timeout(5000),
    });
    return {status: response.status, body: await response.text()};
  } catch {
    return null;
  }
}

/**
 * NanoAgent is ready when it identifies itself and its default profile can run (the check
 * start-local.mjs makes). An unavailable profile is a configuration error, not a wait.
 */
async function nanoagentReady(port, token) {
  const health = await nanoagentRequest(port, 'GET', '/health', token);
  if (health?.status !== 200) return false;
  if (JSON.parse(health.body).service !== 'nanoagent') throw new Error('the service on NanoAgent\'s port is not NanoAgent');
  const profiles = await nanoagentRequest(port, 'GET', '/v1/profiles', token);
  if (profiles?.status !== 200) return false;
  const catalog = JSON.parse(profiles.body);
  const profile = catalog.profiles?.find(entry => entry.id === catalog.defaultProfile);
  if (!profile) throw new Error(`NanoAgent's default profile ${catalog.defaultProfile} is missing from its catalog`);
  if (profile.available === false) {
    throw new Error(`NanoAgent's default profile ${catalog.defaultProfile} is unavailable: ${profile.unavailableReason ?? 'no reason given'}`);
  }
  return true;
}

const describeExit = ({code, signal}) => (signal ? `signal: ${signal}` : `exit status: ${code}`);

async function main() {
  const platform = PLATFORMS[process.platform];
  if (!platform) {
    throw new Error(`Mochi Lab runs on macOS and Linux (Windows through WSL2), where plugins run in a sandbox; this is ${process.platform}.`);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const bin = path.join(root, 'bin');
  const nanoagent = path.join(root, 'nanoagent');
  // install.sh unpacks the bundle into <data>/app/<stamp>/.
  const data = path.resolve(root, '..', '..', '..');
  if (path.basename(data) !== config.label) throw new Error(`RUSH Lab is installed as ${config.label}, not in ${data}`);
  const connectionsFolder = path.join(data, 'connections');
  /** Open `page` in the member's browser; when that cannot be done, the log has the page. */
  const openPage = page => {
    const [program, ...args] = platform.open();
    spawn(program, [...args, page], {stdio: 'ignore'}).on('error', error => log(`could not open ${page}: ${error.message}`));
  };
  // Every service this has running, of every connection: one `pid<TAB>program` line each.
  const pidFile = path.join(data, 'services.pid');
  const system = systemEnv(process.env, bin, data);
  // The connections, by id: {id, folder, site, installed, services, state, restartAt, relayStdin, token, port}.
  const connections = new Map();
  let stopping = false;

  /** Stop the services a previous run left behind: each recorded process still running the program it was started with. */
  async function stopLeftovers() {
    if (!fs.existsSync(pidFile)) return;
    for (const line of fs.readFileSync(pidFile, 'utf8').split('\n')) {
      const [pid, program] = line.split('\t');
      if (!program) continue;
      const command = await new Promise(resolve => {
        const ps = spawn('/bin/ps', ['-p', pid, '-o', 'command='], {stdio: ['ignore', 'pipe', 'ignore']});
        let out = '';
        ps.stdout.on('data', chunk => { out += chunk; });
        ps.on('close', () => resolve(out));
      });
      if (!command.startsWith(program)) continue;
      log(`Stopping ${program} (${pid}), left running before`);
      const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
      process.kill(Number(pid), 'SIGTERM');
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (alive() && Date.now() < deadline) await sleep(100);
      if (alive()) process.kill(Number(pid), 'SIGKILL');
    }
    fs.rmSync(pidFile, {force: true});
  }

  /**
   * Start `name` into `services`, its output in `logFile`; `piped`, its standard input and output
   * are this process's to write and read instead, and its errors go to the log.
   */
  function startService(services, name, program, args, {cwd, env, logFile, piped = false}) {
    const fd = openLog(logFile);
    const child = spawn(program, args, {cwd, env, stdio: [piped ? 'pipe' : 'ignore', piped ? 'pipe' : fd, fd]});
    const service = {name, child, logFile, fd, exited: null};
    // `close` comes once its output is read too, so nothing writes the log after it is closed.
    service.done = new Promise(resolve => {
      const end = exited => {
        if (service.exited) return;
        service.exited = exited;
        fs.closeSync(fd);
        resolve();
      };
      child.once('error', error => end({code: null, signal: null, error}));
      child.once('close', (code, signal) => end({code, signal}));
    });
    if (child.pid) fs.appendFileSync(pidFile, `${child.pid}\t${program}\n`);
    services.push(service);
    return service;
  }

  /** The last first: SIGTERM so each shuts down cleanly, SIGKILL after STOP_TIMEOUT_MS. */
  async function stopServices(services) {
    while (services.length) {
      const service = services.pop();
      if (service.exited) continue;
      service.child.kill('SIGTERM');
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (!service.exited && Date.now() < deadline) await sleep(100);
      if (!service.exited) service.child.kill('SIGKILL');
      await service.done;
    }
  }

  /** How `service` ended, with its log. */
  function exitMessage(service) {
    const {error} = service.exited;
    if (error) return `could not start ${service.name} (${service.child.spawnfile}): ${error.message}`;
    return `${service.name} exited (${describeExit(service.exited)}).\n\n${tail(service.logFile)}`;
  }

  /** Wait for `ready`, failing when one of `services` exits or `timeoutMs` passes. */
  async function waitUntil(services, name, timeoutMs, ready) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const gone = services.find(service => service.exited);
      if (gone) throw new Error(exitMessage(gone));
      if (await ready()) return;
      if (Date.now() > deadline) throw new Error(`${name} did not become ready within ${timeoutMs / 1000}s.\n\n${tail(services.at(-1).logFile)}`);
      await sleep(POLL_MS);
    }
  }

  /** Stop everything and exit with `code`, once. */
  async function shutdown(code, message) {
    if (stopping) return;
    stopping = true;
    if (message) console.error(`${new Date().toISOString()} ${message}`);
    await Promise.all([...connections.values()].map(connection => stopConnection(connection)));
    fs.rmSync(pidFile, {force: true});
    process.exit(code);
  }

  process.on('SIGTERM', () => shutdown(0, 'Stopping (SIGTERM).'));
  process.on('SIGINT', () => shutdown(0, 'Stopping (SIGINT).'));
  try {
    await prepare();
  } catch (error) {
    await shutdown(1, error.message);
    return;
  }
  for (;;) {
    if (stopping) return;
    // One connection's trouble is logged, and the others carry on.
    await watch().catch(error => log(`could not look at ${connectionsFolder}: ${error.message}`));
    await sleep(WATCH_MS);
  }

  /** Stop what a previous run left, and make NanoAgent's environment, which every connection shares. */
  async function prepare() {
    log(`Mochi Lab ${fs.readFileSync(path.join(root, 'stamp'), 'utf8').trim()}`);
    fs.mkdirSync(connectionsFolder, {recursive: true, mode: 0o700});
    fs.mkdirSync(path.join(data, 'logs'), {recursive: true});
    await stopLeftovers();
    log('Preparing NanoAgent\'s Python environment (the first start downloads Python)…');
    // Only NanoAgent's dependencies, as the bundled uv.lock pins them: NanoAgent itself is the
    // compiled module in site/, with no source to check the lock against.
    const services = [];
    const uv = startService(services, 'uv sync', path.join(bin, 'uv'), [
      'sync', '--frozen', '--no-dev', '--no-install-project', '--extra', 'web', '--managed-python', '--python', config.python_version,
    ], {cwd: nanoagent, env: system, logFile: path.join(data, 'logs', 'uv-sync.log')});
    await uv.done;
    if (uv.exited.error || uv.exited.code !== 0) {
      throw new Error(uv.exited.error ? exitMessage(uv) : `uv sync failed (${describeExit(uv.exited)}).\n\n${tail(uv.logFile)}`);
    }
    const sitePackages = path.join(nanoagent, '.venv', 'lib', `python${config.python_version}`, 'site-packages');
    try {
      fs.writeFileSync(path.join(sitePackages, 'nanoagent.pth'), `${path.join(nanoagent, 'site')}\n`);
    } catch (error) {
      throw new Error(`could not add NanoAgent to its environment: ${error.message}`);
    }
  }

  /** Start the connections that are new, written again, or due to start again after failing; stop the removed ones. */
  async function watch() {
    const present = new Map();
    for (const id of fs.readdirSync(connectionsFolder)) {
      const folder = path.join(connectionsFolder, id);
      const installed = path.join(folder, 'installed');
      if (fs.existsSync(installed)) present.set(id, fs.readFileSync(installed, 'utf8'));
    }
    for (const [id, connection] of connections) {
      if (present.has(id)) continue;
      connections.delete(id);
      log(`Removed from this computer; stopping.`, id);
      await stopConnection(connection);
    }
    for (const [id, installed] of present) {
      let connection = connections.get(id);
      if (connection && connection.installed !== installed) {
        log('Installed again; restarting.', id);
        await stopConnection(connection);
        connection = null;
      }
      if (!connection) {
        connection = {id, folder: path.join(connectionsFolder, id), installed, services: [], state: 'starting'};
        connections.set(id, connection);
        startConnection(connection).catch(error => log(`could not start: ${error.message}`, id));
      } else if (connection.state === 'failed' && Date.now() >= connection.restartAt) {
        connection.state = 'starting';
        startConnection(connection).catch(error => log(`could not start: ${error.message}`, id));
      }
    }
  }

  async function stopConnection(connection) {
    connection.state = 'stopped';
    connection.relayStdin = null;
    connection.token = null;
    await stopServices(connection.services);
  }

  /**
   * A connection ends: failed, it starts again after RESTART_MS; replaced, it waits to be installed
   * again. `message` says why; one stopped on purpose ends with nothing to say.
   */
  async function endConnection(connection, replaced, message) {
    if (connection.state !== 'running' && connection.state !== 'starting') return;
    connection.state = replaced ? 'replaced' : 'failed';
    connection.restartAt = Date.now() + RESTART_MS;
    log(replaced ? 'Another computer took this member\'s runs; stopping until installed again.' : `${message}\nStarting again in ${RESTART_MS / 1000}s.`, connection.id);
    connection.relayStdin = null;
    connection.token = null;
    await stopServices(connection.services);
  }

  async function startConnection(connection) {
    const {id, folder, services} = connection;
    try {
      const site = fs.readFileSync(path.join(folder, 'site'), 'utf8').trim();
      const member = JSON.parse(fs.readFileSync(path.join(folder, 'member.json'), 'utf8'));
      const logs = path.join(folder, 'logs');
      fs.mkdirSync(logs, {recursive: true});
      const settingsFile = path.join(folder, 'settings.env');
      const settings = readSettings(settingsFile);
      Object.assign(connection, {site, settingsFile, port: await freePort()});
      log(`Starting NanoAgent for @${member.login} on ${site}…`, id);
      // Only this connection's relay and this process hold it, so nothing else on this computer can run its NanoAgent.
      const token = crypto.randomBytes(32).toString('hex');
      const command = nanoagentCommand({
        nanoagent, data, connection: folder, port: connection.port, sandbox: platform.sandbox, system, keys: providerKeys(settings), token,
      });
      startService(services, 'NanoAgent', command.program, command.args, {cwd: nanoagent, env: command.env, logFile: path.join(logs, 'nanoagent.log')});
      await waitUntil(services, 'NanoAgent', NANOAGENT_TIMEOUT_MS, () => nanoagentReady(connection.port, token));
      if (connection.state !== 'starting') return;
      connection.token = token;
      log(`NanoAgent is ready on 127.0.0.1:${connection.port}`, id);

      log(`Connecting to ${site}…`, id);
      const files = path.join(os.homedir(), filesFolderFor(config, site), member.login);
      const relay = startService(services, 'The relay', path.join(bin, 'node'), ['relay.mjs'], {
        cwd: path.join(root, 'runner'),
        env: relayEnv({system, site, port: connection.port, token, connection: folder, keys: keyStatus(readSettings(settingsFile)), files}),
        logFile: path.join(logs, 'relay.log'),
        piped: true,
      });
      connection.relayStdin = relay.child.stdin;
      // Writing to a relay that has just exited fails; its exit is what ends the connection.
      connection.relayStdin.on('error', () => {});
      followRelay(connection, relay);
      connection.state = 'running';
      // From here, either service exiting stops the other; a relay that ends cleanly was replaced by another computer.
      for (const service of services) {
        service.done.then(() => {
          if (connection.state !== 'running') return undefined;
          return endConnection(connection, service === relay && service.exited.code === 0, exitMessage(service));
        }).catch(error => log(`could not stop after ${service.name} exited: ${error.message}`, id));
      }
    } catch (error) {
      await endConnection(connection, false, error.message);
    }
  }

  /** One JSON line on the connection's relay's standard input. */
  function tellRelay(connection, message) {
    connection.relayStdin?.write(`${JSON.stringify(message)}\n`);
  }

  /** Keep `changes` for the connection, hand them to its NanoAgent, and tell its relay which keys are set now. */
  async function applyKeys(connection, changes) {
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)
      || !Object.values(changes).every(value => value === null || typeof value === 'string')) {
      throw new Error('changes must be {NAME: key or null}');
    }
    writeKeys(connection.settingsFile, changes);
    if (!connection.token) throw new Error('NanoAgent is not running');
    const answer = await nanoagentRequest(connection.port, 'PUT', '/v1/keys', connection.token, JSON.stringify({changes}));
    if (!answer) throw new Error('NanoAgent did not answer');
    if (answer.status !== 200) throw new Error(`NanoAgent refused the keys (${answer.status}): ${answer.body}`);
    tellRelay(connection, {keys: keyStatus(readSettings(connection.settingsFile))});
  }

  /**
   * Read a relay's events (relay.mjs) into its log: open its sign-in page, and the site once it is
   * connected after that, and apply the keys Mochi sends, answering on its stdin. A keys event is
   * never logged: it carries their values.
   */
  function followRelay(connection, relay) {
    const {id, site} = connection;
    let signingIn = false;
    readline.createInterface({input: relay.child.stdout}).on('line', line => {
      let event = {};
      try {
        event = JSON.parse(line);
      } catch {}
      if (event.event !== 'keys') fs.appendFileSync(relay.fd, `${line}\n`);
      if (event.event === 'sign-in') {
        signingIn = true;
        // The device page says it is Mochi Lab asking (src/pages/device).
        const page = `${event.url}&client=desktop`;
        log(`Sign in to Mochi, then approve this computer (code ${event.code}): ${page}`, id);
        openPage(page);
      } else if (event.event === 'connected') {
        log(`Connected to ${site}`, id);
        if (!signingIn) return;
        signingIn = false;
        // The device page says Mochi opens next; with no key yet, straight to where one is added.
        const keyless = !keyStatus(readSettings(connection.settingsFile)).some(key => key.set);
        openPage(keyless ? `${site.replace(/\/$/, '')}/settings#ai` : site);
      } else if (event.event === 'disconnected') {
        log(`Disconnected from ${site}: ${event.reason}`, id);
      } else if (event.event === 'keys') {
        applyKeys(connection, event.changes).then(
          () => tellRelay(connection, {id: event.id, error: null}),
          error => tellRelay(connection, {id: event.id, error: error.message}),
        );
      }
    });
  }
}

// As a URL the path is escaped ("Application Support" is Application%20Support), so compare paths;
// launchd names this through the `current` link, and Node resolves it. install.sh asks it:
//   lab.mjs label                      the label the install is under
//   lab.mjs connect <data> <site>      keep LAB_SESSION as its member's connection, and print its id
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const config = () => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
  const [command, data, site] = process.argv.slice(2);
  const run = command === 'label' ? async () => console.log(config().label)
    : command === 'connect' ? async () => console.log(await addConnection(data, site, JSON.parse(process.env.LAB_SESSION ?? '{}')))
      : main;
  run().catch(error => {
    console.error(`${new Date().toISOString()} ${error.message}`);
    process.exitCode = 1;
  });
}
