import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/fake/root';
const BLOG_DIR = path.join(PROJECT_ROOT, 'content', 'posts', 'blog');

// A quick-note markdown body shaped the way POST /api/quicknote writes them:
// YAML frontmatter carrying the quick-note tag, a blank line, then the body.
function quickNote(title, body) {
  return [
    '---',
    `slug: ${title}`,
    `title: "${title}"`,
    'authors: [zeyu]',
    'tags: [quick-note]',
    'draft: true',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

// A plain post: it is read during the scan but skipped because it carries no
// quick-note tag.
function plainPost(title) {
  return ['---', `title: "${title}"`, 'tags: [essay]', '---', '', 'Body.', ''].join('\n');
}

// Twelve quick-notes (dated so the newest-first sort and the 10-note cap are both
// observable), two non quick-note .md posts, and one non-markdown file (dropped
// by the `.md` filter before any read).
function makeFiles() {
  const files = {};
  for (let d = 1; d <= 12; d++) {
    const day = String(d).padStart(2, '0');
    files[`2026-01-${day}-note.md`] = quickNote(`Note 2026-01-${day}`, `Body ${day}`);
  }
  files['2026-01-20-essay.md'] = plainPost('An Essay');      // .md, sorts first, not a quick note
  files['2025-12-31-old-essay.md'] = plainPost('Old Essay'); // .md, sorts last, not a quick note
  files['2026-01-15-readme.txt'] = 'not markdown';           // dropped by the .md filter
  return files;
}

// A mock fs that serves the virtual blog tree and counts each call, so a test can
// prove the second request does not re-walk the directory.
function makeFs(files, { blogExists = true } = {}) {
  const counts = { existsSync: 0, readdirSync: 0, readFileSync: 0 };
  const fs = {
    existsSync(p) {
      counts.existsSync++;
      return p === BLOG_DIR ? blogExists : false;
    },
    readdirSync(p) {
      counts.readdirSync++;
      if (p !== BLOG_DIR) throw new Error(`unexpected readdirSync(${p})`);
      return Object.keys(files);
    },
    readFileSync(p) {
      counts.readFileSync++;
      const name = path.basename(p);
      if (!(name in files)) throw new Error(`ENOENT: ${p}`);
      return files[name];
    },
  };
  fs._counts = counts;
  return fs;
}

// Pass-through cache: always runs the thunk, i.e. the raw uncached computation.
const passThrough = (_key, _ttl, fn) => fn();

// A real TTL memo standing in for ctx.cached. It mirrors server-utils makeCache
// (store the result only after the thunk returns, so a thrown thunk is never
// cached) and additionally records how many times each key's thunk executes.
function makeCountingCache() {
  const store = {};
  const runs = {};
  const ttls = {};
  function cached(key, ttlMs, fn) {
    ttls[key] = ttlMs;
    const entry = store[key];
    if (entry && Date.now() - entry.time < ttlMs) return entry.data;
    runs[key] = (runs[key] || 0) + 1;
    const data = fn();
    store[key] = { data, time: Date.now() };
    return data;
  }
  cached.runs = runs;
  cached.ttls = ttls;
  return cached;
}

// Drive GET /api/quicknote with a mocked ctx and capture what the handler hands
// to json(res, status, payload).
async function invoke({ fs, cached }) {
  const pathname = '/api/quicknote';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    cached,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await miscToolsRoutes(req, res, url, pathname, ctx);
  return captured;
}

describe('GET /api/quicknote cached scan', () => {
  it('cached payload is byte-identical to the uncached computation', async () => {
    const uncached = await invoke({ fs: makeFs(makeFiles()), cached: passThrough });
    const memo = await invoke({ fs: makeFs(makeFiles()), cached: makeCountingCache() });
    assert.equal(uncached.status, 200);
    assert.equal(memo.status, 200);
    assert.equal(
      JSON.stringify(memo.payload),
      JSON.stringify(uncached.payload),
      'wrapping the scan in cached() must not change the payload bytes',
    );
  });

  it('preserves scan behavior: quick-note filter, newest-first sort, 10-note cap', async () => {
    const r = await invoke({ fs: makeFs(makeFiles()), cached: passThrough });
    assert.equal(r.status, 200);
    assert.equal(r.payload.notes.length, 10, '10-note cap');
    assert.equal(r.payload.total, 10, 'total mirrors the capped note count');

    // Newest first, and the 2026-01-20 essay is filtered out (not a quick note),
    // so the first note is 2026-01-12 and the cap drops the two oldest notes.
    const n0 = r.payload.notes[0];
    assert.deepEqual(n0, {
      filename: '2026-01-12-note.md',
      title: 'Note 2026-01-12',
      date: '2026-01-12',
      preview: 'Body 12',
      path: 'content/posts/blog/2026-01-12-note.md',
    });
    assert.equal(r.payload.notes[9].filename, '2026-01-03-note.md');

    // No essays and no non-markdown leaked into the result.
    for (const n of r.payload.notes) {
      assert.ok(n.filename.endsWith('-note.md'), `unexpected file in result: ${n.filename}`);
    }
  });

  it('serves a second request within the window from cache (no repeat readdirSync/readFileSync)', async () => {
    const fs = makeFs(makeFiles());
    const cached = makeCountingCache();

    const first = await invoke({ fs, cached });
    assert.equal(first.status, 200);
    assert.ok(fs._counts.readdirSync >= 1, 'first request walks the directory');
    assert.ok(fs._counts.readFileSync >= 1, 'first request reads note files');
    const afterFirst = { ...fs._counts };

    const second = await invoke({ fs, cached });
    assert.equal(second.status, 200);
    assert.equal(fs._counts.readdirSync, afterFirst.readdirSync, 'no repeat readdirSync on cache hit');
    assert.equal(fs._counts.readFileSync, afterFirst.readFileSync, 'no repeat readFileSync on cache hit');
    assert.deepEqual(Object.keys(cached.runs), ['quicknote-list'], 'memoized under the quicknote-list key only');
    assert.equal(cached.runs['quicknote-list'], 1, 'scan thunk ran exactly once across both requests');
    assert.equal(cached.ttls['quicknote-list'], 60000, 'memoized on the 60s window');
    assert.equal(
      JSON.stringify(second.payload),
      JSON.stringify(first.payload),
      'cache hit returns the same payload',
    );
  });

  it('missing blog dir returns the empty 200 from inside the cache', async () => {
    const fs = makeFs(makeFiles(), { blogExists: false });
    const cached = makeCountingCache();

    const first = await invoke({ fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, { notes: [], total: 0 });
    assert.equal(fs._counts.readdirSync, 0, 'missing dir short-circuits before any readdir');

    const second = await invoke({ fs, cached });
    assert.deepEqual(second.payload, { notes: [], total: 0 });
    assert.equal(cached.runs['quicknote-list'], 1, 'the empty result is memoized too');
  });

  it('a thrown scan returns the empty 200 and is never cached', async () => {
    // readdirSync throws, so the closure throws; cached() rethrows before it can
    // store anything and the outer try/catch returns the empty 200. The failure
    // must re-run on the next request rather than serve a cached error.
    const fs = makeFs(makeFiles());
    const workingReaddir = fs.readdirSync;
    fs.readdirSync = () => { throw new Error('boom'); };
    const cached = makeCountingCache();

    const first = await invoke({ fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, { notes: [], total: 0 });

    const second = await invoke({ fs, cached });
    assert.deepEqual(second.payload, { notes: [], total: 0 });
    assert.equal(cached.runs['quicknote-list'], 2, 'a failed scan re-runs (never cached)');

    // Direct proof that nothing was stored on the throws: once the scan can
    // succeed, the next request recomputes and returns the real payload instead
    // of a cached empty result.
    fs.readdirSync = workingReaddir;
    const third = await invoke({ fs, cached });
    assert.equal(third.status, 200);
    assert.equal(third.payload.notes.length, 10, 'recovers real data after the failures, so no empty result was cached');
    assert.equal(cached.runs['quicknote-list'], 3, 'the now-successful scan ran again, confirming the throws stored nothing');
  });
});
