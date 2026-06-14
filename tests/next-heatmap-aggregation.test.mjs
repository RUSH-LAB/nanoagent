import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL route module via createRequire the way the
// sibling feeds suites do (next-heatmap-500, next-feeds-summary-daily), so this
// characterization test drives the genuine GET /api/activity-heatmap handler
// instead of a reimplementation. No export is added to the source.
//
// This pins the handler's SUCCESS path: the inner cached() scan closure that
// buckets activity by calendar day from TWO sources (content file mtimes at
// feeds.js:399 to :401 plus comment createdAt timestamps at :407 to :417) into ONE
// tally, then the post-cache window filter (:420 to :424) that keeps dates on or
// after the cutoff, returning 200 {days, totalDays} at :425.
//
// It is DISTINCT from tests/next-heatmap-500.test.mjs (which steers the same
// handler into its outer catch, so the scan and merge yield no value) and from
// tests/feeds-guard.test.mjs (which injects a PRE-BUILT cached object, so the scan
// and comment-merge never run). Here the scan and merge DO run, over a fixture fs
// and a real loadJSON, so the two-source bucketing math is what is pinned. The
// memo layer itself (the cache key plus 60000 ms TTL at feeds.js:389) is out of
// scope here: this test injects a pass-through cached so the closure always runs,
// and the pre-built-cache path is covered by tests/feeds-guard.test.mjs.
//
// The scan is pure file-mtime plus comment-timestamp counting (no embedding,
// vector, or semantic retrieval), so this ADD-ONLY test is constraint-compliant.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/feeds.js');

const DAY = 86400000;
// Snapshot the clock ONCE so the fixture mtimes/createdAt and the expected bucket
// keys derive from the SAME instant. The handler computes each content bucket as
// stat.mtime.toISOString().slice(0,10) (feeds.js:400) and each comment bucket as
// c.createdAt.slice(0,10) (feeds.js:412); building both the fixtures and the
// expectations from this one NOW makes those keys identical by construction, with
// no Date monkey-patching and no UTC-midnight skew between fixture and assertion.
const NOW = Date.now();
// The day key N days before NOW, in the YYYY-MM-DD form the handler buckets by.
const dayKey = off => new Date(NOW - off * DAY).toISOString().slice(0, 10);
// An mtime Date N days before NOW; mtimeFor(off).toISOString().slice(0,10) === dayKey(off).
const mtimeFor = off => new Date(NOW - off * DAY);
// A comment createdAt N days before NOW; createdAtFor(off).slice(0,10) === dayKey(off).
const createdAtFor = off => dayKey(off) + 'T12:00:00.000Z';

const PROJECT_ROOT = '/virtual-root';
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
const COMMENTS_FILE = path.join(PROJECT_ROOT, 'data', 'comments.json');

// Build an in-memory fs from a tree { [dirPath]: [{name, dir?, mtime?}] }, the
// statSync-bearing idiom from tests/next-feeds-summary-daily.test.mjs. readdirSync
// returns {name, isDirectory()} Dirent-likes (the handler passes
// {withFileTypes:true}, which this ignores since it always returns Dirent-likes);
// statSync returns {mtime}. No real filesystem is touched.
function makeFs(tree) {
  const statMap = {};
  for (const [dir, entries] of Object.entries(tree)) {
    for (const e of entries) {
      if (!e.dir) statMap[path.join(dir, e.name)] = e.mtime;
    }
  }
  return {
    readdirSync(dir) {
      return (tree[dir] || []).map(e => ({ name: e.name, isDirectory: () => Boolean(e.dir) }));
    },
    statSync(fp) {
      return { mtime: statMap[fp] };
    },
  };
}

// Drive the real GET /api/activity-heatmap handler over a mocked ctx. `cached` is a
// faithful PASS-THROUGH that runs the closure the way the live memo does on a cold
// key, so the real scan and comment-merge execute. loadJSON returns the supplied
// comments fixture for the injected COMMENTS_FILE and {} otherwise, matching the
// handler's single loadJSON(COMMENTS_FILE) read. numericParam is NOT injected: the
// handler uses the module-scope import from server-utils, not a ctx copy. A
// capturing json() records {status, payload}.
async function invoke({ tree, comments = {}, search = '' }) {
  const pathname = '/api/activity-heatmap';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    cached: (_key, _ttl, fn) => fn(),
    fs: makeFs(tree),
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    loadJSON: file => (file === COMMENTS_FILE ? comments : {}),
    COMMENTS_FILE,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, res };
}

describe('GET /api/activity-heatmap success-path two-source aggregation (current behavior)', () => {
  it('merges content mtimes and comment createdAt into one per-day tally, skipping dot and non-Markdown files', async () => {
    // Content: two .md/.mdx on dayKey(30) and one on dayKey(5). A dot-file and a
    // .txt sit in the same dir, both stamped with an IN-WINDOW mtime, so only the
    // dot rule and the extension rule (not the date) can explain their absence.
    const tree = {
      [CONTENT_DIR]: [
        { name: 'alpha.md', mtime: mtimeFor(30) },   // counted -> dayKey(30)
        { name: 'beta.mdx', mtime: mtimeFor(30) },   // counted -> dayKey(30)
        { name: 'gamma.md', mtime: mtimeFor(5) },    // counted -> dayKey(5)
        { name: '.hidden.md', mtime: mtimeFor(5) },  // dot-file, skipped
        { name: 'notes.txt', mtime: mtimeFor(5) },   // non-allowed ext, skipped
      ],
    };
    // Comments: one on dayKey(30) that MERGES into the file bucket, two on
    // dayKey(100); a missing-createdAt entry and a non-array page are ignored.
    const comments = {
      'docs/a': [
        { createdAt: createdAtFor(30) },             // merges into dayKey(30)
        { createdAt: createdAtFor(100) },            // dayKey(100)
        { createdAt: createdAtFor(100) },            // dayKey(100)
        { text: 'no timestamp' },                    // missing createdAt, ignored
      ],
      notAnArray: { ignored: true },                 // non-array page, ignored
    };

    const { captured, res } = await invoke({ tree, comments });

    assert.equal(res.writableEnded, true);
    // Full-value golden: the merged per-day counts (two files plus one comment = 3
    // on dayKey(30), one file on dayKey(5), two comments on dayKey(100)), and
    // totalDays = the bucket count. All three offsets sit well inside the default
    // 365-day window, so none is dropped by the cutoff.
    assert.deepStrictEqual(captured, {
      status: 200,
      payload: {
        days: {
          [dayKey(30)]: 3,
          [dayKey(5)]: 1,
          [dayKey(100)]: 2,
        },
        totalDays: 3,
      },
    });
  });

  it('recurses non-dot subdirectories and never descends into a dot-directory', async () => {
    // top.md sits at the root; deep.md sits one level down (proves recursion); .git
    // is a dot-directory whose secret.md must NOT be counted (the dot check at
    // feeds.js:394 precedes the isDirectory recursion at feeds.js:396).
    const tree = {
      [CONTENT_DIR]: [
        { name: 'top.md', mtime: mtimeFor(7) },      // counted -> dayKey(7)
        { name: 'nested', dir: true },               // recursed
        { name: '.git', dir: true },                 // dot-dir, not recursed
      ],
      [path.join(CONTENT_DIR, 'nested')]: [
        { name: 'deep.md', mtime: mtimeFor(20) },    // counted -> dayKey(20)
      ],
      [path.join(CONTENT_DIR, '.git')]: [
        { name: 'secret.md', mtime: mtimeFor(7) },   // behind the dot-dir, never walked
      ],
    };

    const { captured } = await invoke({ tree });

    // dayKey(7) counts ONLY top.md (secret.md is behind the dot-dir, never walked),
    // and dayKey(20) counts deep.md, proving the recursion ran.
    assert.deepStrictEqual(captured, {
      status: 200,
      payload: {
        days: {
          [dayKey(7)]: 1,
          [dayKey(20)]: 1,
        },
        totalDays: 2,
      },
    });
  });

  it('applies the post-cache window: ?days narrows the cutoff and drops older buckets', async () => {
    // One bucket per offset: 5 and 30 days back fall inside a 50-day window; 100
    // days back falls outside it but inside the default 365-day window.
    const tree = {
      [CONTENT_DIR]: [
        { name: 'recent.md', mtime: mtimeFor(5) },   // dayKey(5)
        { name: 'mid.md', mtime: mtimeFor(30) },     // dayKey(30)
        { name: 'older.md', mtime: mtimeFor(100) },  // dayKey(100)
      ],
    };

    // Default window (365): all three buckets survive.
    const def = await invoke({ tree });
    assert.deepStrictEqual(def.captured, {
      status: 200,
      payload: {
        days: {
          [dayKey(5)]: 1,
          [dayKey(30)]: 1,
          [dayKey(100)]: 1,
        },
        totalDays: 3,
      },
    });

    // ?days=50: the cutoff (NOW minus 50 days) drops the 100-day-old bucket only.
    const narrowed = await invoke({ tree, search: '?days=50' });
    assert.deepStrictEqual(narrowed.captured, {
      status: 200,
      payload: {
        days: {
          [dayKey(5)]: 1,
          [dayKey(30)]: 1,
        },
        totalDays: 2,
      },
    });
  });
});
