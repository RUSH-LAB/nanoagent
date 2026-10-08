import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const {createPostgresDocuments} = require('../../../src/server/postgres/documents.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('PostgreSQL delete refuses a document that changed since the caller last saw it', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const migrationsDir = path.join(root, 'src/server/postgres/migrations');
  for (const name of (await readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(path.join(migrationsDir, name), 'utf8'));
  }
  await db.exec(`
    insert into app_user(id, email, display_name, email_verified, created_at, updated_at)
      values ('ada', 'ada@example.invalid', 'Ada', true, now(), now());
    insert into workspace(id, name, slug, status, created_by) values ('lab', 'Lab', 'lab', 'active', 'ada');
    insert into workspace_member(id, workspace_id, user_id, role) values ('m', 'lab', 'ada', 'owner');
    insert into document(id, workspace_id, path, markdown, created_by, updated_at)
      values ('d', 'lab', 'a.md', 'body', 'ada', '2026-10-07T12:00:00.000Z');
  `);
  const pool = {async connect() { return {query: (sql, params) => db.query(sql, params), release() {}}; }};
  const documents = createPostgresDocuments({pool});
  const scope = {userId: 'ada', workspaceId: 'lab'};

  await assert.rejects(
    () => documents.remove(scope, 'a.md', {expectedUpdatedAt: '2026-10-07T11:00:00.000Z'}),
    {code: 'document-conflict', status: 409},
  );
  assert.equal(await documents.remove(scope, 'a.md', {expectedUpdatedAt: '2026-10-07T12:00:00.000Z'}), true);
  assert.equal(await documents.get(scope, 'a.md'), undefined);
  assert.equal(await documents.remove(scope, 'a.md'), false);
});
