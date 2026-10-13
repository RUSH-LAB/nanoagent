import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {migratedDatabase} from './fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresWorkspaceContextResolver} = require('../../../src/server/postgres/workspace-context.js');

describe('a workspace context from PostgreSQL', () => {
  let db;
  let contexts;
  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    contexts = createPostgresWorkspaceContextResolver({pool: database.pool});
  });
  after(() => db?.close());

  it('is a member\'s membership, under row-level security', async () => {
    assert.deepEqual({...await contexts.byId('bob', 'lab')}, {userId: 'bob', workspaceId: 'lab', membershipId: 'm2', role: 'editor'});
    assert.equal(await contexts.byId('carol', 'lab'), null);
    assert.equal(await contexts.byId('bob', 'missing'), null);
    assert.equal(await contexts.byId('bob', "lab' or '1'='1"), null);
  });

  it('is nothing for a workspace that is not active', async () => {
    await db.exec("update workspace set status = 'archived' where id = 'other'");
    assert.equal(await contexts.byId('carol', 'other'), null);
  });
});
