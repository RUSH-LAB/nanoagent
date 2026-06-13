import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling next-references-*.test.mjs suites do, then drive two filesystem-only
// handlers over a fully mocked ctx (no real fs, network, subprocess, git, clock,
// or randomness):
//   GET  /api/references/year-distribution
//   POST /api/file/draft
// These are add-only characterization tests: they pin the CURRENT, correct
// behavior so a future refactor cannot silently change it. No source file is
// edited. The network handlers in references.js (POST /api/ai/complete,
// GET /api/metadata/search, GET and POST /api/references/enrich) are never
// reached: each target handler is selected only by its own method plus pathname.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const yaml = require('js-yaml');
const { isValidFilePath } = require('../server/server-utils.js');

const PROJECT_ROOT = '/proj';

// ── GET /api/references/year-distribution ──

// Drive the year-distribution handler with an in-memory references.yaml. The
// handler loads refs through the module-internal loadReferencesCached, whose
// statSync is wrapped in try/catch; a stat-less mock fs (readFileSync only) makes
// every call fall through to a fresh read and never memoize, so each case is
// hermetic. We feed YAML via fs.readFileSync (yaml.dump(refs)) rather than
// stubbing loadReferencesCached, exactly as the sibling limit-guards suite does.
async function invokeYearDist(refs, { readThrows = false } = {}) {
  const pathname = '/api/references/year-distribution';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    fs: {
      readFileSync: () => {
        if (readThrows) throw new Error('ENOENT: references.yaml missing');
        return yaml.dump(refs);
      },
    },
    path,
    PROJECT_ROOT,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/references/year-distribution characterization', () => {
  it('aggregates byYear and returns years ascending with numeric year keys', async () => {
    const refs = {
      p1: { year: 2021, venue: 'A' },
      p2: { year: 2019, venue: 'B' },
      p3: { year: 2020, venue: 'C' },
      p4: { year: 2021, venue: 'D' },
      p5: { year: 2021, venue: 'E' },
    };
    const r = await invokeYearDist(refs);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.years, [
      { year: 2019, count: 1 },
      { year: 2020, count: 1 },
      { year: 2021, count: 3 },
    ]);
    assert.equal(r.payload.totalReferences, 5);
    assert.equal(r.payload.unknownYear, 0);
  });

  it('returns topVenues sorted by count descending and capped at 15', async () => {
    // 18 distinct venues with strictly descending counts 18, 17, ..., 1 so both
    // the sort order and the slice(0, 15) cap are unambiguous.
    const refs = {};
    let idx = 0;
    for (let v = 0; v < 18; v++) {
      const count = 18 - v;
      for (let c = 0; c < count; c++) {
        refs[`k${idx++}`] = { year: 2020, venue: `Venue ${v}` };
      }
    }
    const r = await invokeYearDist(refs);
    assert.equal(r.status, 200);
    assert.equal(r.payload.topVenues.length, 15, 'capped at 15 venues');
    assert.deepEqual(r.payload.topVenues[0], { venue: 'Venue 0', count: 18 });
    assert.deepEqual(r.payload.topVenues[14], { venue: 'Venue 14', count: 4 });
    // Strictly descending by count across the whole list.
    for (let i = 1; i < r.payload.topVenues.length; i++) {
      assert.ok(r.payload.topVenues[i - 1].count >= r.payload.topVenues[i].count);
    }
    // The three lowest-count venues fall outside the top 15.
    const names = r.payload.topVenues.map(v => v.venue);
    assert.ok(!names.includes('Venue 15'));
    assert.ok(!names.includes('Venue 16'));
    assert.ok(!names.includes('Venue 17'));
  });

  it('collapses every falsy year (0, empty, null, missing) into unknownYear, excluded from years but counted in totalReferences', async () => {
    const refs = {
      real: { year: 2020, venue: 'Conf A' },
      zero: { year: 0, venue: 'Conf B' },
      empty: { year: '', venue: 'Conf C' },
      nul: { year: null, venue: 'Conf D' },
      missing: { venue: 'Conf E' },
    };
    const r = await invokeYearDist(refs);
    assert.equal(r.status, 200);
    // Only the real year survives in `years`; year 0 is NOT present there.
    assert.deepEqual(r.payload.years, [{ year: 2020, count: 1 }]);
    assert.ok(r.payload.years.every(y => y.year !== 0 && Number.isInteger(y.year)));
    // All four falsy-year entries land in the single unknown bucket.
    assert.equal(r.payload.unknownYear, 4);
    // totalReferences counts every entry, including the unknown-year ones.
    assert.equal(r.payload.totalReferences, 5);
  });

  it('omits entries that have no venue from topVenues', async () => {
    const refs = {
      withVenue: { year: 2020, venue: 'Visible Venue' },
      noVenue: { year: 2021 },
    };
    const r = await invokeYearDist(refs);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.topVenues, [{ venue: 'Visible Venue', count: 1 }]);
    // The venue-less entry contributes no venue, yet still counts toward years.
    assert.deepEqual(r.payload.years, [{ year: 2020, count: 1 }, { year: 2021, count: 1 }]);
    assert.equal(r.payload.totalReferences, 2);
    assert.equal(r.payload.unknownYear, 0);
  });

  it('returns 200 with empty aggregates for an empty bibliography', async () => {
    const r = await invokeYearDist({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.years, []);
    assert.deepEqual(r.payload.topVenues, []);
    assert.equal(r.payload.totalReferences, 0);
    assert.equal(r.payload.unknownYear, 0);
  });

  it('returns 200 empty (NOT 500) when the references read throws, since loadReferencesCached swallows it to {}', async () => {
    const r = await invokeYearDist({}, { readThrows: true });
    assert.equal(r.status, 200, 'a failed read is swallowed to {} and served as 200, not surfaced as 500');
    assert.deepEqual(r.payload.years, []);
    assert.deepEqual(r.payload.topVenues, []);
    assert.equal(r.payload.totalReferences, 0);
    assert.equal(r.payload.unknownYear, 0);
  });
});

// ── POST /api/file/draft ──

const VALID_PATH = 'content/posts/blog/x.md';

// Drive the draft-toggle handler with a mocked ctx. `events` records every fs
// side effect in order ('read' / 'write'); `writes` captures each writeFileSync
// {file, data}; `readBodyCount` proves whether the body was read; and
// `rateLimitCalls` captures the limiter key plus ceiling. The REAL isValidFilePath
// from server-utils is passed as ctx.isValidFilePath so the path guard contract is
// pinned faithfully. No real filesystem is touched.
async function invokeDraft({ body, fileContent = '', readThrows = false, rateLimited = false, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/file/draft';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  let captured = null;
  let readBodyCount = 0;
  const events = [];
  const writes = [];
  const rateLimitCalls = [];
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => { readBodyCount += 1; return body; },
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return !rateLimited; },
    isValidFilePath,
    fs: {
      readFileSync: () => { events.push('read'); if (readThrows) throw new Error('ENOENT'); return fileContent; },
      writeFileSync: (file, data) => { events.push('write'); writes.push({ file, data }); },
    },
    path,
    PROJECT_ROOT,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { captured, events, writes, rateLimitCalls, readBodyCount };
}

describe('POST /api/file/draft characterization', () => {
  it('returns 429 and touches nothing when throttled, before reading the body', async () => {
    const { captured, events, writes, rateLimitCalls, readBodyCount } = await invokeDraft({
      body: { path: VALID_PATH, draft: true },
      rateLimited: true,
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The limiter is consulted with this route's own key and ceiling, before the
    // try block, so the body is never read and no file is touched.
    assert.deepEqual(rateLimitCalls, [{ key: 'file-draft:127.0.0.1', limit: 20 }]);
    assert.equal(readBodyCount, 0);
    assert.deepEqual(events, []);
    assert.equal(writes.length, 0);
  });

  it('returns 400 Invalid path for an out-of-content path, before the draft-type check', async () => {
    // Path validity is checked BEFORE the draft-type check, so an invalid path
    // paired with a non-boolean draft still yields Invalid path. The body is read
    // inside the try, but no file is touched.
    const { captured, events, writes, readBodyCount } = await invokeDraft({
      body: { path: 'server/secret.md', draft: 'not a boolean' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid path' });
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
    assert.equal(writes.length, 0);
  });

  it('returns 400 draft must be a boolean for a valid path with a non-boolean draft', async () => {
    const { captured, events, writes } = await invokeDraft({
      body: { path: VALID_PATH, draft: 'true' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'draft must be a boolean' });
    assert.deepEqual(events, []);
    assert.equal(writes.length, 0);
  });

  it('replaces an existing draft line in place within the frontmatter', async () => {
    const fileContent = '---\ntitle: Hello\ndraft: false\n---\n# Body\n';
    const { captured, events, writes } = await invokeDraft({
      body: { path: VALID_PATH, draft: true },
      fileContent,
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.deepEqual(events, ['read', 'write']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].file, path.join(PROJECT_ROOT, VALID_PATH));
    assert.equal(writes[0].data, '---\ntitle: Hello\ndraft: true\n---\n# Body\n');
  });

  it('appends a draft line to frontmatter that lacks one', async () => {
    const fileContent = '---\ntitle: Hello\n---\n# Body\n';
    const { captured, events, writes } = await invokeDraft({
      body: { path: VALID_PATH, draft: true },
      fileContent,
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.deepEqual(events, ['read', 'write']);
    assert.equal(writes[0].data, '---\ntitle: Hello\ndraft: true\n---\n# Body\n');
  });

  it('prepends a frontmatter block when the file has none, rendering the literal boolean', async () => {
    const fileContent = '# Just a heading\n\nSome text.\n';
    const { captured, events, writes } = await invokeDraft({
      body: { path: VALID_PATH, draft: false },
      fileContent,
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.deepEqual(events, ['read', 'write']);
    assert.equal(writes[0].data, '---\ndraft: false\n---\n# Just a heading\n\nSome text.\n');
  });

  it('returns 400 Invalid request when the file read throws (for example ENOENT), not 500', async () => {
    const { captured, events, writes } = await invokeDraft({
      body: { path: VALID_PATH, draft: true },
      readThrows: true,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid request' });
    // The read is attempted and recorded before the throw; nothing is written.
    assert.deepEqual(events, ['read']);
    assert.equal(writes.length, 0);
  });
});
