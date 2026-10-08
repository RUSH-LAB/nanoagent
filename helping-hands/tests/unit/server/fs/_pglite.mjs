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

export async function migratedDatabase() {
  const db = new PGlite();
  const migrationsDir = path.join(root, 'src/server/postgres/migrations');
  for (const name of (await readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(path.join(migrationsDir, name), 'utf8'));
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
        query: (sql, params) => db.query(sql, params).then(result => ({...result, rowCount: result.affectedRows ?? result.rows.length})),
        release: () => { db.exec('reset role'); },
      };
    },
  };
  return {db, pool};
}

export const as = (userId, workspaceId = 'lab') => ({userId, workspaceId});
