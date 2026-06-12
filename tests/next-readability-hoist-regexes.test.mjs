import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';

// GET /api/file/readability reads exactly one file (the page under analysis) and
// never walks a directory, so the stub only needs readFileSync keyed by the
// absolute path the handler builds from PROJECT_ROOT + the query path. Passing
// content === undefined models a missing file: readFileSync throws ENOENT for
// every path, driving the handler into its catch/404 branch.
function makeFs(filePath, content) {
  const abs = content === undefined ? null : path.join(PROJECT_ROOT, filePath);
  return {
    readFileSync(fp) {
      if (abs !== null && fp === abs) return content;
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Drive GET /api/file/readability with a mocked ctx and capture the json()
// response. isValidFilePath defaults to accepting any path so the assertions
// focus on the handler body rather than path validation.
async function getReadability(filePath, content, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    isValidFilePath,
    fs: makeFs(filePath, content),
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL(`http://localhost/api/file/readability?path=${encodeURIComponent(filePath)}`);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/readability', ctx);
  return captured;
}

// A few sentences of prose wrapped in frontmatter and a heading so the handler
// exercises its markdown stripping before scoring. The words deliberately cover
// every branch of READ_SYLLABLE_TRIM_RE plus READ_LEADING_Y_RE: "young"/"yearly"
// (leading y), "jumped"/"learned" (ed), "sentences" (consonant + es), and
// "machine"/"everyone"/"prose" (consonant + e). The expected payload was
// captured from the handler and independently reproduced by a fresh inline
// re-implementation of the pre-hoist regexes, so it pins the behavior the hoist
// must preserve.
const SAMPLE = `---
title: Readability Sample
---

# Syllable Coverage

The young researchers studied machine learning yearly and jumped between ideas.
They learned that simple sentences improve reading scores for everyone reading.
Computers process language, yet humans still value clear and concise prose.
`;

const EXPECTED = {
  wordCount: 35,
  sentenceCount: 3,
  avgWordsPerSentence: 11.7,
  avgSyllablesPerWord: 1.7,
  fleschKincaidGrade: 9,
  readingLevel: 'Intermediate',
  readingTimeMinutes: 1,
};

describe('GET /api/file/readability (READ_* syllable regexes hoisted to module scope)', () => {
  it('returns the exact pre-hoist readability metrics for a prose sample', async () => {
    const res = await getReadability('content/sample.md', SAMPLE);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED);
  });

  it('returns identical metrics across repeated back-to-back requests', async () => {
    // READ_NONALPHA_RE and READ_VOWEL_GROUP_RE are /g regexes now shared across
    // requests. replace() and match() reset lastIndex on every call, so sharing
    // the instances across requests is safe; this pins that the handler stays
    // deterministic call-to-call rather than drifting on the second or third hit.
    const first = await getReadability('content/sample.md', SAMPLE);
    const second = await getReadability('content/sample.md', SAMPLE);
    const third = await getReadability('content/sample.md', SAMPLE);
    assert.deepEqual(first.payload, EXPECTED);
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(third.payload, first.payload);
  });

  it('counts syllables exactly for a ten-word sentence', async () => {
    // Exactly ten words in one sentence, so avgSyllablesPerWord (rounded to one
    // decimal) multiplied by wordCount recovers the integer total syllable count
    // with no rounding loss: 1.6 * 10 === 16. This pins the syllable counter that
    // the hoisted READ_* regexes drive.
    const TEN = 'Young scholars studied machine learning and jumped over lazy foxes.';
    const res = await getReadability('content/ten.md', TEN);
    assert.equal(res.status, 200);
    assert.equal(res.payload.wordCount, 10);
    assert.equal(res.payload.avgSyllablesPerWord, 1.6);
    assert.equal(res.payload.avgSyllablesPerWord * res.payload.wordCount, 16);
    assert.equal(res.payload.fleschKincaidGrade, 7.2);
    assert.equal(res.payload.readingLevel, 'Intermediate');
  });

  it('rejects an invalid path with 400', async () => {
    const res = await getReadability('../etc/passwd', '', () => false);
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid path' });
  });

  it('returns 404 when the file cannot be read', async () => {
    // No content registered, so the mock fs throws ENOENT and the handler falls
    // through to its catch/404 branch.
    const res = await getReadability('content/missing.md');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'File not found' });
  });
});
