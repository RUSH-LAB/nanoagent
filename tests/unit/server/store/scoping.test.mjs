/**
 * server/store: whether one workspace can reach another's data, and whether one
 * member can reach another's.
 *
 * These are not mocked. They run the real prepared statements against a real
 * throwaway SQLite file created by the real migrations, because what is being
 * asserted is the behaviour of the SQL, and a stub of the SQL would assert only
 * that the test author believed the same thing twice.
 *
 * The shape of every case is the same: write the SAME KEY in two scopes that
 * differ in exactly one field, then read each back. A collection that dropped
 * its organization predicate, or its owner predicate, or built the COALESCE
 * wrong, fails these and nothing else in the suite would.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DB_PATH = require.resolve('../../../../src/server/db.js');
const STORE_PATH = require.resolve('../../../../src/server/store/index.js');

let dir;
let store;
let db;

/** Two workspaces, two accounts, and one store over all of them. */
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-store-'));
  const saved = process.env.DATABASE_FILE;
  process.env.DATABASE_FILE = path.join(dir, 'store.db');
  delete require.cache[DB_PATH];
  delete require.cache[STORE_PATH];
  try {
    ({db} = require('../../../../src/server/db.js'));
    store = require('../../../../src/server/store/index.js');
  } finally {
    if (saved === undefined) delete process.env.DATABASE_FILE;
    else process.env.DATABASE_FILE = saved;
  }

  const at = '2026-01-01T00:00:00.000Z';
  const org = db.prepare('INSERT INTO organization (id,name,slug,createdAt) VALUES (?,?,?,?)');
  org.run('org-lab', 'The Lab', 'lab', at);
  org.run('org-course', 'The Course', 'course', at);
  const user = db.prepare(
    'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)',
  );
  user.run('ada', 'Ada', 'ada@example.test', at, at);
  user.run('bob', 'Bob', 'bob@example.test', at, at);
});

after(() => {
  db?.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

// The four scopes every case below is drawn from. They differ pairwise in one
// field, which is what makes a failure name the predicate that is missing.
const adaLab = {orgId: 'org-lab', userId: 'ada'};
const bobLab = {orgId: 'org-lab', userId: 'bob'};
const adaCourse = {orgId: 'org-course', userId: 'ada'};

/** The error `run` threw, so a case can assert on its code and status. */
function thrown(run) {
  try {
    run();
  } catch (err) {
    return err;
  }
  return assert.fail('expected a throw, and nothing was thrown');
}

/**
 * entries() returns a prototype-less object on purpose, and deepStrictEqual
 * counts that as a difference from an object literal, so comparisons go through
 * a plain copy. The prototype itself is asserted directly in its own case.
 */
const plain = object => ({...object});

describe('a per-user domain', () => {
  it('keeps the same key separate for two members of one workspace', () => {
    const bookmarks = store.collection('bookmarks');
    bookmarks.put(adaLab, '/math', {title: "Ada's"});
    bookmarks.put(bobLab, '/math', {title: "Bob's"});

    assert.deepEqual(bookmarks.values(adaLab), [{title: "Ada's"}]);
    assert.deepEqual(bookmarks.values(bobLab), [{title: "Bob's"}]);
  });

  it('keeps the same key separate for one account in two workspaces', () => {
    const tasks = store.collection('tasks');
    tasks.put(adaLab, 't1', {text: 'lab task'});
    tasks.put(adaCourse, 't1', {text: 'course task'});

    assert.deepEqual(tasks.values(adaLab), [{text: 'lab task'}]);
    assert.deepEqual(tasks.values(adaCourse), [{text: 'course task'}]);
  });

  it('does not let a member delete another member\'s item of the same key', () => {
    const tasks = store.collection('tasks');
    tasks.put(adaLab, 'shared-id', {n: 1});
    tasks.put(bobLab, 'shared-id', {n: 2});

    assert.equal(tasks.remove(bobLab, 'shared-id'), true);
    assert.deepEqual(tasks.get(adaLab, 'shared-id'), {n: 1}, "Bob's delete must not reach Ada's row");
  });

  it('does not let clear() in one scope empty another', () => {
    const streaks = store.collection('streaks');
    streaks.put(adaLab, 's', {days: 3});
    streaks.put(bobLab, 's', {days: 9});
    streaks.put(adaCourse, 's', {days: 1});

    assert.equal(streaks.clear(adaLab), 1, 'only the one row in scope');
    assert.equal(streaks.count(bobLab), 1);
    assert.equal(streaks.count(adaCourse), 1);
  });
});

describe('an org-shared domain', () => {
  it('shows every member of the workspace the same item', () => {
    const glossary = store.collection('glossary');
    glossary.put(adaLab, 'tensor', {definition: 'a multilinear map'});

    assert.deepEqual(
      glossary.get(bobLab, 'tensor'),
      {definition: 'a multilinear map'},
      'a glossary the workspace cannot all read is not a glossary',
    );
  });

  it('still stops at the workspace boundary', () => {
    const glossary = store.collection('glossary');
    glossary.put(adaLab, 'sheaf', {definition: 'lab'});
    glossary.put(adaCourse, 'sheaf', {definition: 'course'});

    assert.deepEqual(glossary.get(adaLab, 'sheaf'), {definition: 'lab'});
    assert.deepEqual(glossary.get(adaCourse, 'sheaf'), {definition: 'course'});
  });

  it('ignores which member is asking, so two writers do not fork the row', () => {
    const schedule = store.collection('schedule');
    schedule.put(adaLab, 'seminar', {at: 'tuesday'});
    schedule.put(bobLab, 'seminar', {at: 'wednesday'});

    assert.equal(schedule.count(adaLab), 1, 'one shared row, not one per writer');
    assert.deepEqual(schedule.get(adaLab, 'seminar'), {at: 'wednesday'});
  });
});

describe('a scope that cannot be honoured', () => {
  it('refuses a caller with no workspace, with the status the API sends', () => {
    const bookmarks = store.collection('bookmarks');
    const err = thrown(() => bookmarks.list({orgId: null, userId: 'ada'}));
    assert.equal(err.code, 'no-workspace');
    assert.equal(err.status, 409, 'nowhere to put it is not the same as not allowed');
  });

  it('refuses a per-user domain with no signed-in user', () => {
    const err = thrown(() => store.collection('bookmarks').list({orgId: 'org-lab'}));
    assert.equal(err.code, 'no-identity');
    assert.equal(err.status, 401);
  });

  it('serves an org-shared domain without a user, which the public feeds need', () => {
    const glossary = store.collection('glossary');
    assert.doesNotThrow(() => glossary.list({orgId: 'org-lab'}));
  });

  // Every write path validates too, not just the reads: a store that checked
  // only on the way out would still have let the row be created.
  for (const call of [
    ['put', s => store.collection('tasks').put(s, 'k', {})],
    ['get', s => store.collection('tasks').get(s, 'k')],
    ['remove', s => store.collection('tasks').remove(s, 'k')],
    ['clear', s => store.collection('tasks').clear(s)],
    ['count', s => store.collection('tasks').count(s)],
    ['entries', s => store.collection('tasks').entries(s)],
  ]) {
    const [name, run] = call;
    it(`${name}() refuses a scope with no workspace`, () => {
      assert.throws(() => run({userId: 'ada'}), {code: 'no-workspace'});
    });
  }
});

describe('the domain registry', () => {
  it('refuses a domain nobody declared the ownership of', () => {
    assert.throws(() => store.collection('not-a-feature'), /Unknown store domain/);
  });

  it('exposes one collection per declared domain and no others', () => {
    assert.deepEqual(
      Object.keys(store.collections).sort(),
      [...store.DOMAIN_NAMES].sort(),
      'a domain in the registry with no collection is a feature with nowhere to write',
    );
  });
});

describe('the operations themselves', () => {
  it('upserts rather than duplicating, and keeps the original createdAt', () => {
    const notes = store.collection('notes');
    notes.put(adaLab, '/page', {body: 'first'});
    const [before] = notes.list(adaLab).filter(i => i.key === '/page');
    notes.put(adaLab, '/page', {body: 'second'});
    const [after] = notes.list(adaLab).filter(i => i.key === '/page');

    assert.deepEqual(after.value, {body: 'second'});
    assert.equal(after.createdAt, before.createdAt, 'an edit is not a new item');
  });

  it('update() reads and writes in one step, and deletes on undefined', () => {
    const lists = store.collection('reading-lists');
    lists.put(adaLab, 'queue', {papers: ['a']});

    lists.update(adaLab, 'queue', current => ({papers: [...current.papers, 'b']}));
    assert.deepEqual(lists.get(adaLab, 'queue'), {papers: ['a', 'b']});

    lists.update(adaLab, 'queue', () => undefined);
    assert.equal(lists.get(adaLab, 'queue'), undefined);
  });

  // Everything written in one test is written in one millisecond, which is what
  // makes this the case worth pinning: with createdAt tied, the order has to
  // come from the order of writing and not from how the keys happen to sort.
  it('lists in the order written, not in key order', () => {
    const cards = store.collection('flashcards');
    for (const key of ['zebra', 'apple', 'mango']) cards.put(adaCourse, key, {key});
    assert.deepEqual(cards.list(adaCourse).map(i => i.key), ['zebra', 'apple', 'mango']);
  });

  it('keeps an edited item in its place rather than moving it to the end', () => {
    const cards = store.collection('flashcards');
    for (const key of ['one', 'two', 'three']) cards.put(bobLab, key, {n: 1});
    cards.put(bobLab, 'one', {n: 2});
    assert.deepEqual(cards.list(bobLab).map(i => i.key), ['one', 'two', 'three']);
  });

  it('update() on a missing key sees undefined rather than throwing', () => {
    const lists = store.collection('reading-lists');
    lists.update(adaLab, 'fresh', current => ({seeded: current === undefined}));
    assert.deepEqual(lists.get(adaLab, 'fresh'), {seeded: true});
  });

  it('refuses to store undefined, which would read back as absent', () => {
    assert.throws(() => store.collection('tasks').put(adaLab, 'k', undefined), TypeError);
  });

  it('rejects keys that are not usable strings', () => {
    const tasks = store.collection('tasks');
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.throws(() => tasks.put(adaLab, bad, {}), TypeError, `key ${JSON.stringify(bad)}`);
    }
    assert.throws(() => tasks.put(adaLab, 'x'.repeat(store.MAX_KEY_LENGTH + 1), {}), TypeError);
  });

  it('round-trips the JSON shapes the features actually store', () => {
    const whiteboards = store.collection('whiteboards');
    const value = {n: 1, s: 'two', b: true, nil: null, arr: [1, [2]], deep: {a: {b: 'c'}}};
    whiteboards.put(adaLab, 'board', value);
    assert.deepEqual(whiteboards.get(adaLab, 'board'), value);
  });

  it('entries() returns a prototype-less object, so a key named __proto__ is data', () => {
    const analytics = store.collection('analytics');
    analytics.put(adaCourse, '__proto__', {views: 500});
    const all = analytics.entries(adaCourse);
    assert.equal(Object.getPrototypeOf(all), null);
    assert.deepEqual(all.__proto__, {views: 500});
  });

  it('replaceAll() swaps the contents of one scope and no other', () => {
    const snapshots = store.collection('snapshots');
    snapshots.put(adaLab, 'old', {v: 1});
    snapshots.put(adaCourse, 'keep', {v: 2});

    snapshots.replaceAll(adaLab, {fresh: {v: 3}});

    assert.deepEqual(plain(snapshots.entries(adaLab)), {fresh: {v: 3}});
    assert.deepEqual(plain(snapshots.entries(adaCourse)), {keep: {v: 2}});
  });
});

describe('what the database does when its subjects go', () => {
  it('takes an account\'s private items and leaves the workspace\'s shared ones', () => {
    const at = '2026-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
      .run('cleo', 'Cleo', 'cleo@example.test', at, at);
    const cleo = {orgId: 'org-lab', userId: 'cleo'};

    store.collection('bookmarks').put(cleo, '/gone', {title: 'private'});
    store.collection('glossary').put(cleo, 'stays', {definition: 'the workspace\'s'});

    db.prepare('DELETE FROM "user" WHERE id = ?').run('cleo');

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM store_item WHERE "ownerId" = ?').get('cleo').n,
      0,
      'a deleted account leaves no private rows behind',
    );
    assert.deepEqual(
      store.collection('glossary').get(adaLab, 'stays'),
      {definition: 'the workspace\'s'},
      'the shared term outlives whoever typed it',
    );
  });

  it('takes everything when the workspace itself goes', () => {
    const at = '2026-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO organization (id,name,slug,createdAt) VALUES (?,?,?,?)')
      .run('org-temp', 'Temp', 'temp', at);
    const scope = {orgId: 'org-temp', userId: 'ada'};
    store.collection('tasks').put(scope, 't', {x: 1});
    store.collection('glossary').put(scope, 'g', {x: 2});

    db.prepare('DELETE FROM organization WHERE id = ?').run('org-temp');

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM store_item WHERE "organizationId" = ?').get('org-temp').n,
      0,
    );
  });
});
