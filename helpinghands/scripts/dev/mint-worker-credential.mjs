#!/usr/bin/env node
/**
 * Mints npm start's benchmark worker credential for the root account (ROOT_GITHUB_LOGIN, the member who tests on the local site)
 * and prints its token. The credentials this script minted before are revoked, so one start leaves one live. The local server must
 * have started first: it migrates the database and provisions the root account. Needs the server's environment (DATABASE_URL).
 */
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const database = require('../../src/server/postgres/database');
const {benchmarkWorker} = require('../../src/server/postgres/services');

const NAME = 'npm start';

try {
  await database.ready;
  const login = process.env.ROOT_GITHUB_LOGIN?.trim();
  if (!login) throw new Error('ROOT_GITHUB_LOGIN is not set');
  const root = (await database.migrationPool.query('select id from app_user where lower(github_login) = lower($1)', [login])).rows[0];
  if (!root) throw new Error(`the local database has no user for GitHub login ${login}`);
  const userId = root.id;
  for (const credential of await benchmarkWorker.listCredentials(userId)) {
    if (credential.name === NAME && !credential.revoked_at) await benchmarkWorker.revokeCredential(userId, credential.credential_id);
  }
  process.stdout.write(`${(await benchmarkWorker.mintCredential(userId, NAME)).token}\n`);
} finally {
  await database.close();
}
