import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { newStore } from '../../../_harness.mjs';
import path from 'node:path';
import { key } from '../../../_harness.mjs';

// misc-tools.js is CommonJS; load the REAL module via createRequire the way the
// sibling route tests do (next-content-health-pageids-hoist.test.mjs and
// next-flashcards-review-protokey-guard.test.mjs) and drive three currently
// untested, network-free handlers over a fully mocked ctx: no real filesystem,
// network, subprocess, or randomness. These are ADD-ONLY characterization tests
// that pin the handlers' current, correct behavior so a future refactor cannot
// silently change them. No source file is touched.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// Content is one tree per organization, and the organization comes from the
// session rather than the request, so both handlers below act on this
// workspace's root and report paths relative to it.
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content', 'mochi');
// new Date().toISOString() shape, e.g. 2026-06-13T13:27:33.584Z.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Capture whatever a handler hands to json(res, status, payload). Setting
// res.writableEnded mirrors the real dispatcher's "response already sent" signal.
function makeCapture() {
  const res = { writableEnded: false };
  let captured = null;
  const json = (_res, status, payload) => {
    captured = { status, payload };
    res.writableEnded = true;
    return captured;
  };
  return { res, json, get: () => captured };
}

// A non-memoizing cached(key, ttl, fn): always runs fn(), reproducing the exact
// pre-cache code path so an assertion is never served a stale value. Records each
// call so a test can pin the key and TTL the handler passes.
function makePassThroughCached() {
  const calls = [];
  const cached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
  return { cached, calls };
}

// A memoizing cached(key, ttl, fn) mirroring the server/index.js helper: run fn and
// store on a miss, return the stored value untouched on a hit, store nothing on
// throw. Records every call so a test can pin the exact key and TTL.
function makeMemoCached() {
  const store = new Map();
  const calls = [];
  const cached = (key, ttl, fn) => {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store, calls };
}

// ──────────────────────────── GET /api/calendar ────────────────────────────
// The handler is wrapped in cached('calendar', 60000, fn). fn recursively walks
// the workspace's content root via readdirSync({withFileTypes:true}), reads
// files, filters by ALLOWED_EXTS, and builds a {month, files} grouping. A file's
// date comes from frontmatter; lacking a date: line it falls back to
// statSync().mtime. It also folds in var/data/schedule.json, the store the
// scheduling API writes, when existsSync(schedulePath) is true.

// Counting in-memory fs over a virtual content tree. A string value is a file's
// contents; an object value is a directory. JS preserves insertion order for
// these non-integer keys, so directory listings are deterministic. statSync
// returns a fixed mtime so the no-date fallback stays clock-independent.
function makeCalendarFs(tree) {
  const contentDir = CONTENT_DIR;
  const counts = { readdirSync: 0, readFileSync: 0, statSync: 0, existsSync: 0 };
  function nodeAt(absPath) {
    const rel = path.relative(contentDir, absPath);
    if (rel === '') return tree;
    let node = tree;
    for (const seg of rel.split(path.sep)) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[seg];
    }
    return node;
  }
  const enoent = (p) => { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; return e; };
  const fs = {
    readdirSync(dir) {
      counts.readdirSync++;
      const node = nodeAt(dir);
      if (node === null || typeof node !== 'object') throw enoent(dir);
      return Object.keys(node).map((name) => ({ name, isDirectory: () => typeof node[name] === 'object' }));
    },
    readFileSync(file) {
      counts.readFileSync++;
      const node = nodeAt(file);
      if (typeof node !== 'string') throw enoent(file);
      return node;
    },
    existsSync() {
      counts.existsSync++;
      return false;
    },
    statSync() {
      counts.statSync++;
      return { mtime: new Date('2020-05-10T12:00:00.000Z') };
    },
  };
  return { fs, counts };
}

// Every file carries an explicit date: line, so statSync is never consulted here.
function buildCalendarTree() {
  return {
    blog: {
      'post-a.md': ['---', 'title: Post A', 'date: 2024-01-15', '---', '', 'Hello world from post A.', ''].join('\n'),
      'post-b.md': ['---', 'title: Post B', 'date: 2024-01-03', 'draft: true', '---', '', 'Short body here.', ''].join('\n'),
    },
    research: {
      'paper.md': ['---', 'title: Paper', 'date: 2024-02-20', '---', '', 'One two three four.', ''].join('\n'),
    },
  };
}

// Hand-derived reference (NOT a re-run of the handler). Months sort ascending;
// within a month, files sort by date ascending, so post-b (01-03) precedes
// post-a (01-15). Word counts are over the frontmatter-stripped body.
const EXPECTED_CALENDAR = [
  {
    month: '2024-01',
    files: [
      { path: 'blog/post-b.md', title: 'Post B', date: '2024-01-03', wordCount: 3, draft: true },
      { path: 'blog/post-a.md', title: 'Post A', date: '2024-01-15', wordCount: 5, draft: false },
    ],
  },
  {
    month: '2024-02',
    files: [
      { path: 'research/paper.md', title: 'Paper', date: '2024-02-20', wordCount: 4, draft: false },
    ],
  },
];

async function invokeCalendar({ fs, cached, schedule = [] }) {
  const cap = makeCapture();
  const ctx = {
    fs, path, PROJECT_ROOT, contentRootFor: () => CONTENT_DIR,
    ALLOWED_EXTS: ['.md', '.mdx'], cached, cacheKey: (_orgId, name) => key(name), json: cap.json,
    // The calendar folds in this workspace's scheduled publications. It used to
    // read them from a file it named itself, so they were every workspace's.
    ...newStore().seed('schedule', Object.fromEntries(schedule.map((it, i) => [`s${i}`, it]))).ctxFields,
  };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await miscToolsRoutes(req, cap.res, new URL('http://localhost/api/calendar'), '/api/calendar', ctx);
  return cap.get();
}

describe('GET /api/calendar', () => {
  it('groups dated content files by month with correct path/title/date/wordCount/draft', async () => {
    // Nothing is scheduled here, so the result is purely the walked tree.
    const { fs } = makeCalendarFs(buildCalendarTree());
    const { cached } = makePassThroughCached();
    const r = await invokeCalendar({ fs, cached });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { months: EXPECTED_CALENDAR });
  });

  it('folds in this workspace\'s scheduled publications', async () => {
    // Each item's path is already relative to the workspace's content root,
    // which is what the scheduling API stores.
    const schedule = [
      { publishAt: '2024-03-01T09:00:00Z', path: 'blog/future.md', note: 'Future Post', status: 'planned' },
    ];
    const { fs } = makeCalendarFs(buildCalendarTree());
    const { cached } = makePassThroughCached();
    const r = await invokeCalendar({ fs, cached, schedule });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      months: [
        ...EXPECTED_CALENDAR,
        {
          month: '2024-03',
          files: [{
            path: 'blog/future.md',
            title: 'Future Post',
            date: '2024-03-01',
            wordCount: 0,
            draft: false,
            scheduled: true,
            status: 'planned',
          }],
        },
      ],
    });
  });

  it('falls back to statSync mtime when a file has no date frontmatter', async () => {
    const tree = { 'no-date.md': ['---', 'title: No Date', '---', '', 'body text here.', ''].join('\n') };
    const { fs, counts } = makeCalendarFs(tree);
    const { cached } = makePassThroughCached();
    const r = await invokeCalendar({ fs, cached });
    assert.equal(r.status, 200);
    // statSync stub mtime is 2020-05-10T12:00:00.000Z, so date is 2020-05-10.
    assert.deepEqual(r.payload, {
      months: [{
        month: '2020-05',
        files: [{ path: 'no-date.md', title: 'No Date', date: '2020-05-10', wordCount: 3, draft: false }],
      }],
    });
    assert.equal(counts.statSync, 1, 'the no-date file consulted statSync exactly once');
  });

  it('routes through cached("calendar", 60000) and serves a repeat from cache with no re-walk', async () => {
    const { fs, counts } = makeCalendarFs(buildCalendarTree());
    const { cached, store, calls } = makeMemoCached();

    const first = await invokeCalendar({ fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, { months: EXPECTED_CALENDAR });
    assert.ok(counts.readdirSync >= 1, 'first request walks the tree');
    assert.ok(counts.readFileSync >= 1, 'first request reads files');
    const afterFirst = { readdirSync: counts.readdirSync, readFileSync: counts.readFileSync };

    // The cache key and TTL are exactly what the handler passes.
    assert.equal(calls[0].key, key('calendar'));
    assert.equal(calls[0].ttl, 60000);

    const second = await invokeCalendar({ fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(counts.readdirSync, afterFirst.readdirSync, 'no repeat readdirSync on cache hit');
    assert.equal(counts.readFileSync, afterFirst.readFileSync, 'no repeat readFileSync on cache hit');
    assert.equal(store.size, 1, 'one cache entry under the calendar key');
  });

  it('returns 500 "Calendar generation failed" when the directory walk throws', async () => {
    const throwingFs = {
      readdirSync() { throw new Error('disk gone'); },
      readFileSync() { throw new Error('disk gone'); },
      existsSync() { return false; },
      statSync() { throw new Error('disk gone'); },
    };
    const { cached } = makePassThroughCached();
    const r = await invokeCalendar({ fs: throwingFs, cached });
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Calendar generation failed' });
  });
});

// ─────────────────────────── GET /api/integrity ────────────────────────────
// The handler always returns 200 {status, checks}. status is 'healthy' when
// every check passed, else 'issues'. checks is four entries in fixed order:
// json_validity, yaml_validity, orphaned_snapshots. A failing
// sub-check is captured as passed:false; there is no top-level 500.

const CHECK_NAMES = ['json_validity', 'yaml_validity', 'orphaned_snapshots'];
const VALID_YAML = 'key1:\n  title: Hello\n  year: 2020\n';
// js-yaml rejects this unterminated flow collection with a YAMLException.
const INVALID_YAML = 'key: [a, b';

// In-memory fs for integrity. data/*.json are served by readdirSync (returning
// bare filename strings, the way this handler calls it) plus readFileSync; the
// workspace's own references.yaml is served when refsYaml is provided;
// existsSync reports true only for refPath (when present) and for the listed
// existing paths, which are relative to the workspace's content root.
function makeIntegrityFs({ dataFiles = {}, refsYaml, existingPaths = [] }) {
  const dataDir = path.join(PROJECT_ROOT, 'var', 'data');
  const refPath = path.join(CONTENT_DIR, 'bibliography', 'references.yaml');
  const existing = new Set(existingPaths);
  const enoent = (p) => { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; return e; };
  return {
    readdirSync(dir) {
      if (dir === dataDir) return Object.keys(dataFiles);
      throw enoent(dir);
    },
    readFileSync(fp) {
      if (fp === refPath) {
        if (refsYaml === undefined) throw enoent(fp);
        return refsYaml;
      }
      const rel = path.relative(dataDir, fp);
      if (Object.prototype.hasOwnProperty.call(dataFiles, rel)) return dataFiles[rel];
      throw enoent(fp);
    },
    existsSync(fp) {
      if (fp === refPath) return refsYaml !== undefined;
      return existing.has(path.relative(CONTENT_DIR, fp));
    },
  };
}

async function invokeIntegrity({ fs, loadJSON, snapshots = {} }) {
  const cap = makeCapture();
  const ctx = {
    fs, path, PROJECT_ROOT, contentRootFor: () => CONTENT_DIR, loadJSON,
    COMMENTS_FILE: 'COMMENTS',
    // The orphan check reads this workspace's snapshots, one row per file, and
    // compares each against this workspace's tree. It used to read a store
    // shared by every organization and compare it against one organization's
    // files, so another workspace's paths all counted as orphans.
    ...newStore().seed('snapshots', snapshots).ctxFields,
    json: cap.json,
  };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await miscToolsRoutes(req, cap.res, new URL('http://localhost/api/integrity'), '/api/integrity', ctx);
  return cap.get();
}

const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

describe('GET /api/integrity', () => {
  // A snapshot and a comment whose target file exists, so both orphan checks pass.
  const healthyLoad = (file) =>
    file === 'SNAPSHOTS' ? { 'exists.md': [{ id: 's1' }] } : { 'exists.md': [{ text: 'hi' }] };

  it('reports status "healthy" with all three named checks passed for valid inputs', async () => {
    const fs = makeIntegrityFs({
      dataFiles: { 'comments.json': '{}', 'notes.json': '[1,2,3]' },
      refsYaml: VALID_YAML,
      existingPaths: ['exists.md'],
    });
    const r = await invokeIntegrity({ fs, loadJSON: healthyLoad });
    assert.equal(r.status, 200);
    assert.equal(r.payload.status, 'healthy');
    assert.deepEqual(r.payload.checks.map((c) => c.name), CHECK_NAMES);
    assert.deepEqual(r.payload.checks, [
      { name: 'json_validity', passed: true, details: 'All 2 JSON files are valid' },
      { name: 'yaml_validity', passed: true, details: 'references.yaml is valid YAML' },
      { name: 'orphaned_snapshots', passed: true, details: 'No orphaned snapshots' },
    ]);
  });

  it('flags json_validity and returns status "issues" for a malformed data/*.json file', async () => {
    const fs = makeIntegrityFs({
      dataFiles: { 'good.json': '{}', 'bad.json': '{not json' },
      refsYaml: VALID_YAML,
      existingPaths: ['exists.md'],
    });
    const r = await invokeIntegrity({ fs, loadJSON: healthyLoad });
    assert.equal(r.status, 200);
    assert.equal(r.payload.status, 'issues');
    assert.deepEqual(r.payload.checks.map((c) => c.name), CHECK_NAMES);
    const checks = byName(r.payload.checks);
    assert.deepEqual(checks.json_validity, {
      name: 'json_validity', passed: false, details: '1 invalid JSON file(s): bad.json',
    });
    // The other three checks remain healthy.
    assert.equal(checks.yaml_validity.passed, true);
    assert.equal(checks.orphaned_snapshots.passed, true);
  });

  it('flags yaml_validity for an invalid references.yaml', async () => {
    const fs = makeIntegrityFs({
      dataFiles: { 'comments.json': '{}' },
      refsYaml: INVALID_YAML,
      existingPaths: ['exists.md'],
    });
    const r = await invokeIntegrity({ fs, loadJSON: healthyLoad });
    assert.equal(r.status, 200);
    assert.equal(r.payload.status, 'issues');
    const checks = byName(r.payload.checks);
    assert.equal(checks.yaml_validity.passed, false);
    // The exception text carries parser internals, so pin only the stable prefix.
    assert.ok(
      checks.yaml_validity.details.startsWith('references.yaml is invalid'),
      'yaml_validity details report the invalid file',
    );
    assert.equal(checks.json_validity.passed, true);
  });

  it('flags orphaned_snapshots when a snapshot target file no longer exists', async () => {
    const fs = makeIntegrityFs({
      dataFiles: { 'comments.json': '{}' },
      refsYaml: VALID_YAML,
      existingPaths: [],
    });
    // The snapshot target deleted.md is absent from existingPaths.
    const r = await invokeIntegrity({
      fs,
      loadJSON: healthyLoad,
      snapshots: { 'deleted.md': [{ id: 's1' }, { id: 's2' }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.status, 'issues');
    const checks = byName(r.payload.checks);
    assert.deepEqual(checks.orphaned_snapshots, {
      name: 'orphaned_snapshots', passed: false, details: '1 orphaned snapshot(s): deleted.md (2)',
    });
  });

});
