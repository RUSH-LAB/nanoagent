import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {
  createObjectStorage, memoryObjectStorage, postgresObjectStorage, objectKeyWorkspace,
} = require('../../../src/server/object-storage.js');

function database() {
  const values = new Map();
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({sql, params});
      if (sql.startsWith('insert into object_blob')) {
        values.set(params[0], {body: Buffer.from(params[2]), contentType: params[3], size: params[4], etag: params[5]});
        return {rows: [], rowCount: 1};
      }
      if (sql.startsWith('select body from object_blob')) {
        const value = values.get(params[0]);
        return {rows: value ? [{body: Buffer.from(value.body)}] : [], rowCount: value ? 1 : 0};
      }
      if (sql.startsWith('select byte_size')) {
        const value = values.get(params[0]);
        return {rows: value ? [{size: value.size, etag: value.etag}] : [], rowCount: value ? 1 : 0};
      }
      if (sql.startsWith('delete from object_blob')) {
        return {rows: [], rowCount: values.delete(params[0]) ? 1 : 0};
      }
      return {rows: [], rowCount: 0};
    },
    release() {},
  };
  return {values, calls, pool: {connect: async () => client}};
}

describe('object storage', () => {
  it('uses an in-memory implementation outside PostgreSQL without writing files', async () => {
    const storage = memoryObjectStorage();
    await storage.put('workspace/assets/file.bin', Buffer.from('hello'));
    assert.equal((await storage.get('workspace/assets/file.bin')).toString(), 'hello');
    assert.equal((await storage.stat('workspace/assets/file.bin')).size, 5);
    assert.equal(await storage.remove('workspace/assets/file.bin'), true);
    assert.equal(await storage.get('workspace/assets/file.bin'), null);
  });

  it('stores and retrieves bytes through the PostgreSQL object table', async () => {
    const {pool, values, calls} = database();
    const storage = postgresObjectStorage({pool});
    const key = 'workspace/assets/file.pdf';
    await storage.put(key, Buffer.from('%PDF-test'), 'application/pdf');
    assert.equal(storage.provider, 'postgres');
    assert.equal(values.get(key).contentType, 'application/pdf');
    assert.equal((await storage.get(key)).toString(), '%PDF-test');
    assert.equal((await storage.stat(key)).size, 9);
    assert.equal(await storage.remove(key), true);
    assert.equal(await storage.get(key), null);
    assert.ok(calls.some(call => call.sql.includes("set_config('app.workspace_id'")));
  });

  it('rejects keys that cannot be scoped to one workspace', () => {
    for (const key of ['', '/absolute', '../escape', 'workspace/../escape', 'workspace\\escape']) {
      assert.throws(() => objectKeyWorkspace(key), /Invalid object key/);
    }
  });

  it('requires a PostgreSQL pool in production', () => {
    assert.throws(() => createObjectStorage({NODE_ENV: 'production'}), /requires PostgreSQL/);
    assert.equal(createObjectStorage({}, {}).provider, 'memory');
  });
});
