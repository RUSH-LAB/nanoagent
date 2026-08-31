#!/usr/bin/env node
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POSTGRES_ENV_FILE = path.join(root, '.env.postgres.local');
const NEON_ENV_FILE = path.join(root, '.env.local');

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

function loadPostgresEnvironment() {
  const file = readEnvFile(POSTGRES_ENV_FILE);
  const env = {...file, ...process.env};
  if (!env.DATABASE_URL || !env.DATABASE_MIGRATION_URL) {
    throw new Error('Run npm run db:postgres:setup before using PostgreSQL commands');
  }
  return env;
}

function directEndpoint(hostname) {
  const labels = hostname.split('.');
  labels[0] = labels[0].replace(/-pooler$/, '');
  return labels.join('.');
}

function pooledEndpoint(hostname) {
  const labels = hostname.split('.');
  if (!labels[0].endsWith('-pooler')) labels[0] += '-pooler';
  return labels.join('.');
}

function parsePostgresUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid PostgreSQL connection URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !url.username || !url.password || !url.pathname.slice(1)) {
    throw new Error(`${label} must include a PostgreSQL username, password, host, and database`);
  }
  return url;
}

function serializeEnv(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

/** Derive Mochi's restricted pooled runtime URL from one Neon owner URL. */
export function prepareNeonEnvironment({
  envFile = POSTGRES_ENV_FILE,
  pulledEnvFile = NEON_ENV_FILE,
  randomBytes = crypto.randomBytes,
} = {}) {
  const values = readEnvFile(envFile);
  const pulled = readEnvFile(pulledEnvFile);
  const source = pulled.DATABASE_URL_UNPOOLED
    || values.DATABASE_MIGRATION_URL
    || pulled.DATABASE_URL;
  if (!source) {
    throw new Error('Run neon link or neon env pull before PostgreSQL setup');
  }

  const ownerUrl = parsePostgresUrl(source, 'The Neon owner URL');
  ownerUrl.hostname = directEndpoint(ownerUrl.hostname);
  const existingRuntimeUrl = values.DATABASE_URL
    ? parsePostgresUrl(values.DATABASE_URL, 'The existing DATABASE_URL')
    : null;
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = existingRuntimeUrl?.username || 'mochi_runtime';
  runtimeUrl.password = existingRuntimeUrl?.password || randomBytes(24).toString('hex');
  runtimeUrl.hostname = pooledEndpoint(ownerUrl.hostname);

  const output = {
    ...values,
    DATABASE_MIGRATION_URL: ownerUrl.toString(),
    DATABASE_URL: runtimeUrl.toString(),
    PG_SSL: values.PG_SSL || 'require',
    PG_SSL_REJECT_UNAUTHORIZED: values.PG_SSL_REJECT_UNAUTHORIZED || 'true',
    PG_DRIVER: values.PG_DRIVER || 'neon-serverless',
    ENABLE_AUTH: values.ENABLE_AUTH || 'true',
    DEV_AUTOLOGIN: values.DEV_AUTOLOGIN || 'false',
    BETTER_AUTH_SECRET: values.BETTER_AUTH_SECRET || randomBytes(32).toString('hex'),
  };
  const temporaryFile = `${envFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, serializeEnv(output), {mode: 0o600});
    fs.renameSync(temporaryFile, envFile);
    fs.chmodSync(envFile, 0o600);
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
  console.log(`Prepared ${path.basename(envFile)} with a direct migration URL and pooled runtime URL.`);
  return output;
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
  bootstrap() {
    run(process.execPath, ['scripts/db/bootstrap-runtime-role.mjs'], loadPostgresEnvironment());
  },
  prepare() {
    prepareNeonEnvironment();
  },
  setup() {
    prepareNeonEnvironment();
    const env = loadPostgresEnvironment();
    run(process.execPath, ['scripts/db/bootstrap-runtime-role.mjs'], env);
    run(process.execPath, ['scripts/db/apply-schema.mjs'], env);
  },
  migrate() {
    run(process.execPath, ['scripts/db/apply-schema.mjs'], loadPostgresEnvironment());
  },
  verify() {
    run(process.execPath, ['tests/integration/postgres/rls-acceptance.mjs'], loadPostgresEnvironment());
  },
  test() {
    const env = loadPostgresEnvironment();
    run(process.execPath, ['tests/integration/postgres/rls-acceptance.mjs'], env);
    run(process.execPath, ['tests/integration/postgres/runtime-acceptance.mjs'], env);
  },
  serve() {
    run(process.execPath, ['src/server/index.js'], loadPostgresEnvironment());
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
