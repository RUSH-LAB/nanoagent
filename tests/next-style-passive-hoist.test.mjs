import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';

// The GET /api/file/style handler reads a SINGLE file by path
// (fs.readFileSync(path.join(PROJECT_ROOT, filePath))); it never walks a
// directory, so the stub only needs readFileSync keyed by absolute path.
function makeFs(absFileMap) {
  return {
    readFileSync(fp) {
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Drive GET /api/file/style with a mocked ctx and capture the payload handed to
// json(res, status, payload). isValidFilePath defaults to accepting the path so
// the happy path reaches the file read; pass a rejecting validator to exercise
// the 400 guard.
async function invokeStyle(fs, filePath, { isValidFilePath = () => true } = {}) {
  const url = new URL(`http://localhost/api/file/style?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    isValidFilePath,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/style', ctx);
  return captured;
}

const REL_PATH = 'content/sample.md';
const ABS_PATH = path.join(PROJECT_ROOT, REL_PATH);

// Five sentences after the `[.!?]+` split (each longer than 5 chars once
// trimmed). Three carry a passive-voice construction STYLE_PASSIVE_RE matches:
// "was created", "is maintained", "are summarized" — an is/are/was/were/been/being
// auxiliary followed by a word ending in "ed". The frontmatter note "was
// reviewed" sits inside the stripped `--- ... ---` block, so it must NOT be
// counted; that pins the handler still strips frontmatter before matching.
const SAMPLE = `---
title: Style Sample
note: this file was reviewed already
---

The document was created by the author. This page is maintained regularly. Readers enjoy the clear prose style here. The results are summarized in a table. We discuss the method in detail today.
`;

// passiveCount = 3 over totalSentences = 5  ->  round(3 / 5 * 100) = 60. Pinning
// both fields makes the underlying count of 3 unambiguous (round(2/5)=40,
// round(4/5)=80, so only a count of 3 yields 60 at 5 sentences).
const EXPECTED_PERCENTAGE = 60;
const EXPECTED_SENTENCES = 5;

function fsWithSample() {
  return makeFs(new Map([[ABS_PATH, SAMPLE]]));
}

describe('GET /api/file/style (STYLE_PASSIVE_RE hoisted to module scope)', () => {
  it('reports the exact passive-voice percentage from the shared regex', async () => {
    const r = await invokeStyle(fsWithSample(), REL_PATH);
    assert.equal(r.status, 200);
    assert.equal(r.payload.style.totalSentences, EXPECTED_SENTENCES);
    // 3 passive constructions over 5 sentences; the frontmatter's "was reviewed"
    // is stripped, so only the three body matches count.
    assert.equal(r.payload.style.passiveVoicePercentage, EXPECTED_PERCENTAGE);
  });

  it('returns an identical passive count on a second back-to-back request', async () => {
    const fs = fsWithSample();
    const first = await invokeStyle(fs, REL_PATH);
    const second = await invokeStyle(fs, REL_PATH);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // STYLE_PASSIVE_RE is shared module state across requests. Because
    // String.prototype.match resets lastIndex on every call, two identical
    // requests must yield the same passive count, both matching the expected
    // percentage; this proves the shared /g regex carries no state between
    // requests.
    assert.equal(second.payload.style.passiveVoicePercentage, EXPECTED_PERCENTAGE);
    assert.equal(second.payload.style.passiveVoicePercentage, first.payload.style.passiveVoicePercentage);
    assert.deepEqual(second.payload.style, first.payload.style);
  });

  it('stays correct when STYLE_PASSIVE_RE carries a stale lastIndex (match needs no manual reset)', async () => {
    // The exec-loop regexes in this file reset lastIndex per file; this handler
    // deliberately does NOT, because String.prototype.match sets lastIndex to 0
    // before scanning. Pre-seed a large lastIndex to simulate state leaking in
    // from a prior request, then confirm the count is unaffected; this is what
    // makes the no-reset hoist safe.
    assert.ok(routes.STYLE_PASSIVE_RE instanceof RegExp, 'handler regex is exported for this guard');
    routes.STYLE_PASSIVE_RE.lastIndex = 100000;
    const r = await invokeStyle(fsWithSample(), REL_PATH);
    assert.equal(r.status, 200);
    assert.equal(r.payload.style.passiveVoicePercentage, EXPECTED_PERCENTAGE);
  });

  it('rejects an invalid path with 400 before reading any file', async () => {
    let read = false;
    const fs = { readFileSync() { read = true; throw new Error('should not read'); } };
    const r = await invokeStyle(fs, '../etc/passwd', { isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(read, false);
  });

  it('returns 404 when the file cannot be read', async () => {
    // Empty fs: readFileSync throws ENOENT and the handler's catch maps it to the
    // not-found envelope.
    const r = await invokeStyle(makeFs(new Map()), REL_PATH);
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
  });
});
