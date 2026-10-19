import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {applyMigration, as, migratedDatabase} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {createPostgresSessions} = require('../../../../src/server/postgres/sessions.js');

const MIGRATION = '0046_plugin_chat_files.sql';

describe('plugin chats as files', () => {
  it('writes each session\'s turns so far to a chat folder in its member\'s home, which the session then reads', async () => {
    const {db, pool} = await migratedDatabase({until: MIGRATION});
    const fs = createPostgresFs({pool});
    try {
      const turn = (prompt, graph) => ({prompt, answer: `re ${prompt}`, tools: [], activity: [], error: null, version: null, ...(graph ? {graph} : {})});
      await db.query(`
        insert into plugin_session(id, workspace_id, user_id, plugin_id, title, chat, created_at) values
          ('s1', 'lab', 'alice', 'echo', 'Find /tmp papers', $1, '2026-10-01T12:00:00Z'),
          ('s2', 'lab', 'alice', 'echo', 'Find /tmp papers', $2, '2026-10-01T15:00:00Z'),
          ('s3', 'lab', 'bob', 'echo', '', '[]', '2026-10-02T00:00:00Z')`,
      [JSON.stringify([turn('one', {nodes: [1]}), turn('two')]), JSON.stringify([turn('three')])]);

      await applyMigration(db, MIGRATION);

      const folder = 'home/alice/Chats/echo/2026-10-01 Find -tmp papers';
      const chat = JSON.parse((await fs.read(as('alice'), `${folder}/chat.json`)).body.toString());
      assert.deepEqual(chat, {session: 's1', plugin: 'echo', turns: [turn('one'), turn('two')]});
      assert.deepEqual(JSON.parse((await fs.read(as('alice'), `${folder}/turns/001/graph.json`)).body.toString()), {nodes: [1]});
      assert.equal(await fs.stat(as('alice'), `${folder}/turns/002`), null);
      assert.ok(await fs.stat(as('alice'), `${folder} 2/chat.json`));
      assert.equal(await fs.stat(as('bob'), `${folder}/chat.json`), null);
      assert.deepEqual((await fs.list(as('bob'), {prefix: 'home/bob'})), []);
      const home = await fs.stat(as('alice'), 'home/alice');
      assert.deepEqual([home.access, home.ownerId], ['private', 'alice']);
      const {changes} = await fs.changes(as('alice'), {since: 0});
      assert.ok(changes.some(change => change.op === 'create' && change.path === `${folder}/chat.json`));

      const sessions = createPostgresSessions({pool, fs});
      const read = await sessions.get(as('alice'), 'echo', 's1');
      assert.deepEqual(read.chat, [{...turn('one'), graph: {nodes: [1]}}, {...turn('two'), graph: null}]);
    } finally {
      await db.close();
    }
  });
});
