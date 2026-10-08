import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {as, migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs, createPublicFsReader} = require('../../../../src/server/fs/store.js');

describe('workspace file system', () => {
  let db;
  let fs;
  let publicFs;
  const alice = as('alice');
  const bob = as('bob');
  const vic = as('vic');

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    fs = createPostgresFs({pool: database.pool});
    publicFs = createPublicFsReader({pool: database.pool});
  });
  after(() => db?.close());

  it('writes a file, creating its folders, and reads it back', async () => {
    const node = await fs.write(alice, 'books/intro/start.md', '# Start here\n');
    assert.equal(node.kind, 'file');
    assert.equal(node.meta.title, 'Start here');
    assert.equal(node.contentType, 'text/markdown; charset=utf-8');
    const {body} = await fs.read(bob, 'books/intro/start.md');
    assert.equal(body.toString(), '# Start here\n');
    const listed = (await fs.list(bob, {prefix: 'books'})).map(each => [each.path, each.kind]);
    assert.deepEqual(listed, [['books', 'folder'], ['books/intro', 'folder'], ['books/intro/start.md', 'file']]);
  });

  it('refuses a write based on a stale revision and accepts the current one', async () => {
    const first = await fs.write(alice, 'notes/a.md', 'one');
    const second = await fs.write(bob, 'notes/a.md', 'two', {baseRev: first.rev});
    assert.ok(second.rev > first.rev);
    await assert.rejects(() => fs.write(alice, 'notes/a.md', 'three', {baseRev: first.rev}),
      {status: 409, code: 'stale-revision', currentRev: second.rev});
    await assert.rejects(() => fs.write(alice, 'notes/a.md', 'new', {baseRev: 0}), {code: 'exists'});
    assert.equal((await fs.read(alice, 'notes/a.md')).body.toString(), 'two');
  });

  it('keeps every revision and reads an old one back', async () => {
    const history = await fs.history(alice, 'notes/a.md');
    assert.deepEqual(history.map(change => change.op), ['write', 'create']);
    const old = await fs.readRevision(alice, 'notes/a.md', history.at(-1).seq);
    assert.equal(old.body.toString(), 'one');
  });

  it('moves a folder with everything in it, keeping ids', async () => {
    const before = await fs.stat(alice, 'books/intro/start.md');
    await fs.move(alice, 'books/intro', 'books/guide');
    const after = await fs.stat(alice, 'books/guide/start.md');
    assert.equal(after.id, before.id);
    assert.equal(await fs.stat(alice, 'books/intro/start.md'), null);
    await assert.rejects(() => fs.move(alice, 'books', 'books/inner'), {code: 'bad-path'});
  });

  it('deletes to the trash and restores with the folder', async () => {
    await fs.write(alice, 'drafts/x.md', 'x');
    const folder = await fs.stat(alice, 'drafts');
    await fs.remove(alice, 'drafts');
    assert.equal(await fs.stat(alice, 'drafts/x.md'), null);
    assert.deepEqual((await fs.trash(alice)).map(each => each.path).sort(), ['drafts', 'drafts/x.md']);
    await fs.restore(alice, folder.id);
    assert.equal((await fs.read(alice, 'drafts/x.md')).body.toString(), 'x');
  });

  it('hides a private folder and its files from other members', async () => {
    await fs.write(alice, 'journal/today.md', 'secret');
    await fs.setAccess(alice, 'journal', 'private');
    assert.equal(await fs.stat(bob, 'journal/today.md'), null);
    assert.equal((await fs.stat(alice, 'journal/today.md')).access, 'private');
    // A file added later inherits the folder's privacy.
    await fs.write(alice, 'journal/tomorrow.md', 'also secret');
    assert.equal(await fs.stat(bob, 'journal/tomorrow.md'), null);
    const bobChanges = (await fs.changes(bob)).changes.map(change => change.path);
    assert.ok(!bobChanges.some(changed => changed.startsWith('journal')));
  });

  it('shows public folders, and only those, to anyone', async () => {
    await fs.write(alice, 'posts/hello.md', '# Hello, world');
    await fs.setAccess(alice, 'posts', 'public');
    assert.equal((await publicFs.read('lab', 'posts/hello.md')).body.toString(), '# Hello, world');
    assert.equal(await publicFs.read('lab', 'notes/a.md'), null);
    assert.equal(await publicFs.read('lab', 'journal/today.md'), null);
    assert.deepEqual((await publicFs.list('lab')).map(each => each.path), ['posts', 'posts/hello.md']);
    // Making one file inside a public folder workspace-only hides it again.
    await fs.write(alice, 'posts/draft.md', 'not yet');
    await fs.setAccess(alice, 'posts/draft.md', 'workspace');
    assert.equal(await publicFs.read('lab', 'posts/draft.md'), null);
  });

  it('shares a folder with chosen members only, who may work in it', async () => {
    await fs.write(alice, 'team/plan.md', 'for alice and bob');
    await fs.setAccess(alice, 'team', 'shared', {members: ['bob']});
    assert.equal((await fs.read(bob, 'team/plan.md')).body.toString(), 'for alice and bob');
    assert.equal(await fs.stat(vic, 'team/plan.md'), null);
    assert.deepEqual(await fs.sharedWith(bob, 'team/plan.md'), ['alice', 'bob']);
    // A member it is shared with adds to it, and the file stays shared.
    const added = await fs.write(bob, 'team/notes.md', 'bob was here');
    assert.equal(added.access, 'shared');
    assert.equal(await fs.stat(vic, 'team/notes.md'), null);
    // Unsharing hands it back to the workspace.
    await fs.setAccess(alice, 'team', 'workspace');
    assert.ok(await fs.stat(vic, 'team/notes.md'));
  });

  it('lets a viewer read but not write', async () => {
    assert.ok(await fs.read(vic, 'notes/a.md'));
    await assert.rejects(() => fs.write(vic, 'notes/b.md', 'nope'));
  });

  it('keeps workspaces apart', async () => {
    assert.equal(await fs.stat(as('carol', 'lab'), 'notes/a.md'), null);
    assert.deepEqual(await fs.list(as('carol', 'other')), []);
    await assert.rejects(() => fs.write(as('carol', 'lab'), 'notes/intruder.md', 'x'));
  });

  it('feeds every visible change in order from a cursor', async () => {
    const first = await fs.changes(alice, {limit: 3});
    assert.equal(first.changes.length, 3);
    const rest = await fs.changes(alice, {since: first.cursor});
    assert.ok(rest.changes.every(change => change.seq > first.cursor));
    await fs.write(bob, 'notes/c.md', 'c');
    const latest = await fs.changes(alice, {since: rest.cursor});
    assert.deepEqual(latest.changes.map(change => [change.op, change.path]), [['create', 'notes/c.md']]);
  });
});
