import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load the real module the way the sibling route
// tests do (see tests/next-analysisadmin-loadrefs-reuse.test.mjs and
// tests/next-dashboard-500.test.mjs), so this characterization test drives the
// genuine GET /api/dashboard handler (analysis-admin.js:878) rather than a
// reimplementation.
const require = createRequire(import.meta.url);
const analysisAdminRoutes = require('../server/routes/analysis-admin.js');
// loadReferencesCached memoizes references.yaml in a module-level singleton;
// clear it between cases so the reference count re-stats and re-reads from the
// fixture deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

// A distinct root keeps every fixture path clear of the sibling tests' '/fake/root'
// so the shared references memo cannot serve stale data across files.
const PROJECT_ROOT = '/fake/dashboard-root';
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
const CONTENT_POSTS = path.join(CONTENT_DIR, 'posts');
const TESTS_DIR = path.join(PROJECT_ROOT, 'tests');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

const ANALYTICS_FILE = 'analytics.json';
const COMMENTS_FILE = 'comments.json';
const DISCUSSIONS_FILE = 'discussions.json';

// Two-entry bibliography. loadReferencesCached parses it for content.references,
// and the inline integrity probe re-parses it (existsSync then yaml.load); both
// succeed, so health.integrity stays 'healthy' and content.references === 2.
const REFS_YAML = `ref_a:
  title: First Paper
  year: 2020
ref_b:
  title: Second Paper
  year: 2021
`;

// Test sources read by the suite scanner. The handler counts matches of
// /\bit\s*\(|test\s*\(/g over each *.test.mjs file. The per-file counts are
// 2, 1, and 3, so totalTests === 6 across suites === 3.
const A_SRC = "it('a one', () => {});\nit('a two', () => {});\n"; // 2 matches
const B_SRC = "test('b one', () => {});\n"; // 1 match
const C_SRC = "it('c one', () => {});\ntest('c two', () => {});\nit('c three', () => {});\n"; // 3 matches

// In-memory content/tests/data tree plus the bibliography, addressed by the exact
// path.join keys the handler builds. readFileSync ignores the encoding argument.
const FILES = {
  [path.join(CONTENT_DIR, 'intro.mdx')]: 'one two', // 2 words
  [path.join(CONTENT_POSTS, 'hello.md')]: 'alpha beta gamma', // 3 words
  [path.join(TESTS_DIR, 'a.test.mjs')]: A_SRC,
  [path.join(TESTS_DIR, 'b.test.mjs')]: B_SRC,
  [path.join(TESTS_DIR, 'sub/c.test.mjs')]: C_SRC,
  [path.join(DATA_DIR, 'users.json')]: '{}',
  [path.join(DATA_DIR, 'bookmarks.json')]: '{}',
  [REFS_PATH]: REFS_YAML,
};

// Directory listings keyed by the readdirSync access shape the handler uses:
//   content walk  -> readdirSync(dir, {withFileTypes: true}) yields Dirents,
//   suite scan    -> readdirSync(testsDir, {recursive: true}) yields strings,
//   integrity     -> readdirSync(dataDir) yields strings.
const dirent = (name, isDir) => ({ name, isDirectory: () => isDir, isFile: () => !isDir });
const WITH_FILE_TYPES = {
  // '.hidden' is skipped by the leading-dot guard before any recursion, so it is
  // never listed; 'skip.txt' fails the ALLOWED_EXTS filter and is not counted.
  [CONTENT_DIR]: [dirent('posts', true), dirent('.hidden', true), dirent('intro.mdx', false)],
  [CONTENT_POSTS]: [dirent('hello.md', false), dirent('skip.txt', false)],
};
const RECURSIVE = {
  // 'notatest.mjs' and 'readme.md' fail the *.test.mjs filter; only three suites count.
  [TESTS_DIR]: ['a.test.mjs', 'b.test.mjs', 'sub/c.test.mjs', 'notatest.mjs', 'readme.md'],
};
const PLAIN = {
  // Both JSON files parse, so the integrity probe stays healthy; 'notes.txt' is filtered out.
  [DATA_DIR]: ['users.json', 'bookmarks.json', 'notes.txt'],
};

// loadJSON dispatcher for the activity fold. Pageviews sum analytics.counts
// (3 + 4 = 7); recentComments sums array-valued comment pages (2 + 1 = 3, the
// 'meta' string skipped); recentDiscussions counts channels (2) and array-valued
// message threads (2 + 1 = 3, the 'note' string skipped).
const JSON_FIXTURES = {
  [ANALYTICS_FILE]: { counts: { '/home': 3, '/about': 4 } },
  [COMMENTS_FILE]: { page1: [{}, {}], page2: [{}], meta: 'not-an-array' },
  [DISCUSSIONS_FILE]: {
    channels: { general: {}, random: {} },
    messages: { general: [{}, {}], random: [{}], note: 'not-an-array' },
  },
};

// Route diagnostics feed endpoints.{total,unique} and health.duplicates; the two
// startup fields only shape the (excluded) server sub-object.
const ROUTE_DIAGNOSTICS = {
  totalHandlers: 42,
  uniqueRoutes: 40,
  duplicateCount: 2,
  startupMs: 123,
  memoryAtStartupMB: 50,
};

// Pre-seeded cache so health.cacheEntries === Object.keys(cache).length === 3.
// The cached passthrough below never mutates it.
const CACHE_SEED = () => ({ a: 1, b: 2, c: 3 });

function makeFs() {
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  return {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: REFS_YAML.length };
      return enoent(fp);
    },
    existsSync(fp) {
      return fp === REFS_PATH;
    },
    readFileSync(fp) {
      if (fp in FILES) return FILES[fp];
      return enoent(fp);
    },
    readdirSync(fp, opts = {}) {
      if (opts.withFileTypes) {
        if (fp in WITH_FILE_TYPES) return WITH_FILE_TYPES[fp];
        return enoent(fp);
      }
      if (opts.recursive) {
        if (fp in RECURSIVE) return RECURSIVE[fp];
        return enoent(fp);
      }
      if (fp in PLAIN) return PLAIN[fp];
      return enoent(fp);
    },
  };
}

// Drive the real GET /api/dashboard handler over a mocked ctx and capture what
// json() writes. The cached passthrough runs the assembly closure on every call
// (no result-level memo), so the projection is recomputed from the fixtures each
// time. The dispatcher in server.js treats a reply as sent via res.writableEnded.
async function runDashboard() {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: makeFs(),
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_key, _ttl, fn) => fn(),
    loadJSON: (file) => JSON_FIXTURES[file],
    cache: CACHE_SEED(),
    _routeDiagnostics: ROUTE_DIAGNOSTICS,
    ANALYTICS_FILE,
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const pathname = '/api/dashboard';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false, writeHead() { return this; }, end() { this.writableEnded = true; return this; } };
  await analysisAdminRoutes(req, res, url, pathname, ctx);
  return out;
}

// The five deterministic, fixture-drivable sub-objects of the 200 payload.
const EXPECTED_CONTENT = { totalFiles: 2, totalWords: 5, references: 2 };
const EXPECTED_ACTIVITY = {
  recentPageviews: 7,
  recentComments: 3,
  recentDiscussions: { channels: 2, messages: 3 },
};
const EXPECTED_TESTS = { lastRun: null, suites: 3, totalTests: 6 };
const EXPECTED_ENDPOINTS = { total: 42, unique: 40 };
const EXPECTED_HEALTH = { integrity: 'healthy', duplicates: 2, cacheEntries: 3 };

describe('GET /api/dashboard: success-path aggregate projection (200)', () => {
  beforeEach(() => _resetReferencesCache());

  it('deep-equals the five deterministic sub-objects; server and generatedAt are shape-only', async () => {
    const out = await runDashboard();
    assert.equal(out.status, 200, 'the success path replies 200');

    // Split the clock/process-bound parts out of the deep-equal. Whatever remains
    // must be exactly the five deterministic sub-objects, which also proves the
    // payload carries no extra or missing top-level keys.
    const { server, generatedAt, ...rest } = out.json;
    assert.deepStrictEqual(rest, {
      content: EXPECTED_CONTENT,
      activity: EXPECTED_ACTIVITY,
      tests: EXPECTED_TESTS,
      endpoints: EXPECTED_ENDPOINTS,
      health: EXPECTED_HEALTH,
    });

    // The same goldens asserted individually for pinpoint failure messages.
    assert.deepStrictEqual(rest.content, EXPECTED_CONTENT);
    assert.deepStrictEqual(rest.activity, EXPECTED_ACTIVITY);
    assert.deepStrictEqual(rest.tests, EXPECTED_TESTS);
    assert.deepStrictEqual(rest.endpoints, EXPECTED_ENDPOINTS);
    assert.deepStrictEqual(rest.health, EXPECTED_HEALTH);

    // server (process.uptime / memoryUsage / startup) is not deterministic: assert
    // only its shape and types, never its values, and keep it out of the deep-equal.
    assert.equal(typeof server, 'object');
    assert.equal(typeof server.uptime, 'number');
    assert.equal(typeof server.memory, 'object');
    assert.equal(typeof server.memory.heapUsed, 'number');
    assert.equal(typeof server.memory.heapTotal, 'number');
    assert.equal(typeof server.memory.rss, 'number');
    assert.equal(typeof server.startup, 'object');
    assert.equal(typeof server.startup.time, 'string');
    assert.ok(server.startup.durationMs === null || typeof server.startup.durationMs === 'number');
    assert.ok(server.startup.memoryAtStartupMB === null || typeof server.startup.memoryAtStartupMB === 'number');

    // generatedAt is a fresh ISO timestamp: pin its type and parseability only.
    assert.equal(typeof generatedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(generatedAt)), 'generatedAt parses as a date');
  });

  it('recomputes an identical deterministic projection on a repeat call (clock parts aside)', async () => {
    const first = await runDashboard();
    const second = await runDashboard();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const { server: _s1, generatedAt: _g1, ...rest1 } = first.json;
    const { server: _s2, generatedAt: _g2, ...rest2 } = second.json;
    assert.deepStrictEqual(rest2, rest1, 'the fold over the fixtures is stable across calls');
  });
});
