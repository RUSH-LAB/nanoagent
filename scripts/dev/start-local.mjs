#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {parseEnv} from '../db/postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localEnvFile = path.join(root, '.env.openrouter.local');
const postgresEnvFile = path.join(root, '.env.postgres.local');
const docusaurusCli = path.join(root, 'node_modules', '@docusaurus', 'core', 'bin', 'docusaurus.mjs');
const nanoagentRoot = path.join(root, 'services', 'nanoagent');
const nanoagentPort = 8787;
const piRunnerRoot = path.join(nanoagentRoot, 'packages', 'pi-runner');
const piRunnerEntry = path.join(piRunnerRoot, 'dist', 'index.js');

export function modeFrom(argv) {
  const postgres = argv.includes('--postgres');
  const noAuth = argv.includes('--no-auth');
  if (postgres && noAuth) throw new Error('--postgres and --no-auth cannot be combined');
  return postgres ? 'postgres' : noAuth ? 'no-auth' : 'sqlite';
}

export function environmentFor(mode, {base = process.env, envFile = postgresEnvFile} = {}) {
  if (mode === 'postgres' && !fs.existsSync(envFile)) {
    throw new Error('Run npm run db:postgres:setup before npm run start:postgres');
  }
  const file = mode === 'postgres'
    ? parseEnv(fs.readFileSync(envFile, 'utf8'))
    : {};
  const env = {...file, ...base, EDITOR_PORT: base.EDITOR_PORT || '3001'};
  if (mode === 'postgres') {
    if (!env.DATABASE_URL || !env.DATABASE_MIGRATION_URL) {
      throw new Error('Run npm run db:postgres:setup before npm run start:postgres');
    }
    env.ENABLE_AUTH = 'true';
    env.DEV_AUTOLOGIN = 'false';
    env.POSTGRES_ROOT_LOGIN = 'true';
  } else {
    delete env.DATABASE_URL;
    delete env.DATABASE_MIGRATION_URL;
    env.ENABLE_AUTH = mode === 'sqlite' ? 'true' : 'false';
    env.DEV_AUTOLOGIN = mode === 'sqlite' ? 'true' : 'false';
  }
  return env;
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

export function usesBundledNanoAgent(env = process.env) {
  return !env.NANOAGENT_URL?.trim();
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal || `status ${code}`}`));
    });
  });
}

async function preparePiRunner(env) {
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
  const mode = modeFrom(argv);
  const localEnv = fs.existsSync(localEnvFile)
    ? parseEnv(fs.readFileSync(localEnvFile, 'utf8'))
    : {};
  const env = environmentFor(mode, {base: {...localEnv, ...process.env}});
  if (usesBundledNanoAgent(env) && !env.OPENROUTER_API_KEY?.trim()) {
    throw new Error('Bundled NanoAgent requires OPENROUTER_API_KEY. Add it to .env.openrouter.local, then run npm start again.');
  }
  if (usesBundledNanoAgent(env)) await preparePiRunner(env);
  const apiPort = validatedPort(env.EDITOR_PORT, 'EDITOR_PORT');
  const sitePort = validatedPort(env.SITE_PORT || 3000, 'SITE_PORT');
  if (apiPort === sitePort) {
    throw new Error('EDITOR_PORT and SITE_PORT must be different');
  }
  const ports = [apiPort, sitePort];
  if (usesBundledNanoAgent(env)) ports.push(nanoagentPort);
  const checks = await Promise.all(ports.map(port => portIsAvailable(port)));
  const occupied = ports.filter((_, index) => !checks[index]);
  if (occupied.length) {
    throw new Error(`Port${occupied.length === 1 ? '' : 's'} ${occupied.join(', ')} already in use; stop the existing local service first`);
  }
  // Keep every child in the terminal's process group. Ctrl+C then reaches the
  // agent, API, site, and this supervisor together, so npm cannot leave a
  // detached development service behind.
  const options = cwd => ({cwd, env, stdio: 'inherit'});
  const processes = [
    {name: 'API', child: spawn(process.execPath, ['src/server/index.js'], options(root))},
    {name: 'site', child: spawn(process.execPath, [docusaurusCli, 'start', '--no-open', '--port', String(sitePort)], options(root))},
  ];
  if (usesBundledNanoAgent(env)) {
    processes.unshift({
      name: 'NanoAgent',
      child: spawn('uv', [
        'run', '--extra', 'web', 'python', '-m', 'nanoagent', 'web',
        'web_cfg=configs/web_openrouter.yaml',
      ], options(nanoagentRoot)),
    });
  }
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

  for (const {name, child} of processes) {
    child.once('error', error => {
      console.error(`${name} startup failed: ${error.message}`);
      stop(1);
    });
    child.once('exit', (code, signal) => {
      const interrupted = signal === 'SIGINT' || signal === 'SIGTERM';
      if (!stopping) stop(interrupted || code === 0 ? 0 : 1);
    });
  }
  process.once('SIGINT', () => stop(0, 'SIGINT'));
  process.once('SIGTERM', () => stop(0, 'SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLocal().catch(error => {
    console.error(`Local startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
