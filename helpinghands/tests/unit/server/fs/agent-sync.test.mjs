import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {as, migratedDatabase} from './_pglite.mjs';

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
async function runIn(sync, scope, ai, operation) {
  const folder = JSON.parse(JSON.stringify(await sync.prepare(scope, ai)));
  try {
    return await operation(folder.workspace);
  } finally {
    await sync.finish(scope, ai, folder);
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

  it('gives a run the member\'s agent folder, keeps what it wrote, and removes its folder', async () => {
    const nano = fakeNanoAgent();
    const sync = createAgentSync({fs});
    await fs.mkdir(alice, 'home/alice');
    await fs.setAccess(alice, 'home/alice', 'private');
    await fs.write(alice, 'home/alice/agent/input.txt', 'question');
    await fs.write(alice, 'home/alice/agent/stale.txt', 'old');

    let used;
    await runIn(sync, alice, nano, async workspace => {
      used = workspace;
      const folder = nano.of(workspace);
      assert.deepEqual([...folder.keys()].sort(), ['input.txt', 'stale.txt']);
      folder.set('answers/out.md', Buffer.from('# Answer'));
      folder.set('input.txt', Buffer.from('question, edited'));
      folder.delete('stale.txt');
    });

    assert.equal((await fs.read(alice, 'home/alice/agent/answers/out.md')).body.toString(), '# Answer');
    assert.equal((await fs.read(alice, 'home/alice/agent/input.txt')).body.toString(), 'question, edited');
    assert.equal(await fs.stat(alice, 'home/alice/agent/stale.txt'), null);
    assert.equal(await fs.stat(as('bob'), 'home/alice/agent/answers/out.md'), null);
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
    await fs.write(alice, 'home/alice/agent/both.md', 'start');
    await fs.write(alice, 'home/alice/agent/kept.md', 'start');
    let used;
    await runIn(sync, alice, nano, async workspace => {
      used = workspace;
      // The member writes while the run goes on.
      await fs.write(alice, 'home/alice/agent/both.md', 'member');
      await fs.write(alice, 'home/alice/agent/kept.md', 'member');
      await fs.write(alice, 'home/alice/agent/added.md', 'member');
      nano.of(workspace).set('both.md', Buffer.from('agent'));
      nano.of(workspace).delete('kept.md');
    });
    assert.equal((await fs.read(alice, 'home/alice/agent/both.md')).body.toString(), 'member');
    assert.equal((await fs.read(alice, `home/alice/agent/both (agent run ${used.slice(0, 8)}).md`)).body.toString(), 'agent');
    assert.equal((await fs.read(alice, 'home/alice/agent/kept.md')).body.toString(), 'member');
    assert.equal((await fs.read(alice, 'home/alice/agent/added.md')).body.toString(), 'member');
  });

  it('writes nothing back from a listing NanoAgent cut short', async () => {
    const nano = fakeNanoAgent();
    nano.truncated = true;
    await fs.write(alice, 'home/alice/agent/safe.md', 'here');
    await assert.rejects(() => runIn(createAgentSync({fs}), alice, nano, async workspace => {
      nano.of(workspace).clear();
    }), /only part/);
    assert.equal((await fs.read(alice, 'home/alice/agent/safe.md')).body.toString(), 'here');
    assert.equal(nano.folders.size, 0);
  });

  it('writes results back even when the run fails', async () => {
    const nano = fakeNanoAgent();
    const sync = createAgentSync({fs});
    await assert.rejects(() => runIn(sync, alice, nano, async workspace => {
      nano.of(workspace).set('partial.txt', Buffer.from('half done'));
      throw new Error('cancelled');
    }), /cancelled/);
    assert.equal((await fs.read(alice, 'home/alice/agent/partial.txt')).body.toString(), 'half done');
    assert.equal(nano.folders.size, 0);
  });

  it('makes a member\'s home private when a run creates it', async () => {
    const bob = as('bob');
    const nano = fakeNanoAgent();
    await runIn(createAgentSync({fs}), bob, nano, async workspace => { nano.of(workspace).set('note.md', Buffer.from('mine')); });
    assert.equal((await fs.stat(bob, 'home/bob')).access, 'private');
    assert.equal(await fs.stat(alice, 'home/bob/agent/note.md'), null);
  });
});

describe('conflictPath', () => {
  it('names the run before the extension', () => {
    assert.equal(conflictPath('a/b.tar.gz', 'abcdef1234'), 'a/b.tar (agent run abcdef12).gz');
    assert.equal(conflictPath('a/.env', 'abcdef1234'), 'a/.env (agent run abcdef12)');
    assert.equal(conflictPath('notes', 'abcdef1234'), 'notes (agent run abcdef12)');
  });
});
