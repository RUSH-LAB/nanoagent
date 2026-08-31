import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The 60-second scheduled-publishing loop in server/index.js.
 *
 * It had never run. It read var/data/schedules.json while the API writes
 * var/data/schedule.json, so every tick loaded {} and returned; and it expected
 * a bare array where the API writes {items: [...]}, so fixing only the filename
 * would still have done nothing. The tests below pin all three halves of the
 * repair: the store it reads, the shape it reads, and the path check.
 *
 * The path check is the one that matters. The loop joins `schedule.path` onto
 * the repo root and writes to it, and that field comes from the body of POST
 * /api/schedule, where it is only passed through sanitizeText. Had either of
 * the other two bugs been fixed alone, this would have been an arbitrary-file
 * -write primitive for any signed-in caller.
 *
 * server/index.js calls server.listen() at load and exports nothing, so, as in
 * the sibling source-lift tests here, the callback's real bytes are lifted out
 * by brace balancing and instantiated with injected dependencies. Nothing boots
 * a server and nothing touches the disk.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SOURCE = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
const SCHEDULE_FILE = '/fake/root/var/data/schedule.json';
const PROJECT_ROOT = '/fake/root';

/**
 * Lift the `setInterval(() => { ... }, 60000)` callback that follows the
 * scheduled-publishing banner, by balancing braces from its opening line.
 * Fails loud rather than silently matching the wrong interval.
 */
function liftPublisher() {
  const lines = SOURCE.split('\n');
  const banner = lines.findIndex(l => l.includes('Scheduled publishing checker'));
  assert.ok(banner !== -1, 'server/index.js must still have the scheduled-publishing banner');
  const start = lines.findIndex((l, i) => i > banner && l.startsWith('setInterval('));
  assert.ok(start !== -1, 'the banner must be followed by a top-level setInterval(');

  let depth = 0, opened = false, end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth === 0) { end = i; break; }
  }
  assert.ok(end !== -1, 'could not find the end of the scheduled-publishing interval');

  const body = lines.slice(start, end + 1).join('\n')
    // Run the callback on demand instead of on a timer.
    .replace(/^setInterval\(/, 'return (')
    .replace(/,\s*60000\);\s*$/, ');');

  return new Function(
    'loadJSON', 'saveJSON', 'isValidFilePath', 'invalidateCache',
    'path', 'fs', 'PROJECT_ROOT', 'SCHEDULE_FILE', 'console',
    body,
  );
}

const publisherSource = liftPublisher();

/** The real validator, so the guard under test is the one that ships. */
import { isValidFilePath } from '../../../../src/server/server-utils.js';

function harness({items = [], files = {}} = {}) {
  const store = {items};
  const disk = new Map(Object.entries(files));
  const saved = [];
  const logged = [];
  const invalidated = [];

  const run = publisherSource(
    key => (key === SCHEDULE_FILE ? JSON.parse(JSON.stringify(store)) : {}),
    (key, value) => saved.push({key, value}),
    isValidFilePath,
    pattern => invalidated.push(pattern),
    path.posix,
    {
      existsSync: p => disk.has(p),
      readFileSync: p => disk.get(p),
      writeFileSync: (p, data) => disk.set(p, data),
    },
    PROJECT_ROOT,
    SCHEDULE_FILE,
    {log: (...a) => logged.push(a.join(' ')), error: (...a) => logged.push(a.join(' '))},
  );

  run();
  return {disk, saved, logged, invalidated};
}

const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const CONTENT = 'content/posts/blog/scheduled.md';
const ON_DISK = `${PROJECT_ROOT}/${CONTENT}`;

describe('the scheduled-publishing loop', () => {
  it('reads the store the API actually writes, and its {items} shape', () => {
    // Both halves of the original defect at once: with the old filename the
    // load returned {}, and with the old bare-array read `store.items` would
    // have been undefined.
    const {disk} = harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      files: {[ON_DISK]: '---\ndraft: true\n---\nbody\n'},
    });
    assert.match(disk.get(ON_DISK), /^draft: false$/m);
  });

  it('flips an existing draft key rather than adding a second one', () => {
    const {disk} = harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      files: {[ON_DISK]: '---\ntitle: X\ndraft: true\n---\nbody\n'},
    });
    const published = disk.get(ON_DISK);
    assert.equal(published.match(/^draft:/gm).length, 1);
    assert.match(published, /^title: X$/m);
  });

  it('adds the key to frontmatter that has none', () => {
    const {disk} = harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      files: {[ON_DISK]: '---\ntitle: X\n---\nbody\n'},
    });
    assert.match(disk.get(ON_DISK), /^draft: false$/m);
  });

  it('gives a file with no frontmatter at all a block of its own', () => {
    const {disk} = harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      files: {[ON_DISK]: 'just a body\n'},
    });
    assert.equal(disk.get(ON_DISK), '---\ndraft: false\n---\njust a body\n');
  });

  it('leaves an item whose time has not come', () => {
    const {disk, saved} = harness({
      items: [{path: CONTENT, publishAt: FUTURE, status: 'scheduled'}],
      files: {[ON_DISK]: '---\ndraft: true\n---\nbody\n'},
    });
    assert.match(disk.get(ON_DISK), /^draft: true$/m);
    assert.deepEqual(saved, [], 'and writes nothing back');
  });

  it('keeps the row, marked published, rather than dropping it', () => {
    const {saved} = harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      files: {[ON_DISK]: '---\ndraft: true\n---\nbody\n'},
    });
    assert.equal(saved.length, 1);
    const [item] = saved[0].value.items;
    assert.equal(item.status, 'published');
    assert.ok(item.publishedAt, 'and records when');
  });

  it('does not publish the same item twice', () => {
    const {disk, saved} = harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'published'}],
      files: {[ON_DISK]: '---\ndraft: true\n---\nbody\n'},
    });
    assert.match(disk.get(ON_DISK), /^draft: true$/m, 'the file is left alone');
    assert.deepEqual(saved, []);
  });

  it('drops the derived caches once, only when something was published', () => {
    const published = harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      files: {[ON_DISK]: '---\ndraft: true\n---\nbody\n'},
    });
    assert.deepEqual(published.invalidated, ['search', 'stats']);

    const quiet = harness({items: [{path: CONTENT, publishAt: FUTURE, status: 'scheduled'}]});
    assert.deepEqual(quiet.invalidated, []);
  });

  it('does nothing at all on an empty store', () => {
    const {saved, invalidated} = harness();
    assert.deepEqual(saved, []);
    assert.deepEqual(invalidated, []);
  });

  // The guard. Each of these resolves outside the content tree and would have
  // been written to before the check was added.
  //
  // The victim file is seeded at the path the loop would RESOLVE to, not at the
  // literal string: `path.join('/fake/root', '../../etc/passwd')` is
  // `/etc/passwd`, so a harness that seeded '/fake/root/../../etc/passwd' would
  // watch the wrong key, see no write, and pass whether the guard existed or
  // not. Removing the guard from the lifted source makes each of these fail,
  // which is the only thing that makes them worth having.
  for (const [why, escape] of [
    ['a parent-directory escape', '../../etc/passwd'],
    ['an escape that starts inside content', 'content/../../.ssh/authorized_keys'],
    ['an absolute path', '/etc/passwd'],
    ['a path outside content/', 'src/server/index.js'],
    ['a file the content tree would not serve', 'content/books/math/.env'],
  ]) {
    it(`refuses ${why}, and writes nothing`, () => {
      const resolved = path.posix.join(PROJECT_ROOT, escape);
      assert.equal(isValidFilePath(escape), false, 'the fixture must really be out of bounds');
      const {disk, saved, logged} = harness({
        items: [{path: escape, publishAt: PAST, status: 'scheduled'}],
        files: {[resolved]: 'untouched'},
      });
      assert.equal(disk.get(resolved), 'untouched', 'the file the loop would reach is unchanged');
      assert.deepEqual(saved, [], 'and does not mark it published');
      assert.ok(logged.some(l => l.includes('Refusing')), 'and says why');
    });
  }

  it('accepts an ordinary content path, so the guard is not refusing everything', () => {
    const {disk} = harness({
      items: [{path: 'content/books/math/0-intro.md', publishAt: PAST, status: 'scheduled'}],
      files: {[`${PROJECT_ROOT}/content/books/math/0-intro.md`]: '---\ndraft: true\n---\nx\n'},
    });
    assert.match(disk.get(`${PROJECT_ROOT}/content/books/math/0-intro.md`), /^draft: false$/m);
  });

  it('skips a scheduled file that is no longer there, without failing the tick', () => {
    const {saved, logged} = harness({
      items: [
        {path: CONTENT, publishAt: PAST, status: 'scheduled'},
        {path: 'content/books/math/0-intro.md', publishAt: PAST, status: 'scheduled'},
      ],
      files: {[`${PROJECT_ROOT}/content/books/math/0-intro.md`]: '---\ndraft: true\n---\nx\n'},
    });
    assert.ok(logged.some(l => l.includes('file not found')));
    assert.equal(saved.length, 1, 'and still publishes the sibling that is there');
  });
});
