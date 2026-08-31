#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {parseEnv} from '../db/postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const postgresEnvFile = path.join(root, '.env.postgres.local');
const docusaurusCli = path.join(root, 'node_modules', '@docusaurus', 'core', 'bin', 'docusaurus.mjs');

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
  const env = environmentFor(mode);
  const apiPort = validatedPort(env.EDITOR_PORT, 'EDITOR_PORT');
  const sitePort = validatedPort(env.SITE_PORT || 3000, 'SITE_PORT');
  if (apiPort === sitePort) {
    throw new Error('EDITOR_PORT and SITE_PORT must be different');
  }
  const checks = await Promise.all([portIsAvailable(apiPort), portIsAvailable(sitePort)]);
  const occupied = [apiPort, sitePort].filter((_, index) => !checks[index]);
  if (occupied.length) {
    throw new Error(`Port${occupied.length === 1 ? '' : 's'} ${occupied.join(', ')} already in use; stop the existing local service first`);
  }
  // Keep both children in the terminal's process group. Ctrl+C then reaches
  // the API, the Docusaurus CLI, and this supervisor together, so npm cannot
  // exit while leaving a detached dev server behind.
  const options = {cwd: root, env, stdio: 'inherit'};
  const children = [
    spawn(process.execPath, ['src/server/index.js'], options),
    spawn(process.execPath, [docusaurusCli, 'start', '--no-open', '--port', String(sitePort)], options),
  ];
  let stopping = false;

  function stop(exitCode, signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    for (const child of children) signalTree(child, signal);
    const force = setTimeout(() => {
      for (const child of children) signalTree(child, 'SIGKILL');
    }, 5_000);
    force.unref?.();
    Promise.all(children.map(child => child.exitCode === null
      ? new Promise(resolve => child.once('exit', resolve))
      : Promise.resolve()))
      .then(() => {
        clearTimeout(force);
        process.exit(exitCode);
      });
  }

  for (const child of children) {
    child.once('error', error => {
      console.error(`Local ${mode} startup failed: ${error.message}`);
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
