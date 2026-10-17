/**
 * The local database: a PostgreSQL 18 cluster in var/postgres (git-ignored),
 * like production's server and locale, on 127.0.0.1 only. `npm start` migrates
 * it as its owner and runs on it as mochi_runtime, as Railway does production's.
 * Its data is whatever `npm run db:pull` last copied from production, and what
 * was done locally since; `npm run db:push` sends one workspace of it back.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LOCAL_DIR = path.join(root, 'var', 'postgres');
const DATA = path.join(LOCAL_DIR, 'data');
const PORT = 55432;
const DATABASE = 'mochi';
// Production's role names, which its schema names too (migration 0011's owner policies).
const OWNER = 'neondb_owner';
const RUNTIME = 'mochi_runtime';

export const LOCAL_OWNER_URL = `postgres://${OWNER}@127.0.0.1:${PORT}/${DATABASE}`;
export const LOCAL_RUNTIME_URL = `postgres://${RUNTIME}@127.0.0.1:${PORT}/${DATABASE}`;

/** A PostgreSQL 18 program from Homebrew's postgresql@18, or from the Windows installer's folder. */
export function pgBin(name) {
  if (process.platform === 'win32') {
    const program = path.join(process.env.ProgramFiles, 'PostgreSQL', '18', 'bin', `${name}.exe`);
    if (!fs.existsSync(program)) throw new Error(`${name} from PostgreSQL 18 is missing: ${program}`);
    return program;
  }
  const prefix = spawnSync('brew', ['--prefix', 'postgresql@18'], {encoding: 'utf8'});
  const program = prefix.status === 0 ? path.join(prefix.stdout.trim(), 'bin', name) : null;
  if (!program || !fs.existsSync(program)) {
    throw new Error(`${name} from PostgreSQL 18 is missing: brew install postgresql@18`);
  }
  return program;
}

function run(program, args, {env = process.env, quiet = false} = {}) {
  const result = spawnSync(pgBin(program), args, {env, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'inherit']});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited with status ${result.status}${quiet ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout ?? '';
}

/** Run `sql` on the local cluster as its owner, in `database`. */
export function localSql(sql, database = DATABASE) {
  return run('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', OWNER, '-d', database,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {quiet: true});
}

export const localExists = () => fs.existsSync(path.join(DATA, 'PG_VERSION'));

/** Make the cluster, its database and its runtime role, once. */
export function createLocal() {
  if (localExists()) return false;
  fs.mkdirSync(LOCAL_DIR, {recursive: true});
  run('initdb', ['-D', DATA, '-U', OWNER, '--auth=trust', '-E', 'UTF8',
    '--locale-provider=builtin', '--builtin-locale=C.UTF-8'], {quiet: true});
  startLocal();
  localSql(`create database ${DATABASE}`, 'postgres');
  localSql(`create role ${RUNTIME} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls`, 'postgres');
  return true;
}

/** Start the cluster unless it is running. It keeps running after npm start exits. */
export function startLocal() {
  if (!localExists()) throw new Error('There is no local database: run npm run db:setup');
  const status = spawnSync(pgBin('pg_ctl'), ['-D', DATA, 'status'], {stdio: 'ignore'});
  if (status.status === 0) return;
  // No pipes: the server inherits them and, on Windows, keeps them open, so spawnSync would never return.
  const started = spawnSync(pgBin('pg_ctl'), ['-D', DATA, '-l', path.join(LOCAL_DIR, 'server.log'), '-w',
    '-o', `-p ${PORT} -c listen_addresses=127.0.0.1 -k ${DATA}`, 'start'], {stdio: 'ignore'});
  if (started.error) throw started.error;
  if (started.status !== 0) throw new Error(`pg_ctl exited with status ${started.status}: see ${path.join(LOCAL_DIR, 'server.log')}`);
}

/** Replace the local database with an empty one, without even its public schema, which a restore makes. */
export function recreateLocalDatabase() {
  localSql(`drop database if exists ${DATABASE} with (force)`, 'postgres');
  localSql(`create database ${DATABASE}`, 'postgres');
  localSql('drop schema public');
}

export {run as runPg, PORT as LOCAL_PORT};
