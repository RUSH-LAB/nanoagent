import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const SPECIFIER = '../server/routes/analysis-admin.js';
const routes = require(SPECIFIER);

// Drive the real POST /api/lint handler with a minimal ctx (readBody/json/
// rateLimit, no real fs). The handler reads `content` from the body and returns
// {issues}. Mirrors the helper in next-lint-hoist-regexes.test.mjs.
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

// Reference copies of the patterns, used only to pin .source/.flags of the
// exported consts. The behavioral cases below independently guard against any
// pattern drift, so these reference literals are a structural check, not the
// sole source of truth.
const EXPECTED = {
  LINT_FM_TITLE_RE: /^title\s*:/m,
  LINT_HEADING_RE: /^(#{1,6})\s+(.+)$/,
  LINT_HTTP_PREFIX_RE: /^https?:\/\//,
  LINT_FENCE_RE: /^```/,
  LINT_URL_ONLY_RE: /^\s*https?:\/\/\S+\s*$/,
  LINT_LINK_ONLY_RE: /^\s*\[.*\]\(https?:\/\/\S+\)\s*$/,
  LINT_HEADING_PREFIX_RE: /^#{1,6}\s+/,
};

describe('POST /api/lint per-line regexes (hoisted to module scope)', () => {
  it('keeps the route export a function and leaves the image regexes internal', () => {
    assert.equal(typeof routes, 'function');
    // The earlier hoist kept LINT_IMG_RE/LINT_ALT_RE internal; this step must not
    // start exporting them.
    assert.equal(routes.LINT_IMG_RE, undefined);
    assert.equal(routes.LINT_ALT_RE, undefined);
  });

  it('exports each const with the exact source, flags, and no lastIndex state', () => {
    for (const [name, ref] of Object.entries(EXPECTED)) {
      const re = routes[name];
      assert.ok(re instanceof RegExp, `${name} is a RegExp`);
      assert.equal(re.source, ref.source, `${name}.source`);
      assert.equal(re.flags, ref.flags, `${name}.flags`);
      assert.equal(re.global, false, `${name}.global`);
      assert.equal(re.sticky, false, `${name}.sticky`);
    }
  });

  it('builds each const once: a second require hands back the identical instances', () => {
    // The module is cached, so a second require returns the same exports. A
    // per-request or per-line allocation could not satisfy this identity. The
    // fence and heading-prefix consts each replaced two identical inline sites,
    // so this also confirms each collapsed pair is a single shared instance.
    const second = require(SPECIFIER);
    for (const name of Object.keys(EXPECTED)) {
      assert.strictEqual(second[name], routes[name], `${name} is a singleton`);
    }
  });

  it('collapses each duplicate pair to one shared const used at both former sites', () => {
    // Structural counterpart to the behavioral cases: read the source and confirm
    // the collapse directly. Each collapsed pattern is defined once and referenced
    // at both of its former inline sites, with no inline literal surviving, so the
    // two former sites provably share one instance.
    const src = require('node:fs').readFileSync(require.resolve(SPECIFIER), 'utf8');
    const count = (needle) => src.split(needle).length - 1;

    // Exactly one const definition for each collapsed pattern.
    assert.equal(count('const LINT_FENCE_RE ='), 1);
    assert.equal(count('const LINT_HEADING_PREFIX_RE ='), 1);

    // Two call sites each: unclosed-block plus long-line toggle for the fence,
    // empty-section outer plus inner loop for the heading prefix.
    assert.equal(count('LINT_FENCE_RE.test('), 2);
    assert.equal(count('LINT_HEADING_PREFIX_RE.test('), 2);

    // No inline literal of either collapsed pattern remains at a call site.
    assert.equal(count('/^```/.test('), 0);
    assert.equal(count('/^#{1,6}\\s+/.test('), 0);
  });

  it('flags a frontmatter block that has no title field', async () => {
    const { status, payload } = await lint('---\ntags: [demo]\n---\nBody with no heading.\n');
    assert.equal(status, 200);
    assert.deepStrictEqual(payload.issues, [
      { line: 1, column: 1, message: 'Frontmatter is missing a title field', severity: 'warning' },
    ]);
  });

  it('stays silent when the frontmatter has a title field', async () => {
    const { status, payload } = await lint('---\ntitle: Present\n---\nBody with no heading.\n');
    assert.equal(status, 200);
    assert.deepStrictEqual(payload.issues, []);
  });

  it('reports a duplicate heading and points at the first occurrence', async () => {
    const doc = '# Intro\nText under intro.\n## Intro\nText under sub.\n';
    const { status, payload } = await lint(doc);
    assert.equal(status, 200);
    assert.deepStrictEqual(payload.issues, [
      { line: 3, column: 1, message: 'Duplicate heading: "Intro" (first at line 1)', severity: 'warning' },
    ]);
  });

  it('reports an empty section when a heading is followed straight by another', async () => {
    const doc = '# Lonely\n## Also Lonely\nContent under the second.\n';
    const { status, payload } = await lint(doc);
    assert.equal(status, 200);
    assert.deepStrictEqual(payload.issues, [
      { line: 1, column: 1, message: 'Empty section — heading has no content before next heading or end of file', severity: 'warning' },
    ]);
  });

  it('reports an unclosed code block from an odd fence count', async () => {
    const doc = '```js\nsome code\n';
    const { status, payload } = await lint(doc);
    assert.equal(status, 200);
    assert.deepStrictEqual(payload.issues, [
      { line: 1, column: 1, message: 'Unclosed code block (odd number of ``` fences)', severity: 'error' },
    ]);
  });

  it('flags relative image paths but not absolute or http ones', async () => {
    const doc = '![ok](https://cdn.example.com/a.png)\n![bad](relative/b.png)\n![abs](/c.png)\n';
    const { status, payload } = await lint(doc);
    assert.equal(status, 200);
    assert.deepStrictEqual(payload.issues, [
      { line: 2, column: 1, message: 'Possibly broken image reference: "relative/b.png" (relative path, should start with / or http)', severity: 'warning' },
    ]);
  });

  it('skips long URL-only and link-only lines, and lines inside a code fence', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(200);
    const longLink = '[ref](https://example.com/' + 'b'.repeat(200) + ')';
    const longPlain = 'x'.repeat(210);
    const doc = ['```', longPlain, '```', longUrl, longLink, longPlain].join('\n');
    const { status, payload } = await lint(doc);
    assert.equal(status, 200);
    // Line 2 is long but inside the fence; lines 4 and 5 are long but URL-only
    // and link-only. Only line 6 (plain text outside the fence) is flagged.
    assert.deepStrictEqual(payload.issues, [
      { line: 6, column: 201, message: 'Line is 210 characters long (exceeds 200 char limit)', severity: 'warning' },
    ]);
  });

  it('returns the same findings as before for a representative document', async () => {
    // One document touching every hoisted regex: a missing-title frontmatter, a
    // duplicate heading, an empty section, a balanced code fence, and long URL,
    // link-only, and plain lines. The expected array follows the handler's check
    // order (frontmatter, headings, long lines, empty sections), which is not
    // sorted by line number.
    const longUrl = 'https://example.com/' + 'a'.repeat(200);
    const longLink = '[ref](https://example.com/' + 'b'.repeat(200) + ')';
    const longPlain = 'x'.repeat(210);
    const doc = [
      '---',                          // 1
      'tags: [demo]',                 // 2
      '---',                          // 3
      '# Overview',                   // 4
      'Intro under overview.',        // 5
      '## Overview',                  // 6  duplicate heading
      'Body under second overview.',  // 7
      '## Empty',                     // 8  empty section
      '## Filled',                    // 9
      'Filled body.',                 // 10
      '```',                          // 11 fence open
      'inside code block line',       // 12
      '```',                          // 13 fence close
      longUrl,                        // 14 skipped (url-only)
      longLink,                       // 15 skipped (link-only)
      longPlain,                      // 16 flagged (plain, long)
    ].join('\n');

    const { status, payload } = await lint(doc);
    assert.equal(status, 200);
    assert.deepStrictEqual(payload.issues, [
      { line: 1, column: 1, message: 'Frontmatter is missing a title field', severity: 'warning' },
      { line: 6, column: 1, message: 'Duplicate heading: "Overview" (first at line 4)', severity: 'warning' },
      { line: 16, column: 201, message: 'Line is 210 characters long (exceeds 200 char limit)', severity: 'warning' },
      { line: 8, column: 1, message: 'Empty section — heading has no content before next heading or end of file', severity: 'warning' },
    ]);
  });

  it('produces identical output on two back-to-back requests', async () => {
    const doc = '---\ntags: [x]\n---\n# A\n# A\n```\nunterminated\n';
    const first = await lint(doc);
    const second = await lint(doc);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The shared consts are non-global, so .test()/.match() never carry a
    // lastIndex between requests; the findings are stable call to call.
    assert.deepStrictEqual(second.payload.issues, first.payload.issues);
  });
});
