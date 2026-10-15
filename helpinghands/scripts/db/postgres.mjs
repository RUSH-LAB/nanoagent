#!/usr/bin/env node
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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

// The one database is production's. The local server reaches it as the runtime
// role, read from Railway, and never holds the schema owner's URL.
const RUNTIME_KEYS = ['DATABASE_URL', 'PG_SSL', 'PG_SSL_REJECT_UNAUTHORIZED'];

/** Write production's runtime connection into .env, keeping the file's other values. */
export function writeProductionEnvironment(railway, {envFile = LOCAL_ENV_FILE} = {}) {
  if (!railway.DATABASE_URL) throw new Error("Railway's mochi-lab service has no DATABASE_URL");
  if (new URL(railway.DATABASE_URL).username !== 'mochi_runtime') {
    throw new Error("Railway's DATABASE_URL is not the mochi_runtime role");
  }
  const output = {...readEnvFile(envFile)};
  for (const key of [...RUNTIME_KEYS, 'DATABASE_MIGRATION_URL', 'PG_DRIVER']) delete output[key];
  for (const key of RUNTIME_KEYS) if (railway[key]) output[key] = railway[key];
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

function railwayVariables() {
  const result = spawnSync('railway', ['variables', '--service', 'mochi-lab', '--environment', 'production', '--kv'],
    {cwd: root, encoding: 'utf8'});
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

const commands = Object.freeze({
  setup() {
    writeProductionEnvironment(railwayVariables());
    console.log("Wrote production's runtime database connection into .env.");
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

export function main(command = process.argv[2]) {
  if (!commands[command]) {
    console.error(`Usage: node scripts/db/postgres.mjs <${Object.keys(commands).join('|')}>`);
    process.exitCode = 2;
    return;
  }
  try {
    commands[command]();
  } catch (error) {
    console.error(`PostgreSQL command failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
