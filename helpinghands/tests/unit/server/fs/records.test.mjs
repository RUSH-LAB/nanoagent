import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {as, migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {createFsRecords, fileNameFor} = require('../../../../src/server/fs/records.js');

describe('app records as files', () => {
  let db;
  let fs;
  let store;
  const legacyCalls = [];
  const alice = as('alice');
  const bob = as('bob');

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    fs = createPostgresFs({pool: database.pool});
    const legacy = {collection: domain => ({domain, legacy: true, list: async () => { legacyCalls.push(domain); return []; }})};
    store = createFsRecords({fs, legacy});
  });
  after(() => db?.close());

  it('keeps a workspace record as a file every member sees', async () => {
    const glossary = store.collection('glossary');
    await glossary.put(alice, 'CRDT', {term: 'CRDT', definition: 'A mergeable data type'});
    assert.deepEqual(await glossary.get(bob, 'CRDT'), {term: 'CRDT', definition: 'A mergeable data type'});
    const file = await fs.read(bob, 'apps/glossary/CRDT.json');
    assert.deepEqual(JSON.parse(file.body.toString()), {key: 'CRDT', value: {term: 'CRDT', definition: 'A mergeable data type'}});
  });

  it('keeps a member record in their private home folder', async () => {
    const tasks = store.collection('tasks');
    await tasks.put(alice, 't1', {title: 'Write the plan'});
    assert.deepEqual(await tasks.values(alice), [{title: 'Write the plan'}]);
    assert.deepEqual(await tasks.values(bob), []);
    assert.equal(await fs.stat(bob, 'home/alice/tasks/t1.json'), null);
    assert.equal((await fs.stat(alice, 'home/alice')).access, 'private');
  });

  it('updates, counts, replaces, and removes records', async () => {
    const tasks = store.collection('tasks');
    await tasks.update(alice, 't1', current => ({...current, done: true}));
    assert.equal((await tasks.get(alice, 't1')).done, true);
    await tasks.replaceAll(alice, {t2: {title: 'Two'}, t3: {title: 'Three'}});
    assert.deepEqual(Object.keys(await tasks.entries(alice)).sort(), ['t2', 't3']);
    assert.equal(await tasks.count(alice), 2);
    assert.equal(await tasks.remove(alice, 't2'), true);
    assert.equal(await tasks.update(alice, 't3', () => undefined), undefined);
    assert.equal(await tasks.count(alice), 0);
  });

  it('keeps plugin collections under apps/<plugin>/', async () => {
    const papers = store.collection('plugin:bibliography:papers');
    await papers.put(alice, 'knuth1984', {title: 'Literate Programming'});
    assert.ok(await fs.stat(bob, 'apps/bibliography/papers/knuth1984.json'));
  });

  it('names long and awkward keys safely', async () => {
    assert.equal(fileNameFor('a/b c'), 'a%2Fb%20c.json');
    assert.equal(fileNameFor('.hidden'), '%2Ehidden.json');
    assert.match(fileNameFor('x'.repeat(300)), /^[0-9a-f]{40}\.json$/);
    const notes = store.collection('notes');
    await notes.put(alice, 'x'.repeat(300), 'long');
    assert.equal(await notes.get(alice, 'x'.repeat(300)), 'long');
  });

  it('leaves internal state in the legacy store', async () => {
    const analytics = store.collection('analytics');
    assert.equal(analytics.legacy, true);
    await analytics.list(alice);
    assert.deepEqual(legacyCalls, ['analytics']);
  });
});
