import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// route suites do (see tests/next-search-semantic-500.test.mjs and
// tests/next-search-semantic-missing-query.test.mjs, which both drive THIS
// handler's error arms). This suite pins the complementary SUCCESS path.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

// GET /api/search/semantic is documented SUBSTRING search, NOT banned retrieval.
// The handler comment (content-analysis-a.js:737-741) states it is plain
// case-insensitive substring matching with hand-weighted relevance scoring
// (title match +10, each matching heading +5, body occurrences capped at +20),
// with no embeddings, vectors, or semantic retrieval (see .claude/CONSTRAINTS.md).
// This suite characterizes that existing endpoint and introduces no retrieval
// logic. The word "semantic" is unavoidable: it appears in the route pathname.
const ROUTE = '/api/search/semantic';
const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs over a `${rel-from-PROJECT_ROOT}: content` map, mirroring the
// content-tree stub in tests/next-content-b-hoist-stopwords.test.mjs. The success
// path only calls readdirSync({withFileTypes:true}) (recursive walk) and
// readFileSync(fp,'utf-8') (per-file read); the stub returns Dirent-likes shaped
// the way the walk expects and ignores the options/encoding argument.
function makeFs(fileMap) {
  const dirs = new Map();         // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };
  for (const [rel, content] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    fileContents.set(cur, content);
  }
  return {
    readdirSync(dir) {
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Drive GET /api/search/semantic in process and capture the json() response. The
// ctx shape mirrors the sibling semantic suites plus the content-tree fs, real
// node:path, PROJECT_ROOT, and ALLOWED_EXTS that the success path reads. No
// network, no server, no clock: the result is fully determined by the fixture.
async function runSearch(fileMap, q) {
  const url = new URL(`http://localhost${ROUTE}?q=${q}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    fs: makeFs(fileMap),
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
  };
  await routes(req, res, url, ROUTE, ctx);
  return captured;
}

describe('GET /api/search/semantic: success-path lexical ranking golden', () => {
  // A content tree that exercises every scoring lever and every skip rule:
  //   alpha.md       frontmatter title match (+10) + two heading matches (+10)
  //                  + 6 total "widget" occurrences (+6)  => score 26
  //   sub/gamma.md   nested file, 25 occurrences (proves recursion and the
  //                  Math.min(occurrences, 20) body cap), no title/heading => 20
  //   beta.md        a single occurrence, no title/heading                => 1
  //   delta.md       allowed extension but contains no match (excluded)
  //   .hidden.md     dot-prefixed (skipped before reading)
  //   _draft.md      underscore-prefixed (skipped before reading)
  //   notes.txt      extension not in ALLOWED_EXTS (skipped)
  // The three matches carry distinct scores, so the descending sort order is
  // unambiguous and pins which file ranks first.
  const ALPHA = `---
title: Widget Handbook
---

# Widget Basics

A widget explained. Another widget example.

## Advanced Widget Tips

Final widget note.
`;
  const BETA = `Just one widget mention here.
`;
  const GAMMA = `widget widget widget widget widget
widget widget widget widget widget
widget widget widget widget widget
widget widget widget widget widget
widget widget widget widget widget
`;
  const DELTA = `no matching token here
`;
  const HIDDEN = `secret widget content
`;
  const DRAFT = `draft widget notes
`;
  const NOTES_TXT = `plain widget text
`;
  const FIXTURE = {
    'content/alpha.md': ALPHA,
    'content/beta.md': BETA,
    'content/sub/gamma.md': GAMMA,
    'content/delta.md': DELTA,
    'content/.hidden.md': HIDDEN,
    'content/_draft.md': DRAFT,
    'content/notes.txt': NOTES_TXT,
  };

  // GOLDEN: the snippet strings are window/ellipsis-sensitive (a 150-char slice
  // around the first match with newlines flattened to spaces), so they are
  // captured verbatim from a real run of this handler; every other field is
  // hand-derived from the scoring rules above.
  const EXPECTED = {
    status: 200,
    payload: {
      results: [
        {
          path: 'content/alpha.md',
          title: 'Widget Handbook',
          score: 26,
          snippet: '--- title: Widget Handbook ---  # Widget Basics  A widget explained. Another widget example.  ## Advanced Widget Tips...',
          occurrences: 6,
        },
        {
          path: 'content/sub/gamma.md',
          title: 'gamma',
          score: 20,
          snippet: 'widget widget widget widget widget widget widget widget widget widget widget widget widget widget widget w...',
          occurrences: 25,
        },
        {
          path: 'content/beta.md',
          title: 'beta',
          score: 1,
          snippet: 'Just one widget mention here.',
          occurrences: 1,
        },
      ],
      total: 3,
      query: 'widget',
    },
  };

  it('ranks matches by score and projects {path,title,score,snippet,occurrences}', async () => {
    const captured = await runSearch(FIXTURE, 'widget');
    // Full-payload golden: pins the descending order, each per-file score and
    // occurrences count, the exact snippet windows, total, and the echoed query.
    assert.deepStrictEqual(captured, EXPECTED);
  });

  it('orders by descending score and excludes skipped / non-matching files', async () => {
    const { status, payload } = await runSearch(FIXTURE, 'widget');
    assert.equal(status, 200);
    const paths = payload.results.map(r => r.path);
    // alpha leads: it is the only file combining the title boost, heading
    // boosts, and body occurrences (26 > gamma's capped 20 > beta's 1).
    assert.equal(payload.results[0].path, 'content/alpha.md');
    assert.deepStrictEqual(paths, ['content/alpha.md', 'content/sub/gamma.md', 'content/beta.md']);
    // total counts only the real matches, and every skip / non-match is absent.
    assert.equal(payload.total, 3);
    for (const absent of ['content/delta.md', 'content/.hidden.md', 'content/_draft.md', 'content/notes.txt']) {
      assert.ok(!paths.includes(absent), `${absent} must not appear in the results`);
    }
    // The projected shape is exactly the five fields the handler pushes.
    assert.deepStrictEqual(
      Object.keys(payload.results[0]).sort(),
      ['occurrences', 'path', 'score', 'snippet', 'title'],
    );
  });
});

describe('GET /api/search/semantic: top-20 slice cap', () => {
  it('returns at most 20 results while total reflects every match', async () => {
    // 21 matches with strictly increasing occurrence counts (1..21). page01 holds
    // the unique lowest score, so it is the single match that slice(0,20) drops.
    const fileMap = {};
    for (let i = 1; i <= 21; i++) {
      fileMap[`content/page${String(i).padStart(2, '0')}.md`] = ('widget '.repeat(i)).trim() + '\n';
    }
    const { status, payload } = await runSearch(fileMap, 'widget');
    assert.equal(status, 200);
    assert.equal(payload.results.length, 20, 'results are capped at slice(0, 20)');
    assert.equal(payload.total, 21, 'total counts every match before the slice');
    assert.equal(payload.query, 'widget');
    const paths = payload.results.map(r => r.path);
    assert.ok(!paths.includes('content/page01.md'), 'the lowest-scoring match is dropped by the cap');
    assert.ok(payload.results.every(r => r.occurrences >= 2), 'every retained match outranks the dropped one');
  });
});
