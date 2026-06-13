import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-c.js');

// Drive the real GET /api/file/jsonld handler over a minimal mocked ctx.
// `fs.readFileSync` returns the supplied content and `fs.statSync` returns a
// stat whose `mtime` is a fixed Date, so no real file is read and the file's
// modified time is fully controlled. `json` captures the {status, payload} the
// handler emits. This exercises the hoist that computes `mtimeIso` once and
// reuses it for both `datePublished` (when there is no frontmatter date) and
// `dateModified`.
const MTIME = new Date('2023-05-15T08:30:00.000Z');
const MTIME_ISO = MTIME.toISOString();

async function jsonld(content) {
  const url = new URL('http://localhost/api/file/jsonld?path=content/sample.md');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    isValidFilePath: () => true,
    PROJECT_ROOT: '/fake-root',
    fs: {
      readFileSync: () => content,
      statSync: () => ({ mtime: MTIME }),
    },
    path,
    // /api/file/jsonld wraps its build in cached('jsonld:' + path, 30000, fn); a
    // pass-through cached runs fn() inline so this suite exercises the real
    // computation rather than the 404 catch.
    cached: (_key, _ttl, fn) => fn(),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/file/jsonld', ctx);
  return captured;
}

describe('GET /api/file/jsonld — mtime ISO reuse', () => {
  it('uses the file mtime for both datePublished and dateModified when there is no frontmatter date', async () => {
    // No frontmatter at all, so `date` is never overwritten and falls back to
    // the file mtime, exactly like `dateModified`.
    const r = await jsonld('# Hello\n\nBody text here.');
    assert.equal(r.status, 200);
    assert.equal(r.payload.datePublished, MTIME_ISO);
    assert.equal(r.payload.dateModified, MTIME_ISO);
    // Both fields come from the single hoisted `mtimeIso`, so they are equal.
    assert.equal(r.payload.datePublished, r.payload.dateModified);
    assert.equal(r.payload.headline, 'sample');
  });

  it('keeps dateModified tied to the mtime even when a frontmatter date moves datePublished', async () => {
    // A frontmatter `date:` overwrites datePublished, but dateModified must stay
    // the file mtime, so the two diverge. This pins dateModified to `mtimeIso`
    // rather than to the (reassignable) `date`.
    const r = await jsonld('---\ndate: 2020-01-02\n---\n\n# Title\n\nBody.');
    assert.equal(r.status, 200);
    assert.equal(r.payload.datePublished, '2020-01-02T00:00:00Z');
    assert.equal(r.payload.dateModified, MTIME_ISO);
    assert.notEqual(r.payload.datePublished, r.payload.dateModified);
  });
});
