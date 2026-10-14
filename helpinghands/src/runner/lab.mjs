/**
 * Mochi Lab without its window: what desktop/src-tauri/src/supervisor.rs does behind the app's
 * window, for a member who uses Mochi in the browser. install.sh unpacks its bundle
 * (desktop/scripts/bundle-lab.mjs) and has launchd run it at login, restarting it when it exits
 * with an error:
 *
 *   mochi-lab/stamp          names this bundle
 *   mochi-lab/config.json    desktop/config.yaml: the Mochi it serves, NanoAgent's port, Python's version
 *   mochi-lab/bin/{node,uv}  the runtimes, first on every service's PATH
 *   mochi-lab/runner/        this file, the relay (relay.mjs) and what it loads
 *   mochi-lab/nanoagent/     NanoAgent compiled by Nuitka (site/), its uv.lock, the PI runner's bundle, its config
 *
 * It runs `uv sync` for NanoAgent's dependencies, starts NanoAgent with the member's API keys
 * (none yet, at first) and the plugins Mochi installs in macOS's sandbox, waits for its default
 * profile, and starts the relay. When the relay needs signing in, the device page opens in the
 * browser; once it is connected after that, the site does, at Settings → AI while there is no key.
 * Keys come only from Settings → AI, through the relay: kept in settings.env, handed to the
 * running NanoAgent (PUT /v1/keys), and the relay is told which are set. When either service
 * exits, the other is stopped and this exits with an error, for launchd to start it again; a relay
 * that another computer replaced exits cleanly, and so does this. SIGTERM stops both, cleanly.
 *
 * It runs on macOS, where plugins run in seatbelt, and on Linux, Windows's WSL2 included, where
 * they run in bwrap (PLATFORMS). Its data folder (settings.env, runner-credentials.json, logs/, and
 * NanoAgent's folders) is ~/Library/Application Support/lab.mochi.lab/ on macOS and
 * ~/.local/share/lab.mochi.lab/ on Linux, as install.sh makes it. Node's own modules are all it loads.
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
 * Where it runs: the sandbox NanoAgent confines plugins in (nanoagent.plugin.sandbox), its data
 * folder under the home folder, and how a page opens in the member's browser. Under WSL2 that is
 * Windows's, through its interop; the page is in the log, and install.sh prints it, either way.
 */
export const PLATFORMS = {
  darwin: {sandbox: 'seatbelt', data: ['Library', 'Application Support', 'lab.mochi.lab'], open: () => ['open']},
  linux: {
    sandbox: 'bwrap',
    data: ['.local', 'share', 'lab.mochi.lab'],
    open: () => (/microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')) ? ['/mnt/c/Windows/explorer.exe'] : ['xdg-open']),
  },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => console.log(`${new Date().toISOString()} ${message}`);

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

/** How NanoAgent starts, in the bundle's `nanoagent` folder, with this data folder, `keys` and its bearer `token`. */
export function nanoagentCommand({nanoagent, data, port, sandbox, system, keys, token}) {
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
      `workspaces=${JSON.stringify(path.join(data, 'agent-workspaces'))}`,
      `installs=${JSON.stringify(path.join(data, 'nanoagent-installs'))}`,
      `uv_cache=${JSON.stringify(path.join(data, 'nanoagent-uv-cache'))}`,
      // Plugins run on the Python NanoAgent runs on; its environment holds no PATH to find `python` on.
      `plugin_python=${JSON.stringify(python)}`,
    ],
    // The keys are all NanoAgent is given of the settings.
    env: {...system, ...keys, NANOAGENT_API_TOKEN: token},
  };
}

/** The relay's environment (relay.mjs). */
export function relayEnv({system, site, port, token, data, keys, files}) {
  return {
    ...system,
    MOCHI_SITE_URL: site,
    NANOAGENT_URL: `http://127.0.0.1:${port}`,
    NANOAGENT_API_TOKEN: token,
    RUNNER_CREDENTIALS: path.join(data, 'runner-credentials.json'),
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

/** True when anything accepts a connection on localhost:`port`. */
function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: 'localhost', port, timeout: 1000});
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
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
  const data = path.join(os.homedir(), ...platform.data);
  /** Open `page` in the member's browser; when that cannot be done, the log has the page. */
  const openPage = page => {
    const [program, ...args] = platform.open();
    spawn(program, [...args, page], {stdio: 'ignore'}).on('error', error => log(`could not open ${page}: ${error.message}`));
  };
  const files = path.join(os.homedir(), config.files_folder);
  const settingsFile = path.join(data, 'settings.env');
  // The services this has running: one `pid<TAB>program` line each.
  const pidFile = path.join(data, 'services.pid');
  const logs = path.join(data, 'logs');
  const port = config.nanoagent_port;
  const site = config.site_url;
  const services = [];
  let stopping = false;
  let relayStdin = null;
  let nanoagentToken = null;

  /** The relay first, then NanoAgent: SIGTERM so each shuts down cleanly, SIGKILL after STOP_TIMEOUT_MS. */
  async function stopServices() {
    nanoagentToken = null;
    relayStdin = null;
    while (services.length) {
      const service = services.pop();
      if (service.exited) continue;
      service.child.kill('SIGTERM');
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (!service.exited && Date.now() < deadline) await sleep(100);
      if (!service.exited) service.child.kill('SIGKILL');
      await service.done;
    }
    fs.rmSync(pidFile, {force: true});
  }

  /** Stop everything and exit with `code`, once. */
  async function shutdown(code, message) {
    if (stopping) return;
    stopping = true;
    if (message) console.error(`${new Date().toISOString()} ${message}`);
    await stopServices();
    process.exit(code);
  }

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
   * Start `name`, its output in `logFile`; `piped`, its standard input and output are this
   * process's to write and read instead, and its errors go to the log. Its exit, once it is
   * running, stops the other service and this process.
   */
  function startService(name, program, args, {cwd, env, logFile, piped = false}) {
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

  /** How `service` ended, with its log. */
  function exitMessage(service) {
    const {error} = service.exited;
    if (error) return `could not start ${service.name} (${service.child.spawnfile}): ${error.message}`;
    return `${service.name} exited (${describeExit(service.exited)}).\n\n${tail(service.logFile)}`;
  }

  /** Wait for `ready`, failing when a service exits or `timeoutMs` passes. */
  async function waitUntil(name, timeoutMs, ready) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const gone = services.find(service => service.exited);
      if (gone) throw new Error(exitMessage(gone));
      if (await ready()) return;
      if (Date.now() > deadline) throw new Error(`${name} did not become ready within ${timeoutMs / 1000}s.\n\n${tail(services.at(-1).logFile)}`);
      await sleep(POLL_MS);
    }
  }

  /** One JSON line on the relay's standard input. */
  const tellRelay = message => relayStdin?.write(`${JSON.stringify(message)}\n`);

  /** Keep `changes`, hand them to the running NanoAgent, and tell the relay which keys are set now. */
  async function applyKeys(changes) {
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)
      || !Object.values(changes).every(value => value === null || typeof value === 'string')) {
      throw new Error('changes must be {NAME: key or null}');
    }
    writeKeys(settingsFile, changes);
    if (!nanoagentToken) throw new Error('NanoAgent is not running');
    const answer = await nanoagentRequest(port, 'PUT', '/v1/keys', nanoagentToken, JSON.stringify({changes}));
    if (!answer) throw new Error('NanoAgent did not answer');
    if (answer.status !== 200) throw new Error(`NanoAgent refused the keys (${answer.status}): ${answer.body}`);
    tellRelay({keys: keyStatus(readSettings(settingsFile))});
  }

  /**
   * Read the relay's events (relay.mjs) into its log: open its sign-in page, and the site once it
   * is connected after that, and apply the keys Settings → AI sends, answering on its stdin. A keys
   * event is never logged: it carries their values.
   */
  function followRelay(relay) {
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
        log(`Sign in to Mochi, then approve this computer (code ${event.code}): ${page}`);
        openPage(page);
      } else if (event.event === 'connected') {
        log(`Connected to ${site}`);
        if (!signingIn) return;
        signingIn = false;
        // The device page says Mochi opens next; with no key yet, straight to where one is added.
        const keyless = !keyStatus(readSettings(settingsFile)).some(key => key.set);
        const page = keyless ? `${site.replace(/\/$/, '')}/settings#ai` : site;
        openPage(page);
      } else if (event.event === 'disconnected') {
        log(`Disconnected from ${site}: ${event.reason}`);
      } else if (event.event === 'keys') {
        applyKeys(event.changes).then(
          () => tellRelay({id: event.id, error: null}),
          error => tellRelay({id: event.id, error: error.message}),
        );
      }
    });
  }

  process.on('SIGTERM', () => shutdown(0, 'Stopping (SIGTERM).'));
  process.on('SIGINT', () => shutdown(0, 'Stopping (SIGINT).'));
  try {
    await start();
  } catch (error) {
    await shutdown(1, error.message);
  }

  async function start() {
    log(`Mochi Lab ${fs.readFileSync(path.join(root, 'stamp'), 'utf8').trim()}, serving ${site}`);
    fs.mkdirSync(logs, {recursive: true});
    const settings = readSettings(settingsFile);
    await stopLeftovers();
    if (await listening(port)) throw new Error(`Port ${port} already in use. Quit whatever is using it (the Mochi Lab app?); launchd tries again.`);
    const system = systemEnv(process.env, bin, data);

    log('Preparing NanoAgent\'s Python environment (the first start downloads Python)…');
    // Only NanoAgent's dependencies, as the bundled uv.lock pins them: NanoAgent itself is the
    // compiled module in site/, with no source to check the lock against.
    const uv = startService('uv sync', path.join(bin, 'uv'), [
      'sync', '--frozen', '--no-dev', '--no-install-project', '--extra', 'web', '--managed-python', '--python', config.python_version,
    ], {cwd: nanoagent, env: system, logFile: path.join(logs, 'uv-sync.log')});
    await uv.done;
    if (stopping) return;
    services.splice(services.indexOf(uv), 1);
    if (uv.exited.error || uv.exited.code !== 0) {
      throw new Error(uv.exited.error ? exitMessage(uv) : `uv sync failed (${describeExit(uv.exited)}).\n\n${tail(uv.logFile)}`);
    }
    const sitePackages = path.join(nanoagent, '.venv', 'lib', `python${config.python_version}`, 'site-packages');
    try {
      fs.writeFileSync(path.join(sitePackages, 'nanoagent.pth'), `${path.join(nanoagent, 'site')}\n`);
    } catch (error) {
      throw new Error(`could not add NanoAgent to its environment: ${error.message}`);
    }

    log('Starting NanoAgent…');
    // Only the relay and this process hold it, so nothing else on this computer can run NanoAgent.
    const token = crypto.randomBytes(32).toString('hex');
    const command = nanoagentCommand({nanoagent, data, port, sandbox: platform.sandbox, system, keys: providerKeys(settings), token});
    startService('NanoAgent', command.program, command.args, {cwd: nanoagent, env: command.env, logFile: path.join(logs, 'nanoagent.log')});
    await waitUntil('NanoAgent', NANOAGENT_TIMEOUT_MS, () => nanoagentReady(port, token));
    nanoagentToken = token;
    log(`NanoAgent is ready on 127.0.0.1:${port}`);

    log(`Connecting to ${site}…`);
    const relay = startService('The relay', path.join(bin, 'node'), ['relay.mjs'], {
      cwd: path.join(root, 'runner'),
      env: relayEnv({system, site, port, token, data, keys: keyStatus(readSettings(settingsFile)), files}),
      logFile: path.join(logs, 'relay.log'),
      piped: true,
    });
    relayStdin = relay.child.stdin;
    // Writing to a relay that has just exited fails; its exit is what stops this.
    relayStdin.on('error', () => {});
    followRelay(relay);

    // From here, either service exiting stops the other, and this, for launchd to start again;
    // a relay that ends cleanly was replaced by another computer, and is not started again.
    for (const service of services) {
      service.done.then(() => {
        const replaced = service === relay && service.exited.code === 0;
        shutdown(replaced ? 0 : 1, replaced ? 'Another computer took this member\'s runs; stopping.' : exitMessage(service));
      });
    }
  }
}

// As a URL the path is escaped ("Application Support" is Application%20Support), so compare paths;
// launchd names this through the `current` link, and Node resolves it.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch(error => {
    console.error(`${new Date().toISOString()} ${error.message}`);
    process.exitCode = 1;
  });
}
