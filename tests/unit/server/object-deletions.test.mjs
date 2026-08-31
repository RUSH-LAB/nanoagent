import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {createObjectDeletionQueue, drainObjectDeletions} = require('../../../src/server/object-deletions.js');

function setup() {
  const db = new Database(':memory:');
  db.exec(`create table object_deletion (
    id text primary key, workspaceId text not null, objectKey text not null unique,
    requestedAt text not null, attempts integer not null default 0, lastError text
  )`);
  return {db, queue: createObjectDeletionQueue({db})};
}

describe('durable object deletion outbox', () => {
  it('removes an object and its completed queue row', async () => {
    const {db, queue} = setup();
    db.prepare('insert into object_deletion values (?, ?, ?, ?, 0, null)')
      .run('q1', 'w1', 'w1/assets/a/file.pdf', new Date().toISOString());
    const removed = [];
    const result = await drainObjectDeletions(queue, {
      remove: async key => { removed.push(key); return true; },
      stat: async () => null,
    });
    assert.deepEqual(result, {processed: 1, removed: 1, failed: 0});
    assert.deepEqual(removed, ['w1/assets/a/file.pdf']);
    assert.equal(db.prepare('select count(*) as n from object_deletion').get().n, 0);
    db.close();
  });

  it('treats an already missing object as successfully cleaned', async () => {
    const {db, queue} = setup();
    db.prepare('insert into object_deletion values (?, ?, ?, ?, 0, null)')
      .run('q1', 'w1', 'gone', new Date().toISOString());
    const result = await drainObjectDeletions(queue, {remove: async () => false, stat: async () => null});
    assert.equal(result.removed, 1);
    assert.equal(db.prepare('select count(*) as n from object_deletion').get().n, 0);
    db.close();
  });

  it('keeps failures for a later retry', async () => {
    const {db, queue} = setup();
    db.prepare('insert into object_deletion values (?, ?, ?, ?, 0, null)')
      .run('q1', 'w1', 'still-there', new Date().toISOString());
    const result = await drainObjectDeletions(queue, {
      remove: async () => false,
      stat: async () => ({size: 10}),
    });
    assert.equal(result.failed, 1);
    const row = db.prepare('select attempts, lastError from object_deletion').get();
    assert.equal(row.attempts, 1);
    assert.match(row.lastError, /refused deletion/);
    db.close();
  });
});
