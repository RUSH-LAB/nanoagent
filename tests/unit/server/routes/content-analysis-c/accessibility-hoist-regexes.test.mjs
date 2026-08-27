import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do. This suite guards the hoist of the two per-line accessibility
// regexes (ACCESS_IMG_NOALT_RE, ACCESS_HEADING_RE) to module scope: it proves the
// GET /api/file/accessibility issues are byte-for-byte unchanged and that the now
// shared regexes carry no state across back-to-back requests.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// Drive the real GET /api/file/accessibility handler over a minimal mocked ctx.
// `fs.readFileSync` returns the supplied content so no real file is read, and
// `json` captures the {status, payload} the handler emits.
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
    // the real per-line regex scan rather than the 404 catch.
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

describe('GET /api/file/accessibility — hoisted per-line regexes', () => {
  // Multi-line content covering every branch the hoisted regexes feed: three
  // `![]()` missing-alt images (lines 2, 5, 7), an image that carries alt text
  // (line 4, which must NOT match the empty-alt regex), and two skipped heading
  // levels (h1 to h3 on line 3, h2 to h6 on line 8). A non-skipping h3 to h2 drop
  // on line 6 must stay silent.
  const SAMPLE = [
    '# Heading One',                                   // 1: h1, sets baseline
    '![](first.png)',                                  // 2: warning
    '### Heading Three',                               // 3: info, h1 to h3 skip
    'Text with ![alt text](good.png) inline image.',   // 4: alt present, silent
    '![](second.png)',                                 // 5: warning
    '## Heading Two',                                  // 6: h2, no skip (drop)
    '![](third.png)',                                  // 7: warning
    '###### Heading Six',                              // 8: info, h2 to h6 skip
  ].join('\n');

  const EXPECTED_ISSUES = [
    { line: 2, type: 'warning', message: 'Image without alt text' },
    { line: 3, type: 'info', message: 'Heading level skipped: h1 to h3' },
    { line: 5, type: 'warning', message: 'Image without alt text' },
    { line: 7, type: 'warning', message: 'Image without alt text' },
    { line: 8, type: 'info', message: 'Heading level skipped: h2 to h6' },
  ];

  it('reports every issue on every line identically after the hoist', async () => {
    const r = await accessibility(SAMPLE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.issues, EXPECTED_ISSUES);
    // 100 minus (3 warnings * 10) minus (2 info * 3) = 64. The 3/2 split is
    // asymmetric, so a swapped multiplier (which would yield 71) cannot pass.
    assert.equal(r.payload.score, 64);
    assert.equal(r.payload.issueCount, 5);
    assert.equal(r.payload.path, 'content/sample.md');
  });

  it('returns identical results across back-to-back requests (no shared regex state)', async () => {
    // The hoisted regexes are non-global and used through String.prototype.match,
    // so they keep no lastIndex; two consecutive scans of the same content must
    // produce deeply equal payloads.
    const first = await accessibility(SAMPLE);
    const second = await accessibility(SAMPLE);
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload.issues, EXPECTED_ISSUES);
  });

  it('does not flag images that carry alt text', async () => {
    // Only the empty-bracket form `![](...)` is a warning; `![alt](...)` is fine.
    const r = await accessibility('# Title\nBody ![alt](only.png) here, nothing to flag.');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.issues, []);
    assert.equal(r.payload.score, 100);
    assert.equal(r.payload.issueCount, 0);
  });
});
