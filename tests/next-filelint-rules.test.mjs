import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// file-tools.js is CommonJS; load the REAL module via createRequire the way the
// sibling route suites do (next-filetools-microcache.test.mjs) and drive its
// GET /api/file/lint handler directly with a mocked ctx and a pass-through cached.
// This is an add-only characterization test: it pins the CURRENT per-line lint
// rules and changes no source. The cache-mechanics sibling only ever trips the
// "Empty heading" and "Missing frontmatter" rules (and the analysis-admin lint
// suites target a different handler), so every rule pinned below is a genuine
// 0-hit until now.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/file-tools.js');

// Each fixture isolates exactly one rule (or one guard), so its golden payload is
// unambiguous. Built line by line and joined with '\n' for precise control of line
// numbers and the trailing fence. Frontmatter carrying a title keeps the
// frontmatter and title rules quiet wherever they are not the rule under test.
const LONG_LINE = 'a'.repeat(501); // 501 chars, one past the 500-char threshold

const FIXTURES = {
  // Frontmatter present but with no title line: the Missing title rule fires at line 1.
  'missing-title': [
    '---',
    'author: Someone',
    '---',
    '',
    'Normal paragraph.',
  ].join('\n'),

  // A line one past the 500-char limit: the Very long line rule reports the exact count.
  'very-long-line': [
    '---',
    'title: Long Line',
    '---',
    '',
    LONG_LINE,
  ].join('\n'),

  // Unequal counts of [ and ] with no [[ or ]]: the unclosed-brackets rule fires.
  'unclosed-brackets': [
    '---',
    'title: Brackets',
    '---',
    '',
    'See [the reference for details',
  ].join('\n'),

  // The same imbalance but carrying [[ ]]: the guard suppresses the rule.
  'bracket-guard': [
    '---',
    'title: Bracket Guard',
    '---',
    '',
    'A wiki [[link]] plus a stray [ bracket',
  ].join('\n'),

  // Control: the guarded line with the [[ ]] removed is still imbalanced, so the rule fires.
  'bracket-guard-control': [
    '---',
    'title: Bracket Control',
    '---',
    '',
    'A wiki link plus a stray [ bracket',
  ].join('\n'),

  // A leading-whitespace heading without the word "code": the rule fires.
  'leading-ws-heading': [
    '---',
    'title: Leading WS',
    '---',
    '',
    '  # Indented heading',
  ].join('\n'),

  // The same leading-whitespace heading mentioning "code": the exemption suppresses the rule.
  'leading-ws-code-exempt': [
    '---',
    'title: Code Heading',
    '---',
    '',
    '  # Some code example',
  ].join('\n'),

  // Control: the exempt line with "code" removed is still a leading-whitespace heading, so the rule fires.
  'leading-ws-code-control': [
    '---',
    'title: Plain Heading',
    '---',
    '',
    '  # Some plain example',
  ].join('\n'),

  // A ``` fence opened and never closed: the EOF check reports an unclosed code block.
  'unclosed-code-block': [
    '---',
    'title: Unclosed Fence',
    '---',
    '',
    '```js',
    'const x = 1;',
  ].join('\n'),

  // A line past 500 chars hidden inside a closed fence: every rule is suppressed.
  'code-fence-skip': [
    '---',
    'title: Fence Skip',
    '---',
    '',
    '```',
    LONG_LINE,
    '```',
    '',
    'Normal text.',
  ].join('\n'),

  // Frontmatter, a title, and no offending lines: zero issues.
  'clean': [
    '---',
    'title: Clean File',
    '---',
    '',
    '# Heading',
    '',
    'A normal paragraph of text.',
    '',
  ].join('\n'),
};

let TMP_ROOT;

// The relative path the handler resolves against PROJECT_ROOT.
const rel = (name) => `lint-${name}.md`;

// Pass-through cached: always runs fn(), reproducing the exact handler code path
// (ctx.cached = (_k, _t, fn) => fn()).
const passThroughCached = (_key, _ttl, fn) => fn();

// Drive the real module's dispatcher to the GET /api/file/lint handler. The real
// node fs reads the temp fixture written for `name`, and json() captures the exact
// response payload, no network and no server.
async function lint(name) {
  const filePath = rel(name);
  const url = new URL('http://localhost/api/file/lint?path=' + encodeURIComponent(filePath));
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT: TMP_ROOT,
    isValidFilePath: () => true,
    cached: passThroughCached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/lint', ctx);
  return captured;
}

before(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'filelint-rules-'));
  for (const name of Object.keys(FIXTURES)) {
    fs.writeFileSync(path.join(TMP_ROOT, rel(name)), FIXTURES[name]);
  }
});

after(() => {
  if (TMP_ROOT) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('GET /api/file/lint per-line rule scan (real server/routes/file-tools.js)', () => {
  it('a clean file with frontmatter and a title yields zero issues', async () => {
    const r = await lint('clean');
    assert.deepEqual(r, { status: 200, payload: { issues: [], issueCount: 0 } });
  });

  it('flags a frontmatter block missing a title at line 1', async () => {
    const r = await lint('missing-title');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      issues: [{ line: 1, severity: 'warning', message: 'Missing title in frontmatter' }],
      issueCount: 1,
    });
  });

  it('flags a line past 500 chars and reports the exact char count', async () => {
    assert.equal(LONG_LINE.length, 501); // the message must carry this exact count
    const r = await lint('very-long-line');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      issues: [{ line: 5, severity: 'info', message: 'Very long line (501 chars)' }],
      issueCount: 1,
    });
  });

  it('flags a line whose [ and ] counts differ and that has no [[ or ]]', async () => {
    const r = await lint('unclosed-brackets');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      issues: [{ line: 5, severity: 'info', message: 'Potentially unclosed brackets' }],
      issueCount: 1,
    });
  });

  it('does NOT flag unbalanced brackets when the line contains [[ or ]] (guard), but DOES once they are removed (control)', async () => {
    // The guarded line is genuinely imbalanced yet carries [[, so suppression comes
    // only from the guard: a real candidate, which makes the empty result non-vacuous.
    const guard = FIXTURES['bracket-guard'];
    assert.notEqual((guard.match(/\[/g) || []).length, (guard.match(/\]/g) || []).length);
    assert.ok(guard.includes('[['));
    const guarded = await lint('bracket-guard');
    assert.deepEqual(guarded, { status: 200, payload: { issues: [], issueCount: 0 } });

    // Same imbalance with the [[ ]] removed: the rule now fires.
    const control = await lint('bracket-guard-control');
    assert.equal(control.status, 200);
    assert.deepEqual(control.payload, {
      issues: [{ line: 5, severity: 'info', message: 'Potentially unclosed brackets' }],
      issueCount: 1,
    });
  });

  it('flags a heading with leading whitespace', async () => {
    const r = await lint('leading-ws-heading');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      issues: [{ line: 5, severity: 'info', message: 'Heading has leading whitespace' }],
      issueCount: 1,
    });
  });

  it('does NOT flag a leading-whitespace heading that mentions "code" (exemption), but DOES without it (control)', async () => {
    // The exempt line is a genuine leading-whitespace heading, so suppression comes
    // only from the "code" exemption: a real candidate, not a vacuous pass.
    const exempt = FIXTURES['leading-ws-code-exempt'];
    assert.ok(/^\s+#/m.test(exempt));
    const exempted = await lint('leading-ws-code-exempt');
    assert.deepEqual(exempted, { status: 200, payload: { issues: [], issueCount: 0 } });

    // Same heading with "code" removed: the rule now fires.
    const control = await lint('leading-ws-code-control');
    assert.equal(control.status, 200);
    assert.deepEqual(control.payload, {
      issues: [{ line: 5, severity: 'info', message: 'Heading has leading whitespace' }],
      issueCount: 1,
    });
  });

  it('flags an unclosed code fence at end of file', async () => {
    const r = await lint('unclosed-code-block');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      issues: [{ line: 6, severity: 'error', message: 'Unclosed code block' }],
      issueCount: 1,
    });
  });

  it('suppresses issues inside a closed code fence so a long line raises nothing', async () => {
    // The fenced block hides a 501-char line that the very-long-line case proves is
    // otherwise flagged, so this empty result is non-vacuous.
    assert.ok(FIXTURES['code-fence-skip'].includes(LONG_LINE));
    const r = await lint('code-fence-skip');
    assert.deepEqual(r, { status: 200, payload: { issues: [], issueCount: 0 } });
  });
});
