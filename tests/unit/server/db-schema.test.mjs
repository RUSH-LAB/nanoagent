/**
 * The committed schema in server/migrations/ must match what the installed
 * Better Auth expects.
 *
 * This test exists because the drift is silent until a user tries to sign up.
 * The first version of 0001_auth.sql came from the standalone @better-auth/cli,
 * which is deprecated and was two minor versions behind the runtime; it omitted
 * `account.issuer`, and the only symptom was a 500 on sign-up reading "table
 * account has no column named issuer". getMigrations() asks the installed
 * version what it needs, so upgrading better-auth and forgetting the migration
 * now fails here instead of in production.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AUTH_PATH = require.resolve('../../../src/server/auth.js');
const DB_PATH = require.resolve('../../../src/server/db.js');

describe('server/migrations matches the installed better-auth', () => {
  let dir;
  let auth;
  let db;

  before(() => {
    // A fresh file, so the migrations under test are the only thing that has
    // ever touched this database.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-schema-'));
    const saved = process.env.DATABASE_FILE;
    process.env.DATABASE_FILE = path.join(dir, 'schema.db');
    delete require.cache[AUTH_PATH];
    delete require.cache[DB_PATH];
    try {
      ({db} = require('../../../src/server/db.js'));
      ({auth} = require('../../../src/server/auth.js'));
    } finally {
      if (saved === undefined) delete process.env.DATABASE_FILE;
      else process.env.DATABASE_FILE = saved;
      delete require.cache[AUTH_PATH];
      delete require.cache[DB_PATH];
    }
  });

  after(() => {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* already gone */ }
  });

  it('creates every table Better Auth expects, with no table left to add', async () => {
    const {getMigrations} = await import('better-auth/db/migration');
    const {toBeCreated} = await getMigrations(auth.options);
    assert.deepEqual(
      toBeCreated.map(t => t.table),
      [],
      'a table is missing from server/migrations: regenerate against an EMPTY ' +
      'database and add the delta as a new migration file',
    );
  });

  it('creates every column Better Auth expects, with no column left to add', async () => {
    const {getMigrations} = await import('better-auth/db/migration');
    const {toBeAdded} = await getMigrations(auth.options);
    assert.deepEqual(
      toBeAdded.map(t => `${t.table}.${Object.keys(t.fields).join(',')}`),
      [],
      'a column is missing from server/migrations',
    );
  });

  it('records every migration, so a second start is a no-op', () => {
    // Read the directory rather than naming the files: a new migration should
    // not have to remember to update this test, only to actually apply.
    const {MIGRATIONS_DIR} = require('../../../src/server/db.js');
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const applied = db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r => r.name);
    assert.deepEqual(applied, onDisk);
    assert.ok(onDisk.length > 0, 'there is at least one migration');
  });

  it('creates the role table, tied to the user table by foreign key', () => {
    const cols = db.prepare('PRAGMA table_info(user_role)').all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['addedAt', 'role', 'userId']);

    const fks = db.prepare('PRAGMA foreign_key_list(user_role)').all();
    assert.equal(fks.length, 1, 'exactly one foreign key');
    assert.equal(fks[0].table, 'user');
    // The cascade is the point: it is what makes an orphan role impossible,
    // which the JSON store it replaced could not prevent.
    assert.equal(fks[0].on_delete, 'CASCADE');
  });

  it('deletes a role along with its user', () => {
    db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
      .run('cascade-test', 'X', 'x@test.invalid', 0, 0, 0);
    db.prepare('INSERT INTO user_role (userId, role, addedAt) VALUES (?,?,?)')
      .run('cascade-test', 'owner', '2026-01-01T00:00:00.000Z');
    db.prepare('DELETE FROM "user" WHERE id = ?').run('cascade-test');
    const left = db.prepare('SELECT COUNT(*) AS n FROM user_role WHERE userId = ?').get('cascade-test').n;
    assert.equal(left, 0, 'the role went with the user');
  });

  it('has the tables the organization plugin needs', () => {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name),
    );
    for (const t of ['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation']) {
      assert.ok(tables.has(t), `missing table ${t}`);
    }
  });

  it('indexes member by userId and organizationId, which orgRoleFor looks up on', () => {
    const indexes = db.prepare('PRAGMA index_list(member)').all().map(r => r.name);
    assert.ok(indexes.includes('member_userId_idx'), 'member_userId_idx is missing');
    assert.ok(indexes.includes('member_organizationId_idx'), 'member_organizationId_idx is missing');
  });

  it('enforces foreign keys, so a membership cannot outlive its organization', () => {
    assert.equal(db.pragma('foreign_keys', {simple: true}), 1);
  });
});
