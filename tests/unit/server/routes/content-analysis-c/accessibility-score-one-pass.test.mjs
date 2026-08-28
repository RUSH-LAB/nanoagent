import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// Drive the real GET /api/file/accessibility handler over a minimal mocked ctx.
// `fs.readFileSync` returns the supplied content so no real file is read, and
// `json` captures the {status, payload} the handler emits. This exercises the
// folded single pass that tallies the warning and info issues before scoring.
async function accessibility(content) {
  const url = new URL('http://localhost/api/file/accessibility?path=content/sample.md');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    isValidFilePath: () => true,
    PROJECT_ROOT: '/fake-root',
    fs: { readFileSync: () => content },
    path,
    // /api/file/accessibility now wraps its scan in cached('accessibility:' + path,
    // 30000, fn); a pass-through cached runs fn() inline so this suite still exercises
    // the real single-pass computation rather than the 404 catch.
    cached: (_key, _ttl, fn) => fn(),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/file/accessibility', ctx);
  return captured;
}

describe('GET /api/file/accessibility — single-pass score', () => {
  it('scores a mix of warning and info issues from one tally pass', async () => {
    // Line 2 and line 4 are images without alt text (warnings); line 3 jumps
    // h1 to h3 (an info-level heading skip). Two warnings, one info.
    const r = await accessibility('# H1\n![](a.png)\n### H3\n![](b.png)');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.issues, [
      { line: 2, type: 'warning', message: 'Image without alt text' },
      { line: 3, type: 'info', message: 'Heading level skipped: h1 to h3' },
      { line: 4, type: 'warning', message: 'Image without alt text' },
    ]);
    // 100 minus (2 warnings * 10) minus (1 info * 3) = 77. The counts are
    // asymmetric, so a swapped multiplier (which would yield 84) cannot pass.
    assert.equal(r.payload.score, 77);
    assert.equal(r.payload.issueCount, 3);
    assert.equal(r.payload.path, 'content/sample.md');
  });

  it('scores a clean file 100 with no issues', async () => {
    // Sequential headings and an image that carries alt text, so nothing is
    // flagged and the score stays at the 100 ceiling.
    const r = await accessibility('# H1\n## H2\n### H3\nBody text with ![alt](img.png) here.');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.issues, []);
    assert.equal(r.payload.score, 100);
    assert.equal(r.payload.issueCount, 0);
  });

  it('clamps the score at 0 when penalties exceed 100', async () => {
    // Eleven images without alt text: 11 warnings * 10 = 110 > 100, so the
    // Math.max(0, ...) clamp keeps the score at 0 rather than going negative.
    const r = await accessibility(Array(11).fill('![](x.png)').join('\n'));
    assert.equal(r.status, 200);
    assert.equal(r.payload.issueCount, 11);
    assert.equal(r.payload.score, 0);
  });
});
