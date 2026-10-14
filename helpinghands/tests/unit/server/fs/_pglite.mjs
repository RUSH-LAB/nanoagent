/**
 * A migrated in-process PostgreSQL for file system tests, queried as a
 * restricted runtime role so row-level security applies exactly as it does in
 * production.
 *
 * Members: alice owns workspace `lab`, bob edits it, vic views it; carol owns
 * workspace `other`.
 */
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * `client.query` as pg answers it, over a PGlite database: a query without
 * parameters is a simple query, which may hold several statements and answers
 * with each one's result, or the one result of a single statement.
 */
const pgResult = result => ({...result, rowCount: result.affectedRows ?? result.rows.length});
export const pgQuery = db => (sql, params) => (params === undefined
  ? db.exec(sql).then(results => (results.length === 1 ? pgResult(results[0]) : results.map(pgResult)))
  : db.query(sql, params).then(pgResult));

const migrationsDir = path.join(root, 'src/server/postgres/migrations');

/** Apply the migration `name` to `db`, as the tables' owner. */
export async function applyMigration(db, name) {
  await db.exec(await readFile(path.join(migrationsDir, name), 'utf8'));
}

/** The database with every migration applied, or only those named before `until`. */
export async function migratedDatabase({until} = {}) {
  const db = new PGlite();
  for (const name of (await readdir(migrationsDir)).filter(file => file.endsWith('.sql') && (!until || file < until)).sort()) {
    await applyMigration(db, name);
  }
  await db.exec(`
    create role mochi_runtime;
    grant usage on schema public to mochi_runtime;
    grant select, insert, update, delete on all tables in schema public to mochi_runtime;
    grant usage, select on all sequences in schema public to mochi_runtime;
    grant execute on all functions in schema public to mochi_runtime;
    insert into app_user(id, email, display_name, email_verified, created_at, updated_at) values
      ('alice', 'alice@example.invalid', 'Alice', true, now(), now()),
      ('bob', 'bob@example.invalid', 'Bob', true, now(), now()),
      ('vic', 'vic@example.invalid', 'Vic', true, now(), now()),
      ('carol', 'carol@example.invalid', 'Carol', true, now(), now());
    insert into workspace(id, name, slug, status, created_by) values
      ('lab', 'Lab', 'lab', 'active', 'alice'),
      ('other', 'Other', 'other', 'active', 'carol');
    insert into workspace_member(id, workspace_id, user_id, role) values
      ('m1', 'lab', 'alice', 'owner'), ('m2', 'lab', 'bob', 'editor'),
      ('m3', 'lab', 'vic', 'viewer'), ('m4', 'other', 'carol', 'owner');
  `);
  // One connection, used as the runtime role. pg's pool returns a client per
  // transaction; PGlite has one session, which the tests use in turn.
  const pool = {
    async connect() {
      await db.exec('set role mochi_runtime');
      return {
        query: pgQuery(db),
        release: () => { db.exec('reset role'); },
      };
    },
  };
  return {db, pool};
}

export const as = (userId, workspaceId = 'lab') => ({userId, workspaceId});
