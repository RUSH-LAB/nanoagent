import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Drive the real POST /api/lint handler with a minimal ctx (readBody/json/rateLimit,
// no real fs). The handler reads `content` from the body and returns {issues}.
async function lint(content) {
  const url = new URL('http://localhost/api/lint');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    readBody: async () => ({ content }),
    rateLimit: () => true,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/lint', ctx);
  return captured;
}

// The two checks under test, isolated from the handler's other rules by message.
const isBroken = (x) => x.message.startsWith('Possibly broken image reference');
const isMissingAlt = (x) => x.message === 'Image is missing alt text';

// Build the exact issue object the handler emits, computing the column from the
// fixture so a regex-byte drift (a shifted or dropped match) fails the assertion.
function brokenIssue(lines, lineNum, fullMatch, imgPath) {
  return {
    line: lineNum,
    column: lines[lineNum - 1].indexOf(fullMatch) + 1,
    message: `Possibly broken image reference: "${imgPath}" (relative path, should start with / or http)`,
    severity: 'warning',
  };
}
function altIssue(lines, lineNum, fullMatch) {
  return {
    line: lineNum,
    column: lines[lineNum - 1].indexOf(fullMatch) + 1,
    message: 'Image is missing alt text',
    severity: 'warning',
  };
}

// Several broken references (relative paths) spread across lines, two on one line,
// alongside images that must NOT be flagged (absolute and http paths).
const BROKEN_LINES = [
  'Intro line with no images.',
  'First ![one](a.png) then second ![two](b.png) here.',
  'Absolute ![ok](/abs.png) is fine.',
  'Remote ![web](https://example.com/c.png) is fine too.',
  'Last ![three](sub/d.png) on its own line.',
];

// Several missing-alt images (empty or whitespace alt) across lines, two on one
// line, alongside an image with alt text that must NOT be flagged. Every path here
// is absolute or http, so none of these also trip the broken-reference rule.
const MISSING_ALT_LINES = [
  'Plain line, nothing to see.',
  'Missing ![](/one.png) and also ![]( /two.png ) inline.',
  'Described ![desc](/three.png) is fine.',
  'Spaced ![ ](/five.png) still missing.',
  'Remote ![](https://example.com/four.png) at the end.',
];

// Broken references and missing-alt images interleaved, for the repeat-call check.
const COMBINED_LINES = [
  'Broken ![a](rel1.png) and missing ![](/keep.png) together.',
  'Another ![b](rel2.png) plus missing ![]( /keep2.png ).',
  'Clean ![c](/ok.png) and remote ![d](https://x/y.png) lines.',
];

describe('POST /api/lint hoisted image/alt regexes', () => {
  it('reports every broken image reference, including two on one line', async () => {
    const { status, payload } = await lint(BROKEN_LINES.join('\n'));
    assert.equal(status, 200);

    const broken = payload.issues.filter(isBroken);
    assert.deepEqual(broken, [
      brokenIssue(BROKEN_LINES, 2, '![one](a.png)', 'a.png'),
      brokenIssue(BROKEN_LINES, 2, '![two](b.png)', 'b.png'),
      brokenIssue(BROKEN_LINES, 5, '![three](sub/d.png)', 'sub/d.png'),
    ]);

    // Every image here carries alt text, so the alt rule stays silent.
    assert.equal(payload.issues.filter(isMissingAlt).length, 0);
  });

  it('reports every missing-alt image, including two on one line', async () => {
    const { status, payload } = await lint(MISSING_ALT_LINES.join('\n'));
    assert.equal(status, 200);

    const missing = payload.issues.filter(isMissingAlt);
    assert.deepEqual(missing, [
      altIssue(MISSING_ALT_LINES, 2, '![](/one.png)'),
      altIssue(MISSING_ALT_LINES, 2, '![]( /two.png )'),
      altIssue(MISSING_ALT_LINES, 4, '![ ](/five.png)'),
      altIssue(MISSING_ALT_LINES, 5, '![](https://example.com/four.png)'),
    ]);

    // Every path here is absolute or http, so the broken-reference rule stays silent.
    assert.equal(payload.issues.filter(isBroken).length, 0);
  });

  it('returns identical results on repeated calls (stable output across requests)', async () => {
    const content = COMBINED_LINES.join('\n');
    const first = await lint(content);
    const second = await lint(content);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // LINT_IMG_RE/LINT_ALT_RE are now shared module state, so pin that two
    // back-to-back requests produce identical output. Each exec loop runs to a
    // null match (which zeroes lastIndex) and the handler also resets lastIndex
    // before looping, so no regex state carries from one request into the next.
    assert.deepEqual(second.payload.issues, first.payload.issues);
    assert.equal(first.payload.issues.filter(isBroken).length, 2);
    assert.equal(first.payload.issues.filter(isMissingAlt).length, 2);
  });

  it('requires the leading ! so plain markdown links are not flagged', async () => {
    const { status, payload } = await lint('A plain [link](relative.html) is not an image.');
    assert.equal(status, 200);
    assert.equal(payload.issues.filter(isBroken).length, 0);
    assert.equal(payload.issues.filter(isMissingAlt).length, 0);
  });
});
