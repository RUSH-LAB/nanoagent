import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {as, migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {createCrdt, createCrdtHub, replaceText} = require('../../../../src/server/fs/crdt.js');

const editor = (userId, role) => ({...as(userId), role});
const alice = editor('alice', 'owner');
const bob = editor('bob', 'editor');
const vic = editor('vic', 'viewer');

/** An editor's copy of the document, started from the server's state. */
async function openCopy(crdt, scope, path) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await crdt.state(scope, path)).update);
  return doc;
}

describe('mergeable Markdown', () => {
  let db;
  let fs;
  let crdt;

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    fs = createPostgresFs({pool: database.pool});
    crdt = createCrdt({fs});
    await fs.write(alice, 'notes/plan.md', 'Intro.\n\nOutro.\n');
  });
  after(() => db?.close());

  it('merges concurrent edits from two editors instead of choosing one', async () => {
    const mine = await openCopy(crdt, alice, 'notes/plan.md');
    const theirs = await openCopy(crdt, bob, 'notes/plan.md');
    const before = Y.encodeStateVector(mine);
    const theirsBefore = Y.encodeStateVector(theirs);
    // Both edit while apart, then send what they did.
    mine.getText('markdown').insert('Intro.'.length, ' Alice was here.');
    theirs.getText('markdown').insert('Intro.\n\nOutro.'.length, ' Bob too.');
    await crdt.merge(alice, 'notes/plan.md', Y.encodeStateAsUpdate(mine, before));
    const {node} = await crdt.merge(bob, 'notes/plan.md', Y.encodeStateAsUpdate(theirs, theirsBefore));
    const text = (await fs.read(alice, 'notes/plan.md')).body.toString();
    assert.equal(text, 'Intro. Alice was here.\n\nOutro. Bob too.\n');
    assert.equal(node.rev, (await fs.stat(alice, 'notes/plan.md')).rev);
  });

  it('streams what a merge changed so both editors converge', async () => {
    const mine = await openCopy(crdt, alice, 'notes/plan.md');
    const theirs = await openCopy(crdt, bob, 'notes/plan.md');
    const before = Y.encodeStateVector(mine);
    mine.getText('markdown').insert(0, '# Plan\n\n');
    const {changes} = await crdt.merge(alice, 'notes/plan.md', Y.encodeStateAsUpdate(mine, before));
    Y.applyUpdate(theirs, changes);
    assert.equal(theirs.getText('markdown').toString(), mine.getText('markdown').toString());
  });

  it('folds in a plain write made outside the editor', async () => {
    const current = (await fs.read(alice, 'notes/plan.md')).body.toString();
    const stat = await fs.stat(alice, 'notes/plan.md');
    await fs.write(alice, 'notes/plan.md', current.replace('Outro.', 'Ending.'), {baseRev: stat.rev});
    const copy = await openCopy(crdt, alice, 'notes/plan.md');
    assert.match(copy.getText('markdown').toString(), /Ending\. Bob too\./);
  });

  it('lets a viewer read the document but not change it', async () => {
    const copy = await openCopy(crdt, vic, 'notes/plan.md');
    const before = Y.encodeStateVector(copy);
    copy.getText('markdown').insert(0, 'vandal ');
    await assert.rejects(() => crdt.merge(vic, 'notes/plan.md', Y.encodeStateAsUpdate(copy, before)));
    assert.doesNotMatch((await fs.read(alice, 'notes/plan.md')).body.toString(), /vandal/);
  });

  it('builds the same document for everyone who opens a file first', async () => {
    await fs.write(alice, 'notes/fresh.md', 'Fresh text');
    const viewers = [await crdt.state(vic, 'notes/fresh.md'), await crdt.state(vic, 'notes/fresh.md')];
    const opened = await crdt.state(alice, 'notes/fresh.md');
    assert.deepEqual(Buffer.from(viewers[0].update), Buffer.from(viewers[1].update));
    assert.deepEqual(Buffer.from(viewers[0].update), Buffer.from(opened.update));
  });

  it('refuses files that are not Markdown', async () => {
    await fs.write(alice, 'data/table.csv', 'a,b');
    await assert.rejects(() => crdt.state(alice, 'data/table.csv'), {code: 'not-mergeable'});
  });

  it('replaces only the text that differs', () => {
    const doc = new Y.Doc();
    const text = doc.getText('markdown');
    text.insert(0, 'The quick brown fox');
    replaceText(text, 'The quick red fox');
    assert.equal(text.toString(), 'The quick red fox');
  });

  it('sends updates to every listener of a node', () => {
    const hub = createCrdtHub();
    const received = [];
    const stop = hub.listen('n1', update => received.push(update));
    hub.broadcast('n1', new Uint8Array([1, 2, 3]));
    hub.broadcast('n1', new Uint8Array([0, 0]));
    stop();
    hub.broadcast('n1', new Uint8Array([4, 5, 6]));
    assert.deepEqual(received, [Buffer.from([1, 2, 3]).toString('base64')]);
    assert.equal(hub.has('n1'), false);
  });
});
