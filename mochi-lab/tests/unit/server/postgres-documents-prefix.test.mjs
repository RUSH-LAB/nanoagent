import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createPostgresDocuments} = require('../../../src/server/postgres/documents.js');

function recordingPool() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({sql, params});
      return {rows: /from document\b/.test(sql) ? [{path: 'posts/blog/a.md'}] : []};
    },
    release() {},
  };
  return {calls, pool: {async connect() { return client; }}};
}

test('PostgreSQL document lists filter a collection in SQL', async () => {
  const {calls, pool} = recordingPool();
  const documents = createPostgresDocuments({pool});
  const rows = await documents.snapshot({workspaceId: 'workspace-1', userId: 'user-1'}, {prefix: 'posts/blog'});
  const query = calls.find(call => /select .*markdown from document/s.test(call.sql));

  assert.deepEqual(rows, [{path: 'posts/blog/a.md'}]);
  assert.match(query.sql, /left\(path, char_length\(\$1\) \+ 1\)/);
  assert.deepEqual(query.params, ['posts/blog']);
});
