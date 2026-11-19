#!/usr/bin/env node
/**
 * npm run local: the whole local RUSH in one go, from a fresh checkout or an old one alike.
 *
 *   1. This checkout's packages (npm ci).
 *   2. .env: made from .env.example when there is none; the GitHub sign-in values it lacks are taken
 *      from Railway's production service (scripts/README.md says what they are). Values .env has
 *      are kept.
 *   3. PostgreSQL 18: Homebrew's postgresql@18 on macOS, installed when missing.
 *   4. The local database (npm run db:setup), filled with a fresh copy of production's
 *      (npm run db:pull). Production is only read.
 *   5. npm start, and once its API and site answer, RUSH Lab Dev built from this checkout, installed beside
 *      RUSH Lab and opened (npm run desktop:dev). RUSH Lab and rush-lab.org are not touched.
 *
 * It then keeps running as npm start does; Ctrl+C stops it. Run it again whenever the checkout or
 * production changed: each step makes its part as it should be. The local site must not be running
 * already, as the copy of production replaces the local database.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = path.join(root, '.env');
// The site, the API and the local NanoAgent (scripts/dev/start-local.mjs).
const PORTS = [3000, 3001, 8787];
// What GitHub sign-in needs, which npm start refuses to start without.
const SIGN_IN = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ROOT_GITHUB_LOGIN'];
const API = 'http://127.0.0.1:3001/api/signup-policy';
const START_TIMEOUT_MS = 10 * 60_000;

function step(title) {
  console.log(`\n== ${title}`);
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', shell: process.platform === 'win32'});
  if (result.error?.code === 'ENOENT') throw new Error(`${command} is not installed or is not on PATH`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
}

function portInUse(port) {
  return new Promise(resolve => {
    const socket = net.connect({port, host: '127.0.0.1'});
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Railway's production values of `names`; never printed. */
function railwayValues(names) {
  const result = spawnSync('railway', ['variables', '--service', 'mochi-lab', '--environment', 'production', '--kv'],
    {cwd: root, encoding: 'utf8', shell: process.platform === 'win32'});
  if (result.error?.code === 'ENOENT') throw new Error('railway is not installed or is not on PATH: install it and run railway login');
  if (result.status !== 0) throw new Error(`railway variables failed (run railway login): ${result.stderr.trim()}`);
  const values = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0 && names.includes(line.slice(0, at))) values[line.slice(0, at)] = line.slice(at + 1);
  }
  const missing = names.filter(name => !values[name]);
  if (missing.length) throw new Error(`Railway's mochi-lab production service has no ${missing.join(', ')}`);
  return values;
}

async function signInValues() {
  if (!fs.existsSync(envFile)) run(process.execPath, ['scripts/dev/consolidate-env.mjs', '--initialize']);
  const {parseEnv, writeLocalEnvironment} = await import('../db/postgres.mjs');
  const lacking = SIGN_IN.filter(name => !parseEnv(fs.readFileSync(envFile, 'utf8'))[name]);
  if (!lacking.length) {
    console.log(`.env has ${SIGN_IN.join(', ')}`);
    return;
  }
  writeLocalEnvironment({values: railwayValues(lacking)});
  console.log(`Set ${lacking.join(', ')} in .env from Railway's production service`);
}

async function postgres() {
  const {pgBin} = await import('../db/local.mjs');
  try {
    console.log(`PostgreSQL 18: ${pgBin('pg_ctl')}`);
  } catch (error) {
    if (process.platform !== 'darwin') throw error;
    run('brew', ['install', 'postgresql@18']);
  }
}

/** Whether `url` answers: `ok` asks for a success, else any reply will do. */
async function answers(url, ok) {
  try {
    const reply = await fetch(url, {signal: AbortSignal.timeout(5_000)});
    return !ok || reply.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve once npm start's API answers and its site answers at RUSH Lab Dev's own address (the one
 * desktop-dev.mjs checks); reject when npm start exits first or takes too long.
 */
async function started(site) {
  const {readConfig} = await import('../../desktop/scripts/config.mjs');
  const address = readConfig({dev: true}).site_url;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    const exited = () => reject(new Error('npm start exited before its API and site answered'));
    site.once('exit', exited);
    const poll = async () => {
      if ((await answers(API, true)) && (await answers(address, false))) {
        site.off('exit', exited);
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error(`npm start's API and site (${address}) did not answer within ${START_TIMEOUT_MS / 60_000} minutes`));
      } else {
        setTimeout(poll, 1000);
      }
    };
    poll();
  });
}

async function main() {
  step('The local site must not be running');
  const busy = [];
  for (const port of PORTS) if (await portInUse(port)) busy.push(port);
  if (busy.length) throw new Error(`Port${busy.length === 1 ? '' : 's'} ${busy.join(', ')} in use: stop the running local site (npm start) first`);
  console.log(`Ports ${PORTS.join(', ')} are free`);

  step("This checkout's packages");
  run('npm', ['ci', '--no-audit', '--no-fund']);

  step('.env');
  await signInValues();

  step('PostgreSQL 18');
  await postgres();

  step("The local database, a fresh copy of production's");
  run(process.execPath, ['scripts/db/postgres.mjs', 'setup']);
  run(process.execPath, ['scripts/db/postgres.mjs', 'pull']);

  step('npm start');
  // In this terminal's process group, so Ctrl+C stops it with this script.
  const site = spawn(process.execPath, ['scripts/dev/start-local.mjs'], {cwd: root, stdio: 'inherit'});
  const stopped = new Promise(resolve => site.once('exit', code => resolve(code ?? 1)));
  try {
    await started(site);
    step('RUSH Lab Dev');
    run(process.execPath, ['scripts/dev/desktop-dev.mjs']);
  } catch (error) {
    site.kill('SIGTERM');
    await stopped;
    throw error;
  }
  console.log('\nRUSH Lab Dev is open on the local site. Ctrl+C stops the local site.');
  process.exitCode = await stopped;
}

main().catch(error => {
  console.error(`\nnpm run local failed: ${error.message}`);
  process.exitCode = 1;
});
