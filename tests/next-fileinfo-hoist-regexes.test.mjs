import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// Build CJK text from explicit code points so the fixtures never depend on the
// editor's input method (a compatibility ideograph such as U+F900 renders the
// same as its unified twin U+8C48 but is a different character). The six
// /api/file/info regexes were hoisted to module scope; the CJK class spans three
// ranges that must be preserved exactly:
//   • U+4E00–U+9FFF  CJK Unified Ideographs
//   • U+3400–U+4DBF  CJK Extension A
//   • U+F900–U+FAFF  CJK Compatibility Ideographs
const cp = (...codes) => String.fromCodePoint(...codes);

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileinfo-hoist-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Write a fixture under the temp root; return its PROJECT_ROOT-relative path.
function writeFixture(rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
  return rel;
}

// Drive the real GET /api/file/info handler over a fixture and capture json().
// isValidFilePath defaults to accepting any path so tests focus on the handler.
async function getInfo(filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    isValidFilePath,
    // The handler now wraps its scan in cached(key, ttl, fn); a pass-through here
    // keeps these regex tests exercising the real computation on every call.
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL(`http://localhost/api/file/info?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await graphRoutes(req, res, url, '/api/file/info', ctx);
  return captured;
}

// Kitchen-sink fixture: CJK + Latin, a fenced code block, inline and display
// math, exactly one citation, and exactly one image. Exercises every hoisted
// regex at least once so a stale lastIndex would change the second pass.
const MIXED = [
  '---',
  'title: Mixed Fixture',
  '---',
  '',
  `# ${cp(0x6807, 0x9898)} Heading with English ${cp(0x4E2D, 0x6587)} text`,
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  'Inline math $E = mc^2$ and display $$a + b$$ together.',
  '',
  'A reference [@smith2020] and an image ![diagram](fig.png).',
  '',
].join('\n');

describe('GET /api/file/info (hoisted module-scope regexes)', () => {
  it('returns byte-identical responses on two back-to-back calls (no lastIndex bleed)', async () => {
    const rel = writeFixture('content/mixed.md', MIXED);
    const first = await getInfo(rel);
    const second = await getInfo(rel);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The shared g-flag regexes are consumed through String.prototype.match,
    // which resets lastIndex, so a second pass over the same file is identical.
    // If a future change leaked lastIndex across requests, the counts would drop
    // on the second call and this byte comparison would fail.
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
  });

  it('reports the content features detected by the hoisted regexes', async () => {
    const rel = writeFixture('content/features.md', MIXED);
    const { status, payload } = await getInfo(rel);
    assert.equal(status, 200);
    assert.equal(payload.hasFrontmatter, true);
    assert.equal(payload.draft, false);
    assert.equal(payload.hasCodeBlocks, true); // the ``` fence
    assert.equal(payload.hasMath, true);       // $...$ and $$...$$
    assert.equal(payload.citationCount, 1);    // exactly one [@...]
    assert.equal(payload.imageCount, 1);       // exactly one ![...]
  });

  it('detects language across all three CJK Unicode ranges plus Latin', async () => {
    // 3 CJK chars, one from each preserved range, then a Hangul char (U+AC00)
    // that must NOT count, then 7 Latin letters. cjk=3, latin=7 → cjkRatio 0.3
    // (not > 0.3) and latinRatio 0.7 (not > 0.7) → 'mixed'. Dropping Extension A
    // or Compatibility would tip the result to 'english'; widening the range to
    // swallow U+AC00 would tip it to 'chinese'. So 'mixed' pins every boundary.
    const ranges = writeFixture('content/ranges.md', cp(0x4E2D, 0x3400, 0xF900, 0xAC00) + ' abcdefg');
    assert.equal((await getInfo(ranges)).payload.detectedLanguage, 'mixed');

    // cjk=2, latin=1 → cjkRatio 0.667 > 0.3 → 'chinese'.
    const chinese = writeFixture('content/zh.md', cp(0x4E2D, 0x6587) + ' a');
    assert.equal((await getInfo(chinese)).payload.detectedLanguage, 'chinese');

    // cjk=1, latin=10 → cjkRatio 0.09, latinRatio 0.909 > 0.7 → 'english'.
    const english = writeFixture('content/en.md', cp(0x4E2D) + ' abcdefghij');
    assert.equal((await getInfo(english)).payload.detectedLanguage, 'english');

    // No letters at all → totalLetters 0 → stays 'mixed'.
    const none = writeFixture('content/none.md', '123 456 !!!');
    assert.equal((await getInfo(none)).payload.detectedLanguage, 'mixed');
  });

  it('rejects an invalid path with 400 and a missing file with 404', async () => {
    assert.equal((await getInfo('../etc/passwd', () => false)).status, 400);
    assert.equal((await getInfo('content/missing.md')).status, 404);
  });
});
