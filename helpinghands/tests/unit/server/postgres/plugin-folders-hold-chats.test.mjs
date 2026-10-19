import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {applyMigration, as, migratedDatabase} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');

const MIGRATION = '0047_plugin_folders_hold_chats.sql';
const alice = as('alice');

describe('plugin folders holding their chats', () => {
  it('moves a plugin\'s files into its files/ and its chats into its chats/, as logged moves', async () => {
    const {db, pool} = await migratedDatabase({until: MIGRATION});
    const fs = createPostgresFs({pool});
    try {
      await fs.write(alice, 'home/alice/Plugins/echo/papers/a.tex', 'a');
      await fs.write(alice, 'home/alice/Chats/echo/2026-10-19 Hi/chat.json', '{}');
      await fs.write(alice, 'home/alice/Chats/weather/2026-10-19 Rain/turns/001/graph.json', '{}');
      await fs.write(alice, 'home/alice/notes.md', 'mine');
      const before = await fs.stat(alice, 'home/alice/Chats/echo/2026-10-19 Hi/chat.json');

      await applyMigration(db, MIGRATION);

      const live = (await fs.list(alice)).filter(node => node.kind === 'file').map(node => node.path).sort();
      assert.deepEqual(live, [
        'home/alice/Plugins/echo/chats/2026-10-19 Hi/chat.json',
        'home/alice/Plugins/echo/files/papers/a.tex',
        'home/alice/Plugins/weather/chats/2026-10-19 Rain/turns/001/graph.json',
        'home/alice/notes.md',
      ]);
      const after = await fs.stat(alice, 'home/alice/Plugins/echo/chats/2026-10-19 Hi/chat.json');
      assert.equal(after.id, before.id);
      assert.deepEqual([after.access, after.ownerId], ['private', 'alice']);
      assert.equal((await fs.stat(alice, 'home/alice/Plugins/weather')).access, 'private');
      assert.equal(await fs.stat(alice, 'home/alice/Chats'), null);
      assert.equal(await fs.stat(as('bob'), 'home/alice/Plugins/weather/chats/2026-10-19 Rain/turns/001/graph.json'), null);
      const moved = (await fs.changes(alice, {since: before.rev})).changes.find(change => change.nodeId === before.id);
      assert.deepEqual([moved.op, moved.fromPath, moved.seq], ['move', 'home/alice/Chats/echo/2026-10-19 Hi/chat.json', after.rev]);
    } finally {
      await db.close();
    }
  });
});
