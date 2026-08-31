#!/usr/bin/env node
/**
 * Move the thirteen features' data out of var/data/*.json and into the scoped
 * store, once.
 *
 * The handlers stopped reading those files when each feature moved onto
 * server/store; the files are still there, holding whatever was in them at that
 * moment. This carries it across so that the move is not also a deletion.
 *
 * Two things it has to decide that the files cannot answer:
 *
 *   Which workspace.  The files predate organizations. Everything goes to the
 *                     primary one, which is where the content of that era also
 *                     went, unless --org names another slug.
 *   Whose.            Four of the stores were keyed by user id, so those bring
 *                     their own answer. The rest had no owner at all; their
 *                     rows go to --owner, defaulting to the root account.
 *
 * Test residue is skipped. The suites wrote through to the real store for
 * years, so these files are mostly `__test_...` and `wftest-...` keys with a
 * few genuine rows among them, and carrying the fixtures across would make the
 * new tables look busy while saying nothing.
 *
 * Idempotent: every write is an upsert on the same key, so running it twice
 * lands the same rows. It never deletes the JSON files; that is a separate
 * decision, and the files are the only copy until somebody makes it.
 *
 *   node scripts/migrate-json-stores.mjs            # report what it would do
 *   node scripts/migrate-json-stores.mjs --write    # do it
 *   node scripts/migrate-json-stores.mjs --write --org lab --owner ada
 */
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const WRITE = argv.includes('--write');
const ORG_SLUG = flag('org');
const OWNER = flag('owner');

const {db} = require(path.join(ROOT, 'src/server/db.js'));
const store = require(path.join(ROOT, 'src/server/store/index.js'));
const {PRIMARY_ORG_SLUG, DATA_DIR} = require(path.join(ROOT, 'src/server/paths.js'));

/**
 * A key written by the test suites rather than by a person.
 *
 * Deliberately broad. A false positive loses a row somebody could recreate in a
 * second; a false negative puts a fixture in front of them forever.
 */
const TEST_KEY = /(^__|^wftest|^test-|__test_|__xtest_|__rem_)/;
const isFixture = key => TEST_KEY.test(String(key));

/** Legacy owner ids from before accounts existed, mapped to the chosen owner. */
const LEGACY_OWNERS = new Set(['default', 'dev-user', 'anonymous']);

/**
 * Whether an account still exists.
 *
 * The per-user files hold ids from every database this checkout has ever had,
 * including ones recreated from scratch, so some of them name accounts that are
 * gone. The foreign key refuses those rows, correctly, and the migration has to
 * decide rather than crash: the row belonged to somebody who is not here, and
 * handing it to whoever runs the script would be inventing an owner.
 */
const accountExists = (() => {
  const known = new Map();
  const query = db.prepare('SELECT 1 FROM "user" WHERE id = ?');
  return id => {
    if (!known.has(id)) known.set(id, Boolean(query.get(id)));
    return known.get(id);
  };
})();

function resolveOrg() {
  const slug = ORG_SLUG || PRIMARY_ORG_SLUG;
  const row = db.prepare('SELECT id, slug FROM organization WHERE slug = ?').get(slug);
  if (!row) {
    throw new Error(
      `No workspace with the slug "${slug}". Start the server once to provision `
      + 'the primary one, or pass --org with a slug that exists.',
    );
  }
  return row;
}

function resolveOwner() {
  if (OWNER) {
    const row = db
      .prepare('SELECT id, username FROM "user" WHERE id = ? OR username = ?')
      .get(OWNER, OWNER);
    if (!row) throw new Error(`No account matching "${OWNER}".`);
    return row;
  }
  // The oldest account, which on a machine that has only ever run this app is
  // root. Named in the report either way, so a wrong guess is visible before
  // --write is passed.
  const row = db.prepare('SELECT id, username FROM "user" ORDER BY "createdAt", rowid LIMIT 1').get();
  if (!row) throw new Error('No accounts exist yet. Start the server once, or pass --owner.');
  return row;
}

/** Read one legacy store, or null when it was never written. */
function readLegacy(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * How each legacy shape becomes rows.
 *
 * Each returns `[{ownerLegacyId, key, value}]`, where ownerLegacyId is the id
 * the file itself carried for a per-user store and null for one that had no
 * notion of an owner.
 */
const ADAPTERS = {
  // {bookmarks: [{path, ...}], folders: [...]} -- one row per bookmark, keyed
  // by its page path. `folders` had no endpoint left and is dropped.
  bookmarks: data => (data.bookmarks ?? []).map(b => ({ownerLegacyId: null, key: b.path, value: b})),

  // {key: note}
  notes: data => Object.entries(data).map(([key, value]) => ({ownerLegacyId: null, key, value})),

  // {userId: {dailyLog: [{date, words}]}}
  streaks: data => Object.entries(data).flatMap(([userId, held]) =>
    (held?.dailyLog ?? []).map(entry => ({ownerLegacyId: userId, key: entry.date, value: entry}))),

  // {userId: [card]}
  flashcards: data => Object.entries(data).flatMap(([userId, cards]) =>
    (Array.isArray(cards) ? cards : []).map(card => ({ownerLegacyId: userId, key: card.id, value: card}))),

  // {userId: [note]}
  quicknotes: data => Object.entries(data).flatMap(([userId, notes]) =>
    (Array.isArray(notes) ? notes : []).map(note => ({ownerLegacyId: userId, key: note.id, value: note}))),

  // {userId: {setting: value}} -- one row per account, under the fixed key the
  // handler reads.
  preferences: data => Object.entries(data).map(([userId, settings]) =>
    ({ownerLegacyId: userId, key: 'settings', value: settings})),

  // {terms: [entry]}
  glossary: data => (data.terms ?? []).map(t => ({ownerLegacyId: null, key: t.id, value: t})),

  // {lists: [list]}
  'reading-lists': data => (data.lists ?? []).map(l => ({ownerLegacyId: null, key: l.id, value: l})),

  // {tasks: [task]}
  tasks: data => (data.tasks ?? []).map(t => ({ownerLegacyId: null, key: t.id, value: t})),

  // {items: [item]}
  schedule: data => (data.items ?? []).map(i => ({ownerLegacyId: null, key: i.id, value: i})),

  // {boardId: board}
  whiteboards: data => Object.entries(data).map(([key, value]) => ({ownerLegacyId: null, key, value})),

  // {contentPath: [snapshot]}
  snapshots: data => Object.entries(data).map(([key, value]) => ({ownerLegacyId: null, key, value})),

  // {counts: {path: n}, recent: [event]} -- the two key spaces the handler uses.
  analytics: data => [
    ...Object.entries(data.counts ?? {}).map(([p, n]) => ({ownerLegacyId: null, key: `count:${p}`, value: n})),
    ...(data.recent?.length ? [{ownerLegacyId: null, key: 'recent', value: data.recent}] : []),
  ],
};

function main() {
  const org = resolveOrg();
  const owner = resolveOwner();
  console.log(`Workspace: ${org.slug} (${org.id})`);
  console.log(`Owner for the stores that had none: ${owner.username ?? owner.id}`);
  console.log(WRITE ? 'Writing.\n' : 'Dry run. Pass --write to apply.\n');

  let migrated = 0;
  let skipped = 0;

  for (const [domain, adapt] of Object.entries(ADAPTERS)) {
    const data = readLegacy(domain);
    if (!data) continue;

    let rows;
    try {
      rows = adapt(data).filter(r => r.key !== undefined && r.key !== null && r.value !== undefined);
    } catch (err) {
      console.log(`${domain.padEnd(14)} could not be read: ${err.message}`);
      continue;
    }

    const keep = rows.filter(r => !isFixture(r.key) && !isFixture(r.ownerLegacyId ?? ''));
    const dropped = rows.length - keep.length;
    if (rows.length === 0) continue;

    let orphaned = 0;
    // Two legacy owner ids can map to the same account, and then their rows can
    // collide on a key: `default` and `dev-user` are both the person running
    // this, and both recorded a writing streak on the same day. The last one
    // wins, which is the only answer available, but it is a merge rather than
    // two writes and the report should not claim otherwise.
    const byIdentity = new Map();
    for (const row of keep) {
      // A per-user store brings its own owner unless that owner is one of the
      // ids from before accounts existed, which nobody can sign in as.
      const legacy = row.ownerLegacyId;
      const named = legacy && !LEGACY_OWNERS.has(legacy);
      if (named && !accountExists(legacy)) {
        orphaned++;
        continue;
      }
      const userId = named ? legacy : owner.id;
      byIdentity.set(`${userId} ${row.key}`, {userId, row});
    }
    const merged = keep.length - orphaned - byIdentity.size;

    for (const {userId, row} of byIdentity.values()) {
      if (WRITE) store.collection(domain).put({orgId: org.id, userId}, row.key, row.value);
    }

    migrated += byIdentity.size;
    skipped += dropped + orphaned;
    const notes = [];
    if (dropped) notes.push(`${dropped} fixture${dropped === 1 ? '' : 's'}`);
    if (orphaned) notes.push(`${orphaned} belonging to accounts that no longer exist`);
    if (merged) notes.push(`${merged} merged onto a row of the same key`);
    const note = notes.length ? `, skipped ${notes.join(', ')}` : '';
    console.log(`${domain.padEnd(14)} ${String(byIdentity.size).padStart(4)} row(s)${note}`);
  }

  console.log(`\n${migrated} row(s)${WRITE ? ' written' : ' would be written'}, ${skipped} fixture(s) skipped.`);
  if (WRITE) {
    console.log('The JSON files are left in place; they are the only other copy.');
  }
}

try {
  main();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
