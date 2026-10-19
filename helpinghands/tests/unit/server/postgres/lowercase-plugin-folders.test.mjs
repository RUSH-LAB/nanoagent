import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {applyMigration, as, migratedDatabase} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {chatName} = require('../../../../src/server/fs/chats.js');

const MIGRATION = '0048_lowercase_plugin_folders.sql';
const alice = as('alice');

describe('lowercase plugin folders', () => {
  it('names plugin folders and chats in lowercase words joined by _, and trashes what runs left before', async () => {
    const {db, pool} = await migratedDatabase({until: MIGRATION});
    const fs = createPostgresFs({pool});
    try {
      await fs.write(alice, 'home/alice/Plugins/echo/files/out.md', 'out');
      await fs.write(alice, 'home/alice/Plugins/echo/chats/2026-10-19 Find the paper!/chat.json', '{}');
      await fs.write(alice, 'home/alice/Plugins/echo/chats/2026-10-19 find the paper/chat.json', '{}');
      await fs.write(alice, 'home/alice/From earlier runs/old.md', 'old');
      const chat = await fs.stat(alice, 'home/alice/Plugins/echo/chats/2026-10-19 Find the paper!/chat.json');

      await applyMigration(db, MIGRATION);

      const live = (await fs.list(alice)).filter(node => node.kind === 'file').map(node => node.path).sort();
      assert.deepEqual(live, [
        'home/alice/plugins/echo/chats/2026_10_19_find_the_paper/chat.json',
        'home/alice/plugins/echo/chats/2026_10_19_find_the_paper_2/chat.json',
        'home/alice/plugins/echo/files/out.md',
      ]);
      assert.equal((await fs.stat(alice, 'home/alice/plugins/echo/chats/2026_10_19_find_the_paper/chat.json')).id, chat.id);
      // The old files are in the trash, to restore.
      assert.ok((await fs.trash(alice)).some(node => node.path === 'home/alice/From earlier runs/old.md'));
      const {changes} = await fs.changes(alice, {since: chat.rev});
      assert.ok(changes.some(change => change.op === 'move' && change.fromPath === 'home/alice/Plugins'));
      assert.ok(changes.some(change => change.op === 'delete' && change.path === 'home/alice/From earlier runs/old.md'));
    } finally {
      await db.close();
    }
  });

  it('names a new chat as the migration names an old one', () => {
    assert.equal(chatName('2026-10-19T12:00:00Z', 'Find the paper! (BERT)'), '2026_10_19_find_the_paper_bert');
    assert.equal(chatName('2026-10-19T12:00:00Z', '...'), '2026_10_19_chat');
  });
});
