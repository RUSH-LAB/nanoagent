/**
 * What RUSH Lab, the app (desktop/src-tauri), runs behind its menu-bar icon. The app installs its
 * bundled files into the data folder's app/<stamp>/ and runs this from there, starting it again
 * when it exits while the app is open:
 *
 *   mochi-lab/stamp          names this build
 *   mochi-lab/config.json    desktop/config.yaml: the app's name, label, scheme, command and site, the files folder, Python's version
 *   mochi-lab/bin/{node,uv}  the runtimes, first on every service's PATH
 *   mochi-lab/git/           git, next on it
 *   mochi-lab/runner/        this file, the relay (relay.mjs) and what it loads, and plugin-project/, what `<command> new` writes
 *   mochi-lab/nanoagent/     NanoAgent's source (site/), its uv.lock, the PI runner's bundle, its config
 *
 * One install serves every connection on this computer's account to its one site (config.site_url):
 * one member each, however many members. The install's data folder, ~/Library/Application Support/<label>/,
 * holds what they share (app/, python/, the uv cache, logs/lab.log) and connections/<id>/, one
 * folder per connection (addConnection): its site, its member, their sign-in
 * (runner-credentials.json), their keys (settings.env), and NanoAgent's folders and logs for them.
 * The member's files are ~/<files folder>/<login>/ (memberFiles). A connection to any other site, which an
 * earlier build kept, is removed at startup (removeOtherSites).
 *
 * It runs `uv sync` for NanoAgent's dependencies once, then, for each connection, starts a
 * NanoAgent of its own on a free port, with that member's keys and the plugins RUSH installs in
 * the platform's sandbox, waits for its default profile, and starts a relay for it. It looks at
 * connections/ every few seconds: a new connection starts, a removed one stops, and one connected
 * again restarts, while the others keep running. A connection whose service fails starts again
 * after a while; one another computer took the member's runs from stays stopped until it is
 * connected again. When a relay needs signing in, the device page opens in the browser; once it is
 * connected after that, the site does, at Settings → AI while there is no key. Keys, and the
 * addresses of the member's own vLLM and SGLang servers, come only from RUSH, through the relay:
 * kept in the connection's settings.env, handed to its NanoAgent (PUT /v1/keys), and the relay is
 * told which are set. The data folder's `busy` is there while any
 * relay has a request of RUSH's going, a held run included: the app updates itself only while it
 * is not (desktop/src-tauri/src/update.rs). SIGTERM stops every connection, cleanly.
 *
 * At each start it writes the app's command (config.command, rushlab; rushlab-dev in RUSH Lab Dev)
 * into ~/.local/bin/ for the build it runs (installCommand), which the member runs in whatever
 * terminal they use: `<command> new <id>` makes a plugin there for their AI CLI to design with
 * (newPlugin), `<command> nanoagent` and `<command> uv` run the bundled ones (bundledCommand), so
 * nothing else goes on their PATH.
 *
 * It runs on macOS, where plugins run in seatbelt, and on Windows, in an AppContainer (PLATFORMS).
 * Node's own modules are all it loads.
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
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The API keys RUSH Lab holds, by the name NanoAgent's PI runner (pi-ai) reads each from, and
// whose models they reach, then the member's own servers (SERVER_URLS) and the keys those were
// started with, if any. NanoAgent gets these and nothing else of the settings.
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
  ['VLLM_BASE_URL', 'vLLM server'],
  ['VLLM_API_KEY', 'vLLM'],
  ['SGLANG_BASE_URL', 'SGLang server'],
  ['SGLANG_API_KEY', 'SGLang'],
];
// The settings that are the address of a server of the member's own, by the engine it runs
// (nanoagent.inference.providers.SERVERS): its OpenAI-compatible /v1 endpoint, each with the key it
// was started with, which goes only to the address it was saved with (writeKeys).
const SERVER_KEYS = {VLLM_BASE_URL: 'VLLM_API_KEY', SGLANG_BASE_URL: 'SGLANG_API_KEY'};
export const SERVER_URLS = Object.keys(SERVER_KEYS);
const WINDOWS = process.platform === 'win32';
// What the services see of this process's environment; everything else comes from settings.
const SYSTEM_ENV = WINDOWS
  ? ['SystemRoot', 'SystemDrive', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']
  : ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR'];
const isProviderKey = name => PROVIDER_KEYS.some(([env]) => env === name);
/**
 * Where it runs: the sandbox NanoAgent confines plugins in (nanoagent.plugin.sandbox), and how a
 * page opens in the member's browser; the page is in the log either way.
 */
export const PLATFORMS = {
  darwin: {sandbox: 'seatbelt', open: () => ['open']},
  win32: {sandbox: 'appcontainer', open: () => ['rundll32', 'url.dll,FileProtocolHandler']},
};
const exe = name => (WINDOWS ? `${name}.exe` : name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const venvPython = nanoagent => (WINDOWS ? path.join(nanoagent, '.venv', 'Scripts', 'python.exe') : path.join(nanoagent, '.venv', 'bin', 'python'));

/**
 * The site a connect link names (<scheme>://connect, routes/lab.js), as its origin: only the app's
 * own site (config.site_url). Any other is refused, so no web page can connect this computer to a
 * site of its own.
 */
export function connectableSite(config, site) {
  let origin;
  try {
    origin = new URL(site).origin;
  } catch {
    throw new Error(`${site} is not a site ${config.product_name} connects to: it serves only ${config.site_url}`);
  }
  if (origin !== new URL(config.site_url).origin) throw new Error(`${origin} is not a site ${config.product_name} connects to: it serves only ${config.site_url}`);
  return origin;
}

/**
 * Remove each connection in the data folder to a site other than config.site_url, as an earlier
 * build kept, its folder deleted and a line logged for it: the ids removed. The member's files
 * folder is left as it is.
 */
export function removeOtherSites(data, config) {
  const folder = path.join(data, 'connections');
  const removed = [];
  for (const id of fs.readdirSync(folder)) {
    // A connection is whole once `installed` is written (writeConnection), as watch() reads them.
    if (!fs.existsSync(path.join(folder, id, 'installed'))) continue;
    const site = fs.readFileSync(path.join(folder, id, 'site'), 'utf8').trim();
    if (site === new URL(config.site_url).origin) continue;
    fs.rmSync(path.join(folder, id), {recursive: true, force: true});
    log(`Removed the connection to ${site}: ${config.product_name} serves only ${config.site_url}. Its member's files are left as they are.`, id);
    removed.push(id);
  }
  return removed;
}

/** `method` /api/lab/session at `site` with a connect link's `token`: its answer, or why it refused. */
async function linkAnswer(site, token, method) {
  const response = await fetch(`${site}/api/lab/session?token=${encodeURIComponent(token)}`, {method, signal: AbortSignal.timeout(15_000)});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${site} answered ${response.status}`);
  return body;
}

/**
 * The member a connect link's `token` is for at `site`, {id, login}, without signing in
 * (GET /api/lab/session): the app asks them to confirm it is theirs first.
 */
export async function linkMember(site, token) {
  const {member} = await linkAnswer(site, token, 'GET');
  if (!/^[A-Za-z0-9-]+$/.test(String(member?.login ?? ''))) throw new Error(`${site} named no GitHub login for this link`);
  return member;
}

/** A session for the connect link's member at `site`, {session, member} (POST /api/lab/session). */
export const linkSession = (site, token) => linkAnswer(site, token, 'POST');

/** A connection's folder name: its site's host and port, and its member's id. */
export function connectionId(site, memberId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(memberId ?? ''))) throw new Error(`${memberId} is not a member id`);
  return `${new URL(site).host.replace(':', '-')}-${memberId}`;
}

/** The member RUSH at `site` knows `token` as, {id, login}; false when it knows it no more; null when it cannot be reached. */
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
 * top of its data folder. They become that member's connection, as RUSH says whose the sign-in
 * is; a sign-in RUSH knows no more is dropped with them, and so is one to a site other than
 * config.site_url, which is never asked. One whose site cannot be reached stops the install:
 * nothing is moved while it cannot be told whose they are.
 */
export async function adoptLegacy(data, config, {member = memberOf} = {}) {
  const credentials = path.join(data, 'runner-credentials.json');
  if (!fs.existsSync(credentials)) return null;
  const {site, token} = JSON.parse(fs.readFileSync(credentials, 'utf8'));
  const known = new URL(site).origin === new URL(config.site_url).origin && await member(site, token);
  if (known === null) throw new Error(`could not reach ${site} to tell whose connection this computer has. Run this again once it can be reached.`);
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
 * of its member at `site`, after adopting an install from before connections (adoptLegacy): its
 * id. Another member's connection is left as it is.
 */
export async function addConnection(data, config, site, session, options) {
  const {session: token, member} = session;
  if (!/^[A-Za-z0-9._-]+$/.test(String(token ?? ''))) throw new Error(`${site} gave no valid session`);
  if (!member?.login || !/^[A-Za-z0-9-]+$/.test(member.login)) throw new Error(`${site} named no GitHub login for this member`);
  await adoptLegacy(data, config, options);
  const id = connectionId(site, member.id);
  const folder = path.join(data, 'connections', id);
  fs.mkdirSync(folder, {recursive: true, mode: 0o700});
  writeConnection(folder, {site, member, token});
  return id;
}

const log = (message, connection) => console.log(`${new Date().toISOString()} ${connection ? `[${connection}] ` : ''}${message}`);

/** KEY=VALUE lines, as scripts/db/postgres.mjs's parseEnv reads RUSH's .env. */
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

/**
 * Whether `value` is a server's address: http or https, a host, and no credentials, query or
 * fragment (as NanoAgent's PUT /v1/keys checks it again), so it holds nothing secret.
 */
export function isServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
    && !url.username && !url.password && !value.includes('?') && !value.includes('#');
}

/**
 * Each provider's key in `settings`, set or not, and how it begins and ends: never its value. A
 * server's address is no secret, so it is the whole address.
 */
export function keyStatus(settings) {
  return PROVIDER_KEYS.map(([env, label]) => {
    const value = settings[env] || null;
    return {env, label, set: value !== null, hint: value && (SERVER_URLS.includes(env) ? value : keyHint(value))};
  });
}

/** The provider keys in `settings`, with a value. */
export function providerKeys(settings) {
  return Object.fromEntries(PROVIDER_KEYS.map(([env]) => [env, settings[env]]).filter(([, value]) => value));
}

/**
 * Keep `requested` ({NAME: key, or null to remove it}) in the settings `file`, readable only by this
 * user, beside the keys it holds; an empty value, or one with spaces, is refused, and so is a
 * server's address that is not one (isServerUrl). A server's address changed without its key
 * removes the key, so that no change of address alone sends it anywhere else. The changes kept.
 */
export function writeKeys(file, requested) {
  const changes = {...requested};
  for (const [url, key] of Object.entries(SERVER_KEYS)) {
    if (url in changes && !(key in changes)) changes[key] = null;
  }
  const keys = Object.fromEntries(Object.entries(readSettings(file)).filter(([name]) => isProviderKey(name)));
  for (const [name, value] of Object.entries(changes)) {
    if (!isProviderKey(name)) throw new Error(`${name} is not a key RUSH Lab holds`);
    if (value === null) {
      delete keys[name];
      continue;
    }
    const key = String(value).trim();
    if (!key || /\s/.test(key)) throw new Error(`${name} must be one key, without spaces`);
    if (SERVER_URLS.includes(name) && !isServerUrl(key)) {
      throw new Error(`${name} must be an http:// or https:// address, without credentials, query or fragment`);
    }
    keys[name] = key;
  }
  const contents = Object.keys(keys).sort().map(name => `${name}=${keys[name]}\n`).join('');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, contents, {mode: 0o600});
  return changes;
}

/**
 * What every service sees: the system basics, the bundled runtimes and git first on PATH (on Windows
 * then the system's PATH, as the bundled git is the only one a plugin's sandbox can run), and the folder uv
 * installs Python into, the data folder's python/. NanoAgent's plugin sandbox lets plugins, and its
 * own helpers there, read that folder whole (nanoagent.plugin.sandbox), so every link uv makes in it
 * resolves inside the sandbox too.
 */
export function systemEnv(env, bin, data) {
  const system = Object.fromEntries(SYSTEM_ENV.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  const PATH = WINDOWS ? [bin, path.join(bin, '..', 'git', 'cmd'), env.PATH].join(';') : `${bin}:${path.join(bin, '..', 'git', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return {...system, PATH, UV_PYTHON_INSTALL_DIR: path.join(data, 'python')};
}

/**
 * Where a connection's plugins are installed. Windows opens no path of 260 characters or more, and a
 * plugin's environment holds files 120 deep (jsonschema_specifications' vocabularies), which the
 * connection's folder name alone leaves no room for: there they are in a short folder of their own.
 */
export function installsFolder(data, connection, windows = WINDOWS) {
  if (!windows) return path.join(connection, 'nanoagent-installs');
  return path.join(data, 'installs', crypto.createHash('sha256').update(path.basename(connection)).digest('hex').slice(0, 12));
}

/**
 * How NanoAgent starts for a connection, in the bundle's `nanoagent` folder: its own folders in the
 * connection's (its plugins' installs aside, installsFolder), the uv cache the install's, with the
 * member's `keys` and its bearer `token`.
 */
export function nanoagentCommand({nanoagent, data, connection, port, sandbox, system, keys, token}) {
  const python = venvPython(nanoagent);
  return {
    program: python,
    args: [
      '-I', '-m', 'nanoagent', 'web',
      'web_cfg=deploy/railway/nanoagent.yaml',
      'host=127.0.0.1',
      `port=${port}`,
      // RUSH's marketplace is anyone's, and this is the member's own computer: every plugin runs confined.
      `sandbox=${sandbox}`,
      // The member's runs choose any model their keys reach, and settings of their own.
      'run_models=true',
      // The member watches their own runs think, on their own keys.
      'include_reasoning=true',
      `workspaces=${JSON.stringify(path.join(connection, 'agent-workspaces'))}`,
      `installs=${JSON.stringify(installsFolder(data, connection))}`,
      `uv_cache=${JSON.stringify(path.join(data, 'nanoagent-uv-cache'))}`,
      // Plugins run on the Python NanoAgent runs on; its environment holds no PATH to find `python` on.
      `plugin_python=${JSON.stringify(python)}`,
    ],
    // The keys are all NanoAgent is given of the settings.
    env: {...system, ...keys, NANOAGENT_API_TOKEN: token},
  };
}

/**
 * The folder of `member`'s files ({id, login}) in `root`, ~/<files folder>/: named for their login,
 * and known by their id (.mochi/member.json), so a folder made under a login they had before is
 * renamed for the one they have now rather than downloaded again. Throws when the name is another's.
 */
export function memberFiles(root, member) {
  const folder = path.join(root, member.login);
  const ownerOf = name => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, name, '.mochi', 'member.json'), 'utf8')).id;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  fs.mkdirSync(root, {recursive: true});
  const taken = fs.existsSync(folder);
  if (taken && ![null, member.id].includes(ownerOf(member.login))) throw new Error(`${folder} holds another member's files`);
  const before = fs.readdirSync(root).find(name => name !== member.login && ownerOf(name) === member.id);
  if (before) {
    if (taken) throw new Error(`@${member.login}'s files are in ${path.join(root, before)}, and ${folder} is taken`);
    fs.renameSync(path.join(root, before), folder);
  }
  fs.mkdirSync(path.join(folder, '.mochi'), {recursive: true});
  fs.writeFileSync(path.join(folder, '.mochi', 'member.json'), `${JSON.stringify({id: member.id})}\n`);
  return folder;
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

/** Kill `pid` and every process it started: Windows has no signals, and a venv's python.exe starts the interpreter as its child. */
const killTree = pid => new Promise(resolve => {
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true}).on('close', resolve).on('error', resolve);
});

const describeExit = ({code, signal}) => (signal ? `signal: ${signal}` : `exit status: ${code}`);

/** This build's folder (mochi-lab/), its config.json, and the data folder: the app installs its files into <data>/app/<stamp>/. */
function installation() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const data = path.resolve(root, '..', '..', '..');
  if (path.basename(data) !== config.label) throw new Error(`${config.product_name} is installed as ${config.label}, not in ${data}`);
  return {root, config, data};
}

async function main() {
  const {root, config, data} = installation();
  const platform = PLATFORMS[process.platform];
  if (!platform) {
    throw new Error(`${config.product_name} runs on macOS and Windows, where plugins run in a sandbox; this is ${process.platform}.`);
  }
  const bin = path.join(root, 'bin');
  const nanoagent = path.join(root, 'nanoagent');
  const connectionsFolder = path.join(data, 'connections');
  /** Open `page` in the member's browser; when that cannot be done, the log has the page. */
  const openPage = page => {
    const [program, ...args] = platform.open();
    spawn(program, [...args, page], {stdio: 'ignore', windowsHide: true}).on('error', error => log(`could not open ${page}: ${error.message}`));
  };
  // Every service this has running, of every connection: one `pid<TAB>program` line each.
  const pidFile = path.join(data, 'services.pid');
  // There while any connection's relay has a request going.
  const busyFile = path.join(data, 'busy');
  // What this is doing to set the computer up, which the app's window shows (desktop/src-tauri/src/setup.rs):
  // {stage, error}, `stage` python, nanoagent or connect, `error` why it stopped there, or null.
  const setupFile = path.join(data, 'setup.json');
  const setupStage = (stage, error = null) => fs.writeFileSync(setupFile, JSON.stringify({stage, error}));
  const system = systemEnv(process.env, bin, data);
  // The connections, by id: {id, folder, site, login, installed, services, state, stage, restartAt, relayStdin, token, port, requests}.
  const connections = new Map();
  let stopping = false;

  /** Stop the services a previous run left behind: each recorded process still running the program it was started with. */
  async function stopLeftovers() {
    if (!fs.existsSync(pidFile)) return;
    for (const line of fs.readFileSync(pidFile, 'utf8').split('\n')) {
      const [pid, program] = line.split('\t');
      if (!program) continue;
      const command = await new Promise(resolve => {
        const ps = WINDOWS
          ? spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true})
          : spawn('/bin/ps', ['-p', pid, '-o', 'command='], {stdio: ['ignore', 'pipe', 'ignore']});
        let out = '';
        ps.stdout.on('data', chunk => { out += chunk; });
        ps.on('close', () => resolve(out));
      });
      // tasklist names the program's file only, in quotes.
      const running = WINDOWS ? command.toLowerCase().startsWith(`"${path.basename(program).toLowerCase()}"`) : command.startsWith(program);
      if (!running) continue;
      log(`Stopping ${program} (${pid}), left running before`);
      if (WINDOWS) {
        await killTree(pid);
        continue;
      }
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
    const child = spawn(program, args, {cwd, env, stdio: [piped ? 'pipe' : 'ignore', piped ? 'pipe' : fd, fd], windowsHide: true});
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

  /** The last first: SIGTERM so each shuts down cleanly, SIGKILL after STOP_TIMEOUT_MS; on Windows, killed with its tree. */
  async function stopServices(services) {
    while (services.length) {
      const service = services.pop();
      if (service.exited) continue;
      if (WINDOWS) await killTree(service.child.pid);
      else service.child.kill('SIGTERM');
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
    fs.rmSync(busyFile, {force: true});
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

  /** Stop what a previous run left, write the app's command, and make NanoAgent's environment, which every connection shares. */
  async function prepare() {
    log(`${config.product_name} ${fs.readFileSync(path.join(root, 'stamp'), 'utf8').trim()}`);
    fs.mkdirSync(connectionsFolder, {recursive: true, mode: 0o700});
    fs.mkdirSync(path.join(data, 'logs'), {recursive: true});
    await stopLeftovers();
    removeOtherSites(data, config);
    const {shell} = os.userInfo();
    // Not awaited: the member's shell may take a while to say its PATH, and NanoAgent need not wait for it.
    installCommand({home: os.homedir(), root, config, shell, windows: WINDOWS, readPath: () => memberPath(shell)});
    fs.rmSync(busyFile, {force: true});
    log('Preparing NanoAgent\'s Python environment (the first start downloads Python)…');
    setupStage('python');
    // Only NanoAgent's dependencies, as the bundled uv.lock pins them: NanoAgent itself is its
    // package in site/, which nanoagent.pth puts on the environment's path.
    const services = [];
    const uv = startService(services, 'uv sync', path.join(bin, exe('uv')), [
      'sync', '--frozen', '--no-dev', '--no-install-project', '--extra', 'web', '--managed-python', '--python', config.python_version,
    ], {cwd: nanoagent, env: system, logFile: path.join(data, 'logs', 'uv-sync.log')});
    await uv.done;
    if (uv.exited.error || uv.exited.code !== 0) {
      const message = uv.exited.error ? exitMessage(uv) : `uv sync failed (${describeExit(uv.exited)}).\n\n${tail(uv.logFile)}`;
      setupStage('python', message);
      throw new Error(message);
    }
    const sitePackages = WINDOWS
      ? path.join(nanoagent, '.venv', 'Lib', 'site-packages')
      : path.join(nanoagent, '.venv', 'lib', `python${config.python_version}`, 'site-packages');
    try {
      fs.writeFileSync(path.join(sitePackages, 'nanoagent.pth'), `${path.join(nanoagent, 'site')}\n`);
    } catch (error) {
      const message = `could not add NanoAgent to its environment: ${error.message}`;
      setupStage('python', message);
      throw new Error(message);
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
        log('Connected again; restarting.', id);
        await stopConnection(connection);
        connection = null;
      }
      if (!connection) {
        connection = {id, folder: path.join(connectionsFolder, id), installed, services: [], state: 'starting', stage: 'nanoagent'};
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
    countRequests(connection, 0);
  }

  /** The connection's relay has `count` requests going. */
  function countRequests(connection, count) {
    connection.requests = count;
    markBusy();
  }

  /** `busy` is there while any relay has a request going. */
  function markBusy() {
    if ([...connections.values()].some(each => each.requests > 0)) fs.writeFileSync(busyFile, '');
    else fs.rmSync(busyFile, {force: true});
  }

  /**
   * A connection ends: failed, it starts again after RESTART_MS; replaced, it waits to be connected
   * again. `message` says why; one stopped on purpose ends with nothing to say.
   */
  async function endConnection(connection, replaced, message) {
    if (connection.state !== 'running' && connection.state !== 'starting') return;
    connection.state = replaced ? 'replaced' : 'failed';
    connection.restartAt = Date.now() + RESTART_MS;
    if (!replaced) setupStage(connection.stage, message);
    log(replaced ? 'Another computer took this member\'s runs; stopping until connected again.' : `${message}\nStarting again in ${RESTART_MS / 1000}s.`, connection.id);
    connection.relayStdin = null;
    connection.token = null;
    await stopServices(connection.services);
    countRequests(connection, 0);
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
      Object.assign(connection, {site, login: member.login, settingsFile, port: await freePort()});
      log(`Starting NanoAgent for @${member.login} on ${site}…`, id);
      connection.stage = 'nanoagent';
      setupStage(connection.stage);
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
      connection.stage = 'connect';
      setupStage(connection.stage);
      const files = memberFiles(path.join(os.homedir(), config.files_folder), member);
      const relay = startService(services, 'The relay', path.join(bin, exe('node')), ['relay.mjs'], {
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

  /** Keep `changes` for the connection, hand what it kept to its NanoAgent, and tell its relay which keys are set now. */
  async function applyKeys(connection, changes) {
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)
      || !Object.values(changes).every(value => value === null || typeof value === 'string')) {
      throw new Error('changes must be {NAME: key or null}');
    }
    const kept = writeKeys(connection.settingsFile, changes);
    if (!connection.token) throw new Error('NanoAgent is not running');
    const answer = await nanoagentRequest(connection.port, 'PUT', '/v1/keys', connection.token, JSON.stringify({changes: kept}));
    if (!answer) throw new Error('NanoAgent did not answer');
    if (answer.status !== 200) throw new Error(`NanoAgent refused the keys (${answer.status}): ${answer.body}`);
    tellRelay(connection, {keys: keyStatus(readSettings(connection.settingsFile))});
  }

  /**
   * Read a relay's events (relay.mjs) into its log: open its sign-in page, and the site once it is
   * connected after that, and apply the keys RUSH sends, answering on its stdin. A keys event is
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
      if (event.event === 'requests') return countRequests(connection, event.count);
      if (event.event !== 'keys') fs.appendFileSync(relay.fd, `${line}\n`);
      if (event.event === 'sign-in') {
        signingIn = true;
        // The device page says it is RUSH Lab asking (src/pages/device).
        const page = `${event.url}&client=desktop`;
        log(`Sign in to RUSH, then approve this computer (code ${event.code}): ${page}`, id);
        openPage(page);
      } else if (event.event === 'connected') {
        log(`Connected to ${site}`, id);
        if (!signingIn) return;
        signingIn = false;
        // The device page says RUSH opens next; with no key yet, straight to where one is added.
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

/**
 * The app's command for the build at `root`, in the member's `home`: {file, text}, the script
 * ~/.local/bin/<command> (on Windows <command>.cmd) runs the bundled node on this file with, which
 * says so when that build is gone.
 */
export function commandLauncher({home, root, config, windows}) {
  const {join} = windows ? path.win32 : path.posix;
  const node = join(root, 'bin', windows ? 'node.exe' : 'node');
  const labMjs = join(root, 'runner', 'lab.mjs');
  const written = `Written by ${config.product_name} at each start, for the build it runs (src/runner/lab.mjs).`;
  const gone = `${config.product_name} is not set up here: open ${config.product_name}, which writes ${config.command} again`;
  if (windows) {
    return {
      file: join(home, '.local', 'bin', `${config.command}.cmd`),
      text: `@echo off\r\nrem ${written}\r\nif not exist "${node}" (\r\n  echo ${gone} 1>&2\r\n  exit /b 1\r\n)\r\n"${node}" "${labMjs}" rushlab %*\r\nexit /b %errorlevel%\r\n`,
    };
  }
  // One word of sh each: Application Support has a space.
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  return {
    file: join(home, '.local', 'bin', config.command),
    text: `#!/bin/sh\n# ${written}\n[ -e ${quote(node)} ] || { echo ${quote(gone)} >&2; exit 1; }\nexec ${quote(node)} ${quote(labMjs)} rushlab "$@"\n`,
  };
}

/** Whether `folder` is one of the folders in `PATH`, as Windows compares them when `windows`. */
export function onPath(folder, PATH, windows) {
  const {delimiter, resolve} = windows ? path.win32 : path.posix;
  const name = entry => (windows ? resolve(entry).toLowerCase() : resolve(entry));
  return PATH.split(delimiter).filter(Boolean).some(entry => name(entry) === name(folder));
}

/** How the member puts ~/.local/bin on their terminal's PATH, for their login `shell`. */
export function pathAdvice(shell, windows) {
  if (windows) return 'run this in PowerShell: [Environment]::SetEnvironmentVariable(\'Path\', "$env:USERPROFILE\\.local\\bin;" + [Environment]::GetEnvironmentVariable(\'Path\', \'User\'), \'User\')';
  const name = path.basename(shell);
  if (name === 'fish') return 'run this: fish_add_path ~/.local/bin';
  const file = {zsh: '~/.zshrc', bash: '~/.bash_profile'}[name] ?? `${name}'s startup file`;
  return `add this line to ${file}: export PATH="$HOME/.local/bin:$PATH"`;
}

/**
 * The PATH the member's terminal has: on macOS their login `shell`'s once their startup files have
 * run, as this app's own is launchd's; on Windows this process's, as Explorer gives every program.
 */
function memberPath(shell) {
  if (WINDOWS) return Promise.resolve(process.env.PATH ?? '');
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-ilc', 'printf "\\n%s%s" RUSH_LAB_PATH= "$PATH"'], {stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000});
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      // Its startup files may print anything before it.
      const at = out.lastIndexOf('RUSH_LAB_PATH=');
      if (at < 0) reject(new Error(`${shell} printed no PATH (${describeExit({code, signal})})`));
      else resolve(out.slice(at + 'RUSH_LAB_PATH='.length));
    });
  });
}

/**
 * Write the app's command for the build at `root` (commandLauncher), and log whether the member's
 * terminal finds it, as `readPath()` (memberPath) gives its PATH, and if not, how to make it.
 */
export async function installCommand({home, root, config, shell, windows, readPath}) {
  const {file, text} = commandLauncher({home, root, config, windows});
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    // Whole or not at all, as a terminal may be running it.
    fs.writeFileSync(`${file}.partial`, text);
    fs.chmodSync(`${file}.partial`, 0o755);
    fs.renameSync(`${file}.partial`, file);
  } catch (error) {
    log(`could not write ${config.command} (${file}): ${error.message}`);
    return;
  }
  let PATH;
  try {
    PATH = await readPath();
  } catch (error) {
    log(`Wrote ${file}, but could not tell whether your terminal finds ${config.command}: ${error.message}`);
    return;
  }
  if (onPath(path.dirname(file), PATH, windows)) log(`Wrote ${file}: run ${config.command} in a terminal`);
  else log(`Wrote ${file}, but ${path.dirname(file)} is not on your terminal's PATH, so ${config.command} is not found there: ${pathAdvice(shell, windows)}, then open a new terminal window`);
}

/** How the app's command is used, for the app `config`. */
function usage({command, product_name: name}) {
  const lines = [
    ['new <id>', 'make the plugin <id> in ./<id>, for an AI CLI there to design with you'],
    ['nanoagent <args>', `run ${name}'s NanoAgent`],
    ['uv <args>', `run ${name}'s uv`],
  ];
  const width = Math.max(...lines.map(([words]) => words.length)) + command.length + 4;
  return `usage:\n${lines.map(([words, says]) => `  ${`${command} ${words}`.padEnd(width)}${says}`).join('\n')}`;
}

/** The app's command's arguments (usage): {new: id}; {run: nanoagent or uv, args}; null for anything else. */
export function rushlabCommand(args) {
  if (args[0] === 'new') return args.length === 2 ? {new: args[1]} : null;
  if (args[0] === 'nanoagent' || args[0] === 'uv') return {run: args[0], args: args.slice(1)};
  return null;
}

/**
 * How the build at `root` runs its `nanoagent` or `uv` with `args` for the member, in their `env`:
 * NanoAgent with the bundled runtimes and git first on its PATH, for `plugin new`'s uv and git.
 */
export function bundledCommand(root, run, args, env) {
  const bin = path.join(root, 'bin');
  if (run === 'uv') return {program: path.join(bin, exe('uv')), args, env};
  // Windows' environment names it Path.
  const name = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const PATH = [bin, path.join(root, 'git', WINDOWS ? 'cmd' : 'bin'), env[name]].filter(Boolean).join(path.delimiter);
  return {program: venvPython(path.join(root, 'nanoagent')), args: ['-I', '-m', 'nanoagent', ...args], env: {...env, [name]: PATH}};
}

// What `<command> new` writes the preface and the skill into, one for each AI CLI.
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

/**
 * `<command> new <id>`: make the plugin `id` in `cwd`/<id> with the build at `root`'s NanoAgent
 * (`plugin new`), then its AGENTS.md, CLAUDE.md and GEMINI.md: runner/plugin-project/project.md
 * for it, then the publish-plugin `skill`. A folder already there is refused; one it could not
 * finish is removed. The folder.
 */
export async function newPlugin({root, config, skill}, id, cwd) {
  if (!PLUGIN_ID.test(id)) throw new Error(`${id} is not a plugin id: lowercase letters and numbers, in words joined by single hyphens`);
  const folder = path.resolve(cwd, id);
  if (fs.existsSync(folder)) throw new Error(`${folder} already exists`);
  const preface = fs.readFileSync(path.join(root, 'runner', 'plugin-project', 'project.md'), 'utf8');
  const text = `${preface.replaceAll('{{id}}', id).replaceAll('{{command}}', config.command)}\n${fs.readFileSync(skill, 'utf8')}`;
  const {program, args, env} = bundledCommand(root, 'nanoagent', ['plugin', 'new', folder], process.env);
  try {
    const made = await runPython(program, args, env);
    if (made.code !== 0) throw new Error(made.stderr.trim() || `nanoagent plugin new failed (exit status: ${made.code})`);
    for (const name of PROJECT_FILES) fs.writeFileSync(path.join(folder, name), text);
  } catch (error) {
    const partial = fs.existsSync(folder);
    fs.rmSync(folder, {recursive: true, force: true});
    throw new Error(`Could not make the plugin ${id}${partial ? `, so ${folder} is removed` : ''}: ${error.message}`);
  }
  return folder;
}

/** Run `program args` in this terminal: its exit code. */
function runHere({program, args, env}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {stdio: 'inherit', env});
    child.once('error', error => reject(new Error(`could not run ${program}: ${error.message}`)));
    child.once('close', code => resolve(code ?? 1));
  });
}

/** Run `python args`, in `env`: its exit code and what it printed. */
function runPython(python, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
  });
}

/**
 * The app's command (usage), for the build at `root` with its `config`, and the publish-plugin
 * `skill` `new` writes. Its exit code: 0 once done, 2 for a command it does not know; `nanoagent`
 * and `uv` exit as they do.
 */
export async function rushlab(args, {root, config, skill}) {
  const command = rushlabCommand(args);
  if (!command) {
    console.error(usage(config));
    return 2;
  }
  if ('new' in command) {
    const folder = await newPlugin({root, config, skill}, command.new, process.cwd());
    console.log(`Made the plugin ${command.new} in ${folder}. In it, start your AI CLI (claude, codex, gemini, …) to design it with you.`);
    return 0;
  }
  return runHere(bundledCommand(root, command.run, command.args, process.env));
}

// As a URL the path is escaped ("Application Support" is Application%20Support), so compare paths.
// The app asks it, with a connect link's token in LAB_TOKEN:
//   lab.mjs member <site>              the member the link is for, as JSON, and the site it names
//   lab.mjs connect <data> <site>      keep a session for them as their connection, and print its id
// and the app's command (commandLauncher), in the member's terminal:
//   lab.mjs rushlab <args>             rushlab (usage)
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const config = () => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
  const token = process.env.LAB_TOKEN ?? '';
  const [command, ...args] = process.argv.slice(2);
  if (command === 'rushlab') {
    // A member reads it in their terminal: what went wrong, without the log's time.
    Promise.resolve().then(() => {
      const app = installation();
      return rushlab(args, {...app, skill: path.join(app.root, 'runner', 'plugin-project', 'SKILL.md')});
    }).then(code => { process.exitCode = code; }, error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } else {
    const run = command === 'member' ? async () => {
      const site = connectableSite(config(), args[0]);
      console.log(JSON.stringify({site, member: await linkMember(site, token)}));
    } : command === 'connect' ? async () => {
      const app = config();
      const site = connectableSite(app, args[1]);
      console.log(await addConnection(args[0], app, site, await linkSession(site, token)));
    } : main;
    run().catch(error => {
      console.error(`${new Date().toISOString()} ${error.message}`);
      process.exitCode = 1;
    });
  }
}
