import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { newStore } from '../../_harness.mjs';

/**
 * The 60-second scheduled-publishing loop in server/index.js.
 *
 * It had never run: it read a filename the API did not write, in a shape the
 * API did not write, so every tick did nothing. What the tests below pin is the
 * repair, and the two things the repair had to get right beyond reading the
 * data at all.
 *
 * The path check is the first. The loop resolves `schedule.path` and writes to
 * it, and that field comes from the body of POST /api/schedule, where it is
 * only passed through sanitizeText. Without the check this is an
 * arbitrary-file-write primitive for any signed-in caller.
 *
 * The workspace is the second. The loop belongs to no caller, so it takes no
 * scope from a request; it walks every organization and acts inside each one.
 * A path resolves against that workspace's content root, and the caches it
 * drops are that workspace's, so one lab publishing does not clear another's
 * search index.
 *
 * server/index.js calls server.listen() at load and exports nothing, so, as in
 * the sibling source-lift tests here, the callback's real bytes are lifted out
 * by brace balancing and instantiated with injected dependencies. Nothing boots
 * a server and nothing touches the disk.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SOURCE = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
const PROJECT_ROOT = '/fake/root';
/** Two workspaces, so a case can prove the loop keeps them apart. */
const ORGS = [{id: 'org-lab', slug: 'lab'}, {id: 'org-course', slug: 'course'}];
const rootOf = orgId => `${PROJECT_ROOT}/content/${ORGS.find(o => o.id === orgId).slug}`;

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
    'org', 'store', 'isValidFilePath', 'invalidateCache', 'cacheKey',
    'contentRootFor', 'path', 'fs', 'console',
    body,
  );
}

const publisherSource = liftPublisher();

/** The real validator, so the guard under test is the one that ships. */
import { isValidFilePath } from '../../../../src/server/server-utils.js';

/**
 * Drive one tick.
 *
 * `items` are scheduled in the first workspace unless a case says otherwise;
 * `byOrg` schedules per workspace, for the isolation cases. The store is the
 * real one over a throwaway database, so what the loop reads and writes back is
 * what the API would have.
 */
function harness({items = [], byOrg, files = {}} = {}) {
  const scheduled = byOrg ?? {[ORGS[0].id]: items};
  const disk = new Map(Object.entries(files));
  const logged = [];
  const invalidated = [];

  const scoped = newStore();
  for (const [orgId, rows] of Object.entries(scheduled)) {
    const scope = {orgId, userId: null};
    rows.forEach((row, i) => scoped.scoped.collection('schedule').put(scope, row.id ?? `s${i}`, row));
  }
  const writes = [];
  const collection = name => {
    const real = scoped.scoped.collection(name);
    return {...real, put: (scope, key, value) => { writes.push({scope, key, value}); return real.put(scope, key, value); }};
  };

  const run = publisherSource(
    {allOrganizations: () => ORGS},
    {collection},
    isValidFilePath,
    pattern => invalidated.push(pattern),
    (orgId, name) => `org:${orgId}:${name}`,
    rootOf,
    path.posix,
    {
      existsSync: p => disk.has(p),
      readFileSync: p => disk.get(p),
      writeFileSync: (p, data) => disk.set(p, data),
    },
    {log: (...a) => logged.push(a.join(' ')), error: (...a) => logged.push(a.join(' '))},
  );

  run();
  return {disk, saved: writes, logged, invalidated, store: scoped};
}

const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
// Workspace-relative, which is what a request carries and what the row holds.
const CONTENT = 'posts/blog/scheduled.md';
const ON_DISK = `${rootOf(ORGS[0].id)}/${CONTENT}`;

describe('the scheduled-publishing loop', () => {
  it('reads the store the API actually writes', () => {
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
    assert.equal(saved[0].value.status, 'published');
    assert.ok(saved[0].value.publishedAt, 'and records when');
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
    assert.deepEqual(published.invalidated, ['org:org-lab:search', 'org:org-lab:stats']);

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
      const resolved = path.posix.join(rootOf(ORGS[0].id), escape);
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
    const at = `${rootOf(ORGS[0].id)}/books/math/0-intro.md`;
    const {disk} = harness({
      items: [{path: 'books/math/0-intro.md', publishAt: PAST, status: 'scheduled'}],
      files: {[at]: '---\ndraft: true\n---\nx\n'},
    });
    assert.match(disk.get(at), /^draft: false$/m);
  });

  it('skips a scheduled file that is no longer there, without failing the tick', () => {
    const at = `${rootOf(ORGS[0].id)}/books/math/0-intro.md`;
    const {saved, logged} = harness({
      items: [
        {path: CONTENT, publishAt: PAST, status: 'scheduled'},
        {path: 'books/math/0-intro.md', publishAt: PAST, status: 'scheduled'},
      ],
      files: {[at]: '---\ndraft: true\n---\nx\n'},
    });
    assert.ok(logged.some(l => l.includes('file not found')));
    assert.equal(saved.length, 1, 'and still publishes the sibling that is there');
  });

  // The loop serves every workspace, and the same relative path means a
  // different file in each. Before content moved to one tree per organization
  // this resolved against the repository root, so a path scheduled anywhere
  // reached one file for everybody.
  it('resolves each workspace\'s path against that workspace\'s content root', () => {
    const labFile = `${rootOf('org-lab')}/${CONTENT}`;
    const courseFile = `${rootOf('org-course')}/${CONTENT}`;
    const {disk, invalidated} = harness({
      byOrg: {
        'org-lab': [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
        'org-course': [{path: CONTENT, publishAt: FUTURE, status: 'scheduled'}],
      },
      files: {
        [labFile]: '---\ndraft: true\n---\nlab\n',
        [courseFile]: '---\ndraft: true\n---\ncourse\n',
      },
    });
    assert.match(disk.get(labFile), /^draft: false$/m, 'the due one publishes');
    assert.match(disk.get(courseFile), /^draft: true$/m, 'the other workspace is untouched');
    assert.deepEqual(invalidated, ['org:org-lab:search', 'org:org-lab:stats'],
      'and only the publishing workspace loses its derived caches');
  });
});
