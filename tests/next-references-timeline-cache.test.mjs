import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
// js-yaml resolves from the repo's node_modules, exactly as the handler's
// inner require('js-yaml') does at runtime.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');
const yaml = require('js-yaml');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// A counting fs stub: only references.yaml is readable, every read is tallied so a
// cached repeat can be proven to skip the file entirely, and any other path throws
// ENOENT so an unexpected access surfaces.
function makeFs(yamlText) {
  const fs = {
    readCount: 0,
    readPaths: [],
    readEncodings: [],
    readFileSync(fp, encoding) {
      fs.readCount++;
      fs.readPaths.push(fp);
      fs.readEncodings.push(encoding);
      if (fp === REFS_PATH) return yamlText;
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return fs;
}

// A memoizing cached() mirroring the production server.js helper, with two probes:
// `calls` records every (key, ttlMs) so the static key and TTL can be pinned, and
// `fnRuns` counts how often the closure actually executes so a cache hit (no extra
// run) and the never-cache-an-error contract (a re-run after a throw) are both
// observable. fn() throwing stores nothing, exactly like the real helper.
function makeCache() {
  const store = new Map();
  const cached = (key, ttlMs, fn) => {
    cached.calls.push({ key, ttlMs });
    if (store.has(key)) return store.get(key);
    cached.fnRuns++;
    const data = fn();
    store.set(key, data);
    return data;
  };
  cached.calls = [];
  cached.fnRuns = 0;
  return cached;
}

// Drive GET /api/references/timeline with a shared fs + cached across calls, so a
// repeat request can be observed hitting the cache. Returns the captured json().
async function getTimeline(fs, cached) {
  const url = new URL('http://localhost/api/references/timeline');
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
  await routes(req, res, url, '/api/references/timeline', ctx);
  return captured;
}

// The exact pre-cache fold, copied verbatim from the handler before it was wrapped
// in cached(). The cache wrapper must be transparent, so the live payload has to be
// byte-identical to what this oracle produces for the same fixture.
function preCacheTimeline(yamlText) {
  const refs = yaml.load(yamlText) || {};
  const byYear = {};
  for (const [key, entry] of Object.entries(refs)) {
    const year = entry.year || 'unknown';
    if (year === 'unknown') continue;
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push({ key, title: entry.title, venue: entry.venue, authors: (entry.author || []).slice(0, 3) });
  }
  const timeline = Object.entries(byYear)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([year, papers]) => ({
      year: Number(year),
      count: papers.length,
      papers: papers.slice(0, 5),
    }));
  return { timeline, totalYears: timeline.length };
}

// A fixed references.yaml fixture exercising every branch of the fold:
//  - years parsed out of order (2021 first) to prove the ascending Number() sort
//  - a year (2019) with six papers to prove papers.slice(0, 5) while count stays 6
//  - a surviving paper (b2019) with four authors to prove authors.slice(0, 3)
//  - a paper (a2020) with no author list to prove (entry.author || []).slice(0, 3)
//  - an entry (noyear) with no year to prove the 'unknown' skip
const FIXTURE_YAML = `
z2021:
  title: Lone 2021
  venue: ICLR
  year: 2021
  author:
    - Solo Author
b2019:
  title: Paper B
  venue: ICML
  year: 2019
  author:
    - B One
    - B Two
    - B Three
    - B Four
c2019:
  title: Paper C
  venue: ICML
  year: 2019
  author:
    - C One
d2019:
  title: Paper D
  venue: ICML
  year: 2019
  author:
    - D One
e2019:
  title: Paper E
  venue: ICML
  year: 2019
  author:
    - E One
f2019:
  title: Paper F
  venue: ICML
  year: 2019
  author:
    - F One
g2019:
  title: Paper G
  venue: NeurIPS
  year: 2019
  author:
    - G One
a2020:
  title: Paper A
  venue: TMLR
  year: 2020
noyear:
  title: Yearless
  venue: Workshop
`;

// Hand-computed expected payload, pinning the behavior independently of the oracle:
// years ascending; 2019 keeps count 6 but only the first five papers; b2019's four
// authors trimmed to three; a2020 with an empty authors list; the yearless entry
// excluded; g2019 dropped as the sixth paper of 2019.
const EXPECTED = {
  timeline: [
    {
      year: 2019,
      count: 6,
      papers: [
        { key: 'b2019', title: 'Paper B', venue: 'ICML', authors: ['B One', 'B Two', 'B Three'] },
        { key: 'c2019', title: 'Paper C', venue: 'ICML', authors: ['C One'] },
        { key: 'd2019', title: 'Paper D', venue: 'ICML', authors: ['D One'] },
        { key: 'e2019', title: 'Paper E', venue: 'ICML', authors: ['E One'] },
        { key: 'f2019', title: 'Paper F', venue: 'ICML', authors: ['F One'] },
      ],
    },
    {
      year: 2020,
      count: 1,
      papers: [{ key: 'a2020', title: 'Paper A', venue: 'TMLR', authors: [] }],
    },
    {
      year: 2021,
      count: 1,
      papers: [{ key: 'z2021', title: 'Lone 2021', venue: 'ICLR', authors: ['Solo Author'] }],
    },
  ],
  totalYears: 3,
};

describe('GET /api/references/timeline (folded payload cached via cached("references-timeline", 60000))', () => {
  it('returns a payload byte-identical to the pre-cache output on the first call', async () => {
    const fs = makeFs(FIXTURE_YAML);
    const r = await getTimeline(fs, makeCache());

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED, 'payload matches the hand-computed expected fold');
    // The literal requirement: identical to what the un-wrapped handler produced.
    assert.equal(
      JSON.stringify(r.payload),
      JSON.stringify(preCacheTimeline(FIXTURE_YAML)),
      'cache wrapper is transparent: bytes identical to the pre-cache fold',
    );
    assert.ok(fs.readCount > 0, 'first request must read references.yaml');
  });

  it('pins the static cache key and the 60000 ms TTL', async () => {
    const fs = makeFs(FIXTURE_YAML);
    const cached = makeCache();
    await getTimeline(fs, cached);

    assert.ok(cached.calls.length >= 1, 'the handler routes through cached()');
    assert.equal(cached.calls[0].key, 'references-timeline', 'static key is "references-timeline"');
    assert.equal(cached.calls[0].ttlMs, 60000, 'TTL is 60000 ms');
  });

  it('serves a repeat request within the TTL from cache without re-reading references.yaml', async () => {
    const fs = makeFs(FIXTURE_YAML);
    const cached = makeCache();

    const first = await getTimeline(fs, cached);
    const readsAfterFirst = fs.readCount;
    assert.equal(first.status, 200);
    assert.equal(cached.fnRuns, 1, 'first request runs the fold once');
    assert.ok(readsAfterFirst > 0, 'first request reads the file');

    const second = await getTimeline(fs, cached);
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload, 'cached repeat returns matching data');
    assert.equal(second.payload, first.payload, 'cached repeat returns the same shared object');
    assert.equal(cached.fnRuns, 1, 'cached repeat must not run the fold again');
    assert.equal(fs.readCount, readsAfterFirst, 'cached repeat must not read references.yaml again');
  });

  it('never caches an error: a failed read returns 500 and the next call retries the fold', async () => {
    const cached = makeCache();
    const missingFs = {
      readCount: 0,
      readFileSync() { this.readCount++; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    };

    const err = await getTimeline(missingFs, cached);
    assert.equal(err.status, 500, 'a read failure surfaces as 500');
    assert.deepEqual(err.payload, { error: 'Timeline failed' });
    assert.equal(cached.fnRuns, 1, 'the fold ran and threw');

    // Nothing was cached, so a later healthy read recomputes rather than replaying the error.
    const ok = await getTimeline(makeFs(FIXTURE_YAML), cached);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.payload, EXPECTED);
    assert.equal(cached.fnRuns, 2, 'the error was not cached, so the fold ran again');
  });
});
