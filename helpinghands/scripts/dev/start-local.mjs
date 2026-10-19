#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {parseEnv} from '../db/postgres.mjs';
import {LOCAL_OWNER_URL, LOCAL_RUNTIME_URL, startLocal as startLocalDatabase} from '../db/local.mjs';
import {pulledAt} from '../db/sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localEnvFile = path.join(root, '.env');
const docusaurusCli = path.join(root, 'node_modules', '@docusaurus', 'core', 'bin', 'docusaurus.mjs');
const nanoagentPort = 8787;
const nanoagentStartupTimeoutMs = 30_000;

/**
 * The local server runs on the local database (scripts/db/local.mjs), which it
 * migrates as its owner and serves as the runtime role, as Railway does
 * production's. A database URL anywhere else would be another database, so
 * .env and the shell may hold none. It is the site RUSH Lab Dev serves, so its
 * links are that app's (MOCHI_LOCAL_SITE, src/server/lab-app.js).
 */
export function environmentFor({base = process.env, envFile = localEnvFile} = {}) {
  if (!fs.existsSync(envFile)) throw new Error('Run npm run db:setup before npm start');
  const file = parseEnv(fs.readFileSync(envFile, 'utf8'));
  const env = {...file, ...base, EDITOR_PORT: base.EDITOR_PORT || '3001'};
  const named = ['DATABASE_URL', 'DATABASE_MIGRATION_URL'].filter(key => env[key]);
  if (named.length) throw new Error(`${named.join(' and ')} must not be set: npm start runs on the local database. Run npm run db:setup`);
  return {...env, DATABASE_URL: LOCAL_RUNTIME_URL, DATABASE_MIGRATION_URL: LOCAL_OWNER_URL, PG_SSL: 'disable', MOCHI_LOCAL_SITE: '1'};
}

export function portIsAvailable(port, host = 'localhost') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(port, host, () => probe.close(error => error ? reject(error) : resolve(true)));
  });
}

export function usesLocalNanoAgent(env = process.env) {
  return !env.NANOAGENT_URL?.trim();
}

export function nanoagentProjectFrom(env = process.env) {
  return path.resolve(env.NANOAGENT_PROJECT_DIR || path.join(root, '..', 'nanoagent'));
}

/**
 * The plugin packages NanoAgent publishes as apps: none, as NanoAgent ships no plugin, unless
 * NANOAGENT_PLUGINS_DIR names a folder of plugins, each directory in it with a manifest.
 */
export function nanoagentPluginsFrom(env = process.env) {
  if (!env.NANOAGENT_PLUGINS_DIR) return [];
  const pluginsRoot = path.resolve(env.NANOAGENT_PLUGINS_DIR);
  if (!fs.existsSync(pluginsRoot)) {
    throw new Error(`NANOAGENT_PLUGINS_DIR not found: ${pluginsRoot}`);
  }
  const plugins = fs.readdirSync(pluginsRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(pluginsRoot, entry.name, 'nanoagent.yaml')))
    .map(entry => path.join(pluginsRoot, entry.name))
    .sort();
  if (!plugins.length) throw new Error(`NANOAGENT_PLUGINS_DIR holds no plugin (a folder with nanoagent.yaml): ${pluginsRoot}`);
  return plugins;
}

/**
 * The local service is the Railway configuration bound to loopback, so local
 * development and production run the same agent definition and profiles.
 */
export function nanoagentWebArgs(env = process.env) {
  return [
    'run', '--extra', 'web', 'python', '-m', 'nanoagent', 'web',
    'web_cfg=deploy/railway/nanoagent.yaml',
    'host=127.0.0.1',
    `port=${nanoagentPort}`,
    'api_token=null',
    // Plugins run as you, like any program you start; the server runs them in bwrap.
    'sandbox=none',
    // The plugins in NANOAGENT_PLUGINS_DIR, in the marketplace (/marketplace) for workspaces to add.
    `packages=${JSON.stringify(nanoagentPluginsFrom(env))}`,
    `workspaces=${JSON.stringify(path.join(root, 'var', 'agent-workspaces'))}`,
    `installs=${JSON.stringify(path.join(root, 'var', 'nanoagent-installs'))}`,
    `uv_cache=${JSON.stringify(path.join(root, 'var', 'nanoagent-uv-cache'))}`,
  ];
}

function nanoagentUrl(env) {
  return env.NANOAGENT_URL?.trim() || `http://127.0.0.1:${nanoagentPort}`;
}

export async function waitForNanoAgent(env, child = null, {
  fetchImpl = fetch,
  timeoutMs = nanoagentStartupTimeoutMs,
  intervalMs = 200,
} = {}) {
  const url = nanoagentUrl(env).replace(/\/$/, '');
  const headers = env.NANOAGENT_API_TOKEN
    ? {Authorization: `Bearer ${env.NANOAGENT_API_TOKEN}`}
    : {};
  const deadline = Date.now() + timeoutMs;
  let lastError = 'service did not answer';

  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`NanoAgent exited during startup with status ${child.exitCode}`);
    }
    try {
      const health = await fetchImpl(`${url}/health`, {headers});
      if (!health.ok) throw new Error(`health returned ${health.status}`);
      const healthBody = await health.json();
      if (healthBody?.service !== 'nanoagent') throw new Error('health response identified the wrong service');

      const response = await fetchImpl(`${url}/v1/profiles`, {headers});
      if (!response.ok) throw new Error(`profiles returned ${response.status}`);
      const catalog = await response.json();
      const profiles = Array.isArray(catalog?.profiles) ? catalog.profiles : [];
      const defaultProfile = profiles.find(profile => profile.id === catalog.defaultProfile);
      if (!defaultProfile) throw new Error('default profile is missing from the profile catalog');
      if (defaultProfile.available === false) {
        throw new Error(defaultProfile.unavailableReason || `default profile ${defaultProfile.id} is unavailable`);
      }
      return {url, profile: defaultProfile};
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`NanoAgent failed its startup check at ${url}: ${lastError}`);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    // On Windows npm is npm.cmd, which Node runs only through a shell.
    const child = spawn(command, args, command === 'npm' && process.platform === 'win32' ? {...options, shell: true} : options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal || `status ${code}`}`));
    });
  });
}

const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * How an npm checkout's installed packages differ from what it declares: package.json against
 * package-lock.json, and package-lock.json against the copy npm writes into node_modules on every
 * install. Empty when they agree. A lockfile package that is optional and absent was skipped for
 * this platform, not forgotten.
 */
export function npmInstallProblems(projectRoot) {
  const read = file => JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
  const installedFile = path.join(projectRoot, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(installedFile)) return ['node_modules is not installed'];
  const manifest = read('package.json');
  const lock = read('package-lock.json');
  const installed = read('node_modules/.package-lock.json').packages;
  const problems = [];
  for (const field of MANIFEST_FIELDS) {
    const declared = manifest[field] ?? {};
    const locked = lock.packages[''][field] ?? {};
    for (const name of new Set([...Object.keys(declared), ...Object.keys(locked)])) {
      if (declared[name] !== locked[name]) problems.push(`package-lock.json is out of date for ${name}`);
    }
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key) continue;
    const present = installed[key];
    if (!present && !entry.optional) problems.push(`${key} is not installed`);
    else if (present && present.version !== entry.version) {
      problems.push(`${key} is ${present.version}, the lockfile has ${entry.version}`);
    }
  }
  for (const key of Object.keys(installed)) {
    if (!lock.packages[key]) problems.push(`${key} is installed but not in the lockfile`);
  }
  return problems;
}

/**
 * Before any service runs, RUSH's node_modules and NanoAgent's .venv are installed from their
 * lockfiles, so a pull or branch switch never leaves them behind. A lockfile that no longer agrees
 * with its manifest stops startup: npm ci and uv sync --locked refuse it rather than resolve again.
 */
async function syncDependencies(env, nanoagentRoot) {
  const problems = npmInstallProblems(root);
  if (problems.length) {
    console.log(`Installing RUSH's node_modules from package-lock.json:\n  ${problems.join('\n  ')}`);
    await run('npm', ['ci'], {cwd: root, env, stdio: 'inherit'});
  }
  if (usesLocalNanoAgent(env)) {
    await run('uv', ['sync', '--locked', '--inexact', '--extra', 'web'], {cwd: nanoagentRoot, env, stdio: 'inherit'});
  }
}

async function preparePiRunner(env, nanoagentRoot) {
  const piRunnerRoot = path.join(nanoagentRoot, 'js', 'pi-runner');
  const piRunnerEntry = path.join(piRunnerRoot, 'dist', 'index.js');
  const dependencies = path.join(piRunnerRoot, 'node_modules', '@earendil-works', 'pi-agent-core');
  const inputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'src/index.ts']
    .map(file => path.join(piRunnerRoot, file));
  const builtAt = fs.existsSync(piRunnerEntry) ? fs.statSync(piRunnerEntry).mtimeMs : 0;
  const stale = inputs.some(file => fs.statSync(file).mtimeMs > builtAt);
  const options = {cwd: piRunnerRoot, env, stdio: 'inherit'};

  if (!fs.existsSync(dependencies)) {
    console.log('Preparing bundled PI runner...');
    await run('npm', ['ci', '--include=dev'], options);
  } else if (stale) {
    console.log('Rebuilding bundled PI runner...');
    await run('npm', ['run', 'build'], options);
  }
  if (!fs.existsSync(piRunnerEntry)) throw new Error('PI runner build did not produce dist/index.js');
}

function validatedPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function signalTree(child, signal) {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
}

export async function startLocal(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error(`Unknown startup option: ${argv[0]}`);
  const localEnv = fs.existsSync(localEnvFile)
    ? parseEnv(fs.readFileSync(localEnvFile, 'utf8'))
    : {};
  const env = environmentFor({base: {...localEnv, ...process.env}});
  const nanoagentRoot = nanoagentProjectFrom(env);
  if (usesLocalNanoAgent(env) && !fs.existsSync(path.join(nanoagentRoot, 'pyproject.toml'))) {
    throw new Error(`NanoAgent checkout not found at ${nanoagentRoot}. Clone it beside RUSH or set NANOAGENT_PROJECT_DIR.`);
  }
  const apiPort = validatedPort(env.EDITOR_PORT, 'EDITOR_PORT');
  const sitePort = validatedPort(env.SITE_PORT || 3000, 'SITE_PORT');
  if (apiPort === sitePort) {
    throw new Error('EDITOR_PORT and SITE_PORT must be different');
  }
  // The site proxies /api to EDITOR_PORT, and the API trusts requests from SITE_PORT.
  env.SITE_PORT = String(sitePort);
  const ports = [apiPort, sitePort];
  if (usesLocalNanoAgent(env)) ports.push(nanoagentPort);
  const checks = await Promise.all(ports.map(port => portIsAvailable(port)));
  const occupied = ports.filter((_, index) => !checks[index]);
  if (occupied.length) {
    throw new Error(`Port${occupied.length === 1 ? '' : 's'} ${occupied.join(', ')} already in use; stop the existing local service first`);
  }
  // After the port check, so a running npm start never has its packages replaced under it.
  await syncDependencies(env, nanoagentRoot);
  startLocalDatabase();
  // The site's banner says how old the local copy is (src/theme/Root.js).
  env.MOCHI_PULLED_AT = (await pulledAt())?.toISOString() ?? '';
  if (usesLocalNanoAgent(env)) await preparePiRunner(env, nanoagentRoot);
  // Keep every child in the terminal's process group. Ctrl+C then reaches the
  // agent, API, site, and this supervisor together, so npm cannot leave a
  // detached development service behind.
  const options = cwd => ({cwd, env, stdio: 'inherit'});
  const processes = [];
  if (usesLocalNanoAgent(env)) {
    const process = {
      name: 'NanoAgent',
      child: spawn('uv', nanoagentWebArgs(env), options(nanoagentRoot)),
    };
    processes.push(process);
    try {
      const ready = await waitForNanoAgent(env, process.child);
      console.log(`NanoAgent ready: ${ready.profile.id} (${ready.profile.model})`);
    } catch (error) {
      signalTree(process.child, 'SIGTERM');
      throw error;
    }
  } else if (env.NANOAGENT_URL !== 'off') {
    const ready = await waitForNanoAgent(env);
    console.log(`NanoAgent ready: ${ready.profile.id} (${ready.profile.model})`);
  }
  // Restarts when the server's code changes, so the API is never older than the checkout the site and the apps are built from.
  const api = spawn(process.execPath, ['--watch-path=src/server', '--watch-preserve-output', 'src/server/index.js'], options(root));
  processes.push(
    {name: 'API', child: api},
    {name: 'site', child: spawn(process.execPath, [docusaurusCli, 'start', '--no-open', '--host', '127.0.0.1', '--port', String(sitePort)], options(root))},
  );
  let stopping = false;

  function stop(exitCode, signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    for (const {child} of processes) signalTree(child, signal);
    const force = setTimeout(() => {
      for (const {child} of processes) signalTree(child, 'SIGKILL');
    }, 5_000);
    force.unref?.();
    Promise.all(processes.map(({child}) => child.exitCode === null
      ? new Promise(resolve => child.once('exit', resolve))
      : Promise.resolve()))
      .then(() => {
        clearTimeout(force);
        process.exit(exitCode);
      });
  }

  function watch({name, child}) {
    child.once('error', error => {
      console.error(`${name} startup failed: ${error.message}`);
      stop(1);
    });
    child.once('exit', (code, signal) => {
      const interrupted = signal === 'SIGINT' || signal === 'SIGTERM';
      if (!stopping) stop(interrupted || code === 0 ? 0 : 1);
    });
  }

  processes.forEach(watch);
  process.once('SIGINT', () => stop(0, 'SIGINT'));
  process.once('SIGTERM', () => stop(0, 'SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLocal().catch(error => {
    console.error(`Local startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
