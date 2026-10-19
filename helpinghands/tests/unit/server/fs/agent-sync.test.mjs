import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {applyMigration, as, migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {conflictPath, createAgentSync} = require('../../../../src/server/fs/agent-sync.js');

/** NanoAgent's workspace API over one in-memory folder per workspace id. */
function fakeNanoAgent() {
  const folders = new Map();
  const of = workspace => folders.get(workspace) ?? folders.set(workspace, new Map()).get(workspace);
  return {
    folders,
    of,
    removed: [],
    truncated: false,
    async workspaceFiles(workspace) {
      const files = [...of(workspace)].map(([path, body]) => ({path, size: body.length}));
      return {value: {files, folders: [], truncated: this.truncated}};
    },
    async workspaceFile(workspace, path) { return {value: of(workspace).get(path)}; },
    async saveWorkspaceFile(workspace, path, body) { of(workspace).set(path, Buffer.from(body)); return {value: {}}; },
    async deleteWorkspace(workspace) { folders.delete(workspace); this.removed.push(workspace); return {value: {deleted: true}}; },
  };
}

/**
 * One run, as app-runs.js does one: a folder prepared, kept as JSON (as
 * PostgreSQL keeps it), `operation(workspace)` in it, and what it did written
 * back, even when it fails.
 */
async function runIn(sync, scope, ai, operation, plugin = 'echo') {
  const folder = JSON.parse(JSON.stringify(await sync.prepare(scope, ai, plugin)));
  try {
    return await operation(folder.workspace);
  } finally {
    await sync.finish(scope, ai, plugin, folder);
  }
}

describe('plugin runs as file system clients', () => {
  let db;
  let fs;
  const alice = as('alice');

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    fs = createPostgresFs({pool: database.pool});
  });
  after(() => db?.close());

  it('gives a run the member\'s folder for its plugin, keeps what it wrote, and removes its folder', async () => {
    const nano = fakeNanoAgent();
    const sync = createAgentSync({fs});
    await fs.mkdir(alice, 'home/alice');
    await fs.setAccess(alice, 'home/alice', 'private');
    await fs.write(alice, 'home/alice/Plugins/echo/input.txt', 'question');
    await fs.write(alice, 'home/alice/Plugins/echo/stale.txt', 'old');

    let used;
    await runIn(sync, alice, nano, async workspace => {
      used = workspace;
      const folder = nano.of(workspace);
      assert.deepEqual([...folder.keys()].sort(), ['input.txt', 'stale.txt']);
      folder.set('answers/out.md', Buffer.from('# Answer'));
      folder.set('input.txt', Buffer.from('question, edited'));
      folder.delete('stale.txt');
    });

    assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/answers/out.md')).body.toString(), '# Answer');
    assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/input.txt')).body.toString(), 'question, edited');
    assert.equal(await fs.stat(alice, 'home/alice/Plugins/echo/stale.txt'), null);
    assert.equal(await fs.stat(as('bob'), 'home/alice/Plugins/echo/answers/out.md'), null);
    assert.deepEqual(nano.removed, [used]);
    assert.equal(nano.folders.size, 0);
  });

  it('gives every run a folder of its own, so runs need not wait for each other', async () => {
    const nano = fakeNanoAgent();
    const sync = createAgentSync({fs});
    const seen = [];
    await Promise.all([runIn(sync, alice, nano, async w => seen.push(w)), runIn(sync, alice, nano, async w => seen.push(w))]);
    assert.equal(new Set(seen).size, 2);
  });

  it('keeps the member\'s edits made during the run', async () => {
    const nano = fakeNanoAgent();
    const sync = createAgentSync({fs});
    await fs.write(alice, 'home/alice/Plugins/echo/both.md', 'start');
    await fs.write(alice, 'home/alice/Plugins/echo/kept.md', 'start');
    const day = new Date().toISOString().slice(0, 10);
    const edit = async () => {
      await fs.write(alice, 'home/alice/Plugins/echo/both.md', 'member');
      await fs.write(alice, 'home/alice/Plugins/echo/kept.md', 'member');
    };
    await runIn(sync, alice, nano, async workspace => {
      // The member writes while the run goes on.
      await fs.write(alice, 'home/alice/Plugins/echo/both.md', 'member');
      await fs.write(alice, 'home/alice/Plugins/echo/kept.md', 'member');
      await fs.write(alice, 'home/alice/Plugins/echo/added.md', 'member');
      nano.of(workspace).set('both.md', Buffer.from('agent'));
      nano.of(workspace).delete('kept.md');
    });
    assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/both.md')).body.toString(), 'member');
    assert.equal((await fs.read(alice, `home/alice/Plugins/echo/both (conflicted copy echo run ${day}).md`)).body.toString(), 'agent');
    assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/kept.md')).body.toString(), 'member');
    assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/added.md')).body.toString(), 'member');
    // Another run that day the member edits under is kept as the next copy.
    await runIn(sync, alice, nano, async workspace => {
      await edit();
      await fs.write(alice, 'home/alice/Plugins/echo/both.md', 'member again');
      nano.of(workspace).set('both.md', Buffer.from('agent again'));
    });
    assert.equal((await fs.read(alice, `home/alice/Plugins/echo/both (conflicted copy echo run ${day} 2).md`)).body.toString(), 'agent again');
  });

  it('writes nothing back from a listing NanoAgent cut short', async () => {
    const nano = fakeNanoAgent();
    nano.truncated = true;
    await fs.write(alice, 'home/alice/Plugins/echo/safe.md', 'here');
    await assert.rejects(() => runIn(createAgentSync({fs}), alice, nano, async workspace => {
      nano.of(workspace).clear();
    }), /only part/);
    assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/safe.md')).body.toString(), 'here');
    assert.equal(nano.folders.size, 0);
  });

  it('writes results back even when the run fails', async () => {
    const nano = fakeNanoAgent();
    const sync = createAgentSync({fs});
    await assert.rejects(() => runIn(sync, alice, nano, async workspace => {
      nano.of(workspace).set('partial.txt', Buffer.from('half done'));
      throw new Error('cancelled');
    }), /cancelled/);
    assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/partial.txt')).body.toString(), 'half done');
    assert.equal(nano.folders.size, 0);
  });

  it('makes a member\'s home private when a run creates it', async () => {
    const bob = as('bob');
    const nano = fakeNanoAgent();
    await runIn(createAgentSync({fs}), bob, nano, async workspace => { nano.of(workspace).set('note.md', Buffer.from('mine')); });
    assert.equal((await fs.stat(bob, 'home/bob')).access, 'private');
    assert.equal(await fs.stat(alice, 'home/bob/Plugins/echo/note.md'), null);
  });
});

describe('plugin folders', () => {
  it('gives a run only its own plugin\'s folder', async () => {
    const {db, pool} = await migratedDatabase();
    const fs = createPostgresFs({pool});
    const alice = as('alice');
    const nano = fakeNanoAgent();
    const sync = createAgentSync({fs});
    try {
      await fs.write(alice, 'home/alice/Plugins/echo/mine.md', 'echo');
      await fs.write(alice, 'home/alice/files/kept.md', 'member');
      let seen;
      await runIn(sync, alice, nano, async workspace => {
        seen = [...nano.of(workspace).keys()];
        nano.of(workspace).set('out.md', Buffer.from('other'));
      }, 'other');
      assert.deepEqual(seen, []);
      assert.equal((await fs.read(alice, 'home/alice/Plugins/other/out.md')).body.toString(), 'other');
      assert.equal((await fs.read(alice, 'home/alice/Plugins/echo/mine.md')).body.toString(), 'echo');
    } finally {
      await db.close();
    }
  });

  it('moves what runs left before plugin folders to the member\'s files, as logged moves', async () => {
    const {db, pool} = await migratedDatabase({until: '0031_plugin_folders.sql'});
    const fs = createPostgresFs({pool});
    const alice = as('alice');
    try {
      await fs.mkdir(alice, 'home/alice');
      await fs.setAccess(alice, 'home/alice', 'private');
      await fs.write(alice, 'home/alice/agent/notes/a.md', 'a');
      await fs.write(alice, 'home/alice/agent-like.md', 'stays');
      await fs.write(as('bob'), 'home/bob/agent/b.txt', 'b');
      const before = await fs.stat(alice, 'home/alice/agent/notes/a.md');
      await applyMigration(db, '0031_plugin_folders.sql');
      const after = await fs.stat(alice, 'home/alice/files/notes/a.md');
      assert.equal(after.id, before.id);
      assert.equal(after.access, 'private');
      assert.ok(after.rev > before.rev);
      assert.equal(await fs.stat(alice, 'home/alice/agent'), null);
      assert.equal((await fs.read(alice, 'home/alice/agent-like.md')).body.toString(), 'stays');
      assert.equal((await fs.read(as('bob'), 'home/bob/files/b.txt')).body.toString(), 'b');
      const moved = (await fs.changes(alice, {since: before.rev})).changes.find(change => change.nodeId === before.id);
      assert.deepEqual([moved.op, moved.fromPath, moved.path, moved.seq], ['move', 'home/alice/agent/notes/a.md', 'home/alice/files/notes/a.md', after.rev]);
    } finally {
      await db.close();
    }
  });
});

describe('conflictPath', () => {
  it('names the copy before the extension, as RUSH Lab\'s sync does', () => {
    assert.equal(conflictPath('a/b.tar.gz', 'echo run 2026-10-18'), 'a/b.tar (conflicted copy echo run 2026-10-18).gz');
    assert.equal(conflictPath('a/.env', 'echo run 2026-10-18', 2), 'a/.env (conflicted copy echo run 2026-10-18 2)');
    assert.equal(conflictPath('notes', 'echo run 2026-10-18'), 'notes (conflicted copy echo run 2026-10-18)');
  });
});
