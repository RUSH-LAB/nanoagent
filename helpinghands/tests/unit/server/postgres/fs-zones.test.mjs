import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {applyMigration, as, migratedDatabase} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');

const MIGRATION = '0045_fs_zones.sql';
const alice = as('alice');

describe('file system zones', () => {
  it('moves app state under dot folders and plugin folders to names people read, as logged moves', async () => {
    const {db, pool} = await migratedDatabase({until: MIGRATION});
    const fs = createPostgresFs({pool});
    try {
      await fs.write(alice, 'chat/ch_1/channel.json', '{}');
      await fs.write(alice, 'chat/.names/general.json', '{}');
      await fs.write(alice, '.plugins/blobs/legacy.pdf', 'pdf');
      await fs.write(alice, '.plugins/bibliography/1234.pdf', 'pdf');
      await fs.write(alice, 'apps/glossary/CRDT.json', '{}');
      await fs.write(alice, 'apps/bibliography/papers/knuth.json', '{}');
      await fs.write(alice, 'apps/readme.md', 'mine');
      await fs.write(alice, 'home/alice/tasks/t1.json', '{}');
      await fs.write(alice, 'home/alice/notes/own.md', 'mine');
      await fs.write(alice, 'home/alice/notes/n1.json', '{}');
      await fs.write(alice, 'home/alice/agent/echo/out.md', 'out');
      await fs.write(alice, 'home/alice/files/old.md', 'old');
      const before = await fs.stat(alice, 'home/alice/tasks/t1.json');

      await applyMigration(db, MIGRATION);

      const live = (await fs.list(alice)).filter(node => node.kind === 'file').map(node => node.path).sort();
      assert.deepEqual(live, [
        '.apps/glossary/CRDT.json',
        '.chat/.names/general.json',
        '.chat/ch_1/channel.json',
        '.plugins/.imported/legacy.pdf',
        '.plugins/bibliography/blobs/1234.pdf',
        '.plugins/bibliography/records/papers/knuth.json',
        'apps/readme.md',
        'home/alice/.apps/notes/n1.json',
        'home/alice/.apps/tasks/t1.json',
        'home/alice/From earlier runs/old.md',
        'home/alice/Plugins/echo/out.md',
        'home/alice/notes/own.md',
      ]);
      const after = await fs.stat(alice, 'home/alice/.apps/tasks/t1.json');
      assert.equal(after.id, before.id);
      assert.deepEqual([after.access, after.ownerId], ['private', 'alice']);
      assert.deepEqual([(await fs.stat(alice, 'home/alice/.apps')).access, (await fs.stat(alice, '.apps')).access], ['private', 'workspace']);
      // The folders the records left are in the trash; one with a member's file stays.
      assert.equal(await fs.stat(alice, 'home/alice/tasks'), null);
      assert.equal(await fs.stat(alice, 'apps/glossary'), null);
      assert.ok(await fs.stat(alice, 'home/alice/notes'));
      assert.ok(await fs.stat(alice, 'apps'));

      const {changes} = await fs.changes(alice, {since: before.rev});
      const moved = changes.find(change => change.nodeId === before.id);
      assert.deepEqual([moved.op, moved.fromPath, moved.seq], ['move', 'home/alice/tasks/t1.json', after.rev]);
      const ops = changes.map(change => change.op);
      assert.ok(ops.lastIndexOf('create') < ops.indexOf('move') && ops.lastIndexOf('move') < ops.indexOf('delete'));

      // Viewers chat under .chat/ now.
      await fs.write(as('vic'), '.chat/ch_1/messages/1-vic.json', '{}');
    } finally {
      await db.close();
    }
  });

  it('moves nothing when a target is taken', async () => {
    const {db, pool} = await migratedDatabase({until: MIGRATION});
    const fs = createPostgresFs({pool});
    try {
      await fs.write(alice, 'home/alice/agent/echo/out.md', 'out');
      await fs.write(alice, 'home/alice/Plugins/echo/out.md', 'mine');
      await assert.rejects(applyMigration(db, MIGRATION), /these paths are taken: .*lab:home\/alice\/Plugins\/echo\/out\.md/);
      assert.ok(await fs.stat(alice, 'home/alice/agent/echo/out.md'));
    } finally {
      await db.close();
    }
  });
});
