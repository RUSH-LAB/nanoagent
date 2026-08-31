/**
 * No route module may reach per-workspace data except through server/store.
 *
 * The store makes scoping structural: a handler passes the scope it was given
 * and has no method available that would let it name another workspace or
 * another person. That guarantee is worth exactly as much as the number of
 * handlers that actually go through it, and nothing in the language stops one
 * from calling loadJSON on a shared file instead. So it is checked here.
 *
 * The check runs against the source text rather than against behaviour, which
 * is unusual and is the point: what is being asserted is that a certain kind of
 * code is absent, and absence is not observable by calling anything.
 *
 * This began as a countdown. Thirteen features kept their data in a JSON file
 * each, and a MIGRATING list here recorded which had not moved yet, failing in
 * both directions so that neither reaching around the layer nor leaving a stale
 * exemption behind could pass unnoticed.
 *
 * They have all moved, so the list is gone and what is left is the rule it was
 * counting down to: no route module opens any of these stores as a file, and
 * none prepares SQL of its own.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const {DOMAIN_NAMES} = createRequire(import.meta.url)('../../../../src/server/store/domains.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(HERE, '../../../../src/server/routes');

/** The ctx name a domain's JSON file is passed under: notes -> NOTES_FILE. */
const constantFor = domain => `${domain.toUpperCase().replaceAll('-', '_')}_FILE`;

/**
 * Whether `body` mentions the constant, as a whole identifier.
 *
 * Not a substring test, which is what this was and what it got wrong: NOTES_FILE
 * is a substring of QUICKNOTES_FILE, so study-knowledge.js was recorded as still
 * opening `notes` when what it opens is the quicknotes store, and `notes` was
 * exempted there for a use that did not exist. A left boundary is enough, since
 * every one of these names ends in the same suffix.
 */
const mentions = (body, constant) => new RegExp(`\\b${constant}\\b`).test(body);

/**
 * Whether `body` builds this domain's file path itself.
 *
 * Not every store arrives on ctx under a constant. Three are assembled in the
 * handler out of dataFileSegs('name'), which reaches exactly the same file by a
 * route the constant check cannot see, and two of them (quicknotes,
 * preferences) were therefore missing from the domain registry altogether. A
 * check that only knows one spelling of the thing it forbids is a check for the
 * spelling.
 */
const buildsPathFor = (body, domain) =>
  new RegExp(`dataFileSegs\\(\\s*['"]${domain}['"]`).test(body);

/**
 * Every route module's source, with the ctx destructure removed.
 *
 * That one line names every field ctx carries and is byte-identical across all
 * the route modules by design, so it mentions every store constant in every
 * file and would make this test see uses that are not there. What remains is
 * the body, where a mention is a use.
 */
function routeBodies() {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter(name => name.endsWith('.js'))
    .map(name => ({
      name,
      body: fs
        .readFileSync(path.join(ROUTES_DIR, name), 'utf-8')
        .split('\n')
        .filter(line => !line.includes('appendAccessLog, walkDir'))
        .join('\n'),
    }));
}

const BODIES = routeBodies();

/** Which of `domains` appear in the body of `name`. */
function domainsUsedBy(name, domains) {
  const {body} = BODIES.find(r => r.name === name) ?? {body: ''};
  return domains.filter(
    domain => mentions(body, constantFor(domain)) || buildsPathFor(body, domain),
  );
}

describe('every route module', () => {
  // The domains, spelled here rather than imported, so that renaming one in the
  // registry cannot silently empty this check.
  const ALL = [
    'bookmarks', 'flashcards', 'streaks', 'tasks', 'reading-lists', 'notes',
    'quicknotes', 'preferences',
    'glossary', 'schedule', 'whiteboards', 'analytics', 'snapshots',
  ];

  for (const {name} of BODIES) {
    it(`${name} opens none of them as a file`, () => {
      const unexpected = domainsUsedBy(name, ALL);
      assert.deepEqual(
        unexpected,
        [],
        `${name} reads or writes ${unexpected.join(', ')} as a JSON file. That data `
          + 'belongs to one workspace and one person; go through server/store, which '
          + 'applies both, instead of loadJSON, which applies neither.',
      );
    });
  }

  // The registry and the list above have to name the same things, or a domain
  // added to one and not the other is a store nothing here forbids opening.
  it('checks every domain the registry declares', () => {
    assert.deepEqual([...ALL].sort(), [...DOMAIN_NAMES].sort());
  });
});

describe('the database itself', () => {
  // Chat and organizations own tables and query them through their own modules
  // (server/chat.js, server/org.js), which is the same arrangement the store
  // has. What no route may do is prepare its own statement, because a statement
  // written in a handler is a WHERE clause somebody has to remember.
  for (const {name, body} of BODIES) {
    it(`${name} prepares no SQL of its own`, () => {
      assert.ok(
        !/\brequire\(['"][./]*\.\.\/db['"]\)/.test(body),
        `${name} requires the database directly. Reach it through server/store, `
          + 'server/chat.js or server/org.js, each of which scopes what it returns.',
      );
      assert.ok(
        !/\bdb\s*\.\s*prepare\s*\(/.test(body),
        `${name} calls db.prepare. A query written in a handler is an isolation `
          + 'predicate that has to be remembered; the point of server/store is that '
          + 'it cannot be forgotten.',
      );
    });
  }
});
