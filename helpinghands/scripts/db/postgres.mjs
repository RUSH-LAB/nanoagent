#!/usr/bin/env node
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createLocal} from './local.mjs';
import {pull, push} from './sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_ENV_FILE = path.join(root, '.env');

export function parseEnv(source) {
  const result = {};
  for (const original of String(source ?? '').split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid environment line: ${original}`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function readEnvFile(file) {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

/** Single-quote every value, so a shell can `source` the file: URLs hold `&` and `?`. */
export function serializeEnv(values) {
  return `${Object.entries(values).map(([key, value]) => {
    if (String(value).includes("'")) throw new Error(`${key} holds a single quote, which .env cannot quote`);
    return `${key}='${value}'`;
  }).join('\n')}\n`;
}

// The database keys .env held when local npm start ran on production's database.
// The local database's connection comes from local.mjs, never from .env.
const DATABASE_KEYS = ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'PG_SSL', 'PG_SSL_REJECT_UNAUTHORIZED', 'PG_DRIVER'];

/**
 * Remove every database key from .env and set `values` in it, keeping the file's other values.
 */
export function writeLocalEnvironment({envFile = LOCAL_ENV_FILE, values = {}} = {}) {
  const output = {...readEnvFile(envFile), ...values};
  for (const key of DATABASE_KEYS) delete output[key];
  const temporaryFile = `${envFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, serializeEnv(output), {mode: 0o600});
    fs.renameSync(temporaryFile, envFile);
    fs.chmodSync(envFile, 0o600);
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
  return output;
}

/** Production's schema owner URL, read from Railway for one pull or push and never written down. */
function productionOwnerUrl() {
  const url = railwayVariables().DATABASE_MIGRATION_URL;
  if (!url) throw new Error("Railway's mochi-lab service has no DATABASE_MIGRATION_URL");
  return url;
}

function railwayVariables() {
  const result = spawnSync('railway', ['variables', '--service', 'mochi-lab', '--environment', 'production', '--kv'],
    // On Windows railway is npm's railway.cmd, which Node runs only through a shell.
    {cwd: root, encoding: 'utf8', shell: process.platform === 'win32'});
  if (result.error?.code === 'ENOENT') throw new Error('railway is not installed or is not on PATH');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`railway variables failed: ${result.stderr.trim()}`);
  const values = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0 && /^[A-Z_][A-Z0-9_]*$/.test(line.slice(0, at))) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

/** The acceptance tests create and delete rows, so they run only on a loopback database, as CI's. */
export function assertDisposableDatabase(env) {
  for (const key of ['DATABASE_URL', 'DATABASE_MIGRATION_URL']) {
    const host = env[key] && new URL(env[key]).hostname;
    if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`The acceptance tests run only on a loopback database, and ${key} is on ${host}`);
    }
  }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {cwd: root, env, stdio: 'inherit'});
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${command} is not installed or is not on PATH`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 1}`);
  }
}

/** Ask on the terminal for the workspace's slug, typed back, before a push replaces it on production. */
async function confirmPush(slug, {name, rows}) {
  if (!process.stdin.isTTY) throw new Error('db:push asks for confirmation, so it runs only in a terminal');
  console.log(`This replaces ${name} (${slug}) on rush-lab.org with your local copy:\n`);
  console.log(`  ${'table'.padEnd(30)} ${'local'.padStart(8)} ${'production'.padStart(11)}`);
  for (const row of rows) console.log(`  ${row.table.padEnd(30)} ${String(row.local).padStart(8)} ${String(row.production).padStart(11)}`);
  const terminal = readline.createInterface({input: process.stdin, output: process.stdout});
  const answer = await new Promise(resolve => terminal.question(`\nType ${slug} to push it: `, resolve));
  terminal.close();
  return answer.trim() === slug;
}

const commands = Object.freeze({
  setup() {
    // The OpenRouter account production gives members' keys from: npm start gives them from it too,
    // in a workspace of its own (src/server/openrouter-keys.js).
    const managementKey = railwayVariables().OPENROUTER_MANAGEMENT_KEY;
    if (!managementKey) throw new Error("Railway's mochi-lab service has no OPENROUTER_MANAGEMENT_KEY");
    writeLocalEnvironment({values: {OPENROUTER_MANAGEMENT_KEY: managementKey}});
    console.log(createLocal() ? 'Made the local database in var/postgres.' : 'The local database in var/postgres is already there.');
    console.log("Removed any database connection from .env, and set production's OPENROUTER_MANAGEMENT_KEY in it. Run npm run db:pull to copy production into the local database.");
  },
  async pull() {
    const {workspaces} = await pull({ownerUrl: productionOwnerUrl()});
    console.log(`Pulled production into the local database: ${workspaces} workspaces. Run npm start to apply this checkout's migrations to it.`);
  },
  async push(slug) {
    if (!slug) throw new Error('Name the workspace to push: npm run db:push -- <slug>');
    const pushed = await push({ownerUrl: productionOwnerUrl(), slug, confirm: changes => confirmPush(slug, changes)});
    console.log(pushed ? `Pushed ${pushed.name} to rush-lab.org.` : 'Nothing was pushed.');
  },
  test() {
    const env = {...process.env};
    if (!env.DATABASE_URL || !env.DATABASE_MIGRATION_URL) {
      throw new Error('The acceptance tests need DATABASE_URL and DATABASE_MIGRATION_URL for a loopback database');
    }
    assertDisposableDatabase(env);
    run(process.execPath, ['tests/integration/postgres/rls-acceptance.mjs'], env);
    run(process.execPath, ['tests/integration/postgres/runtime-acceptance.mjs'], env);
    run(process.execPath, ['tests/integration/postgres/tenancy-acceptance.mjs'], env);
  },
});

export async function main(command = process.argv[2], ...args) {
  if (!commands[command]) {
    console.error(`Usage: node scripts/db/postgres.mjs <${Object.keys(commands).join('|')}>`);
    process.exitCode = 2;
    return;
  }
  try {
    await commands[command](...args);
  } catch (error) {
    console.error(`PostgreSQL command failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(...process.argv.slice(2));
