import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling guard suites do (next-misctools-readingprogress-post-guards.test.mjs
// and next-misc-filetarget-write-guards.test.mjs) so these cases exercise the
// shipped GET /api/file/target handler in server/routes/misc-tools.js rather
// than a reimplementation. The handler runs over a fully mocked ctx: no real
// filesystem, network, clock, or randomness is touched, except where a stub
// deliberately stands in for one.
//
// This is an add-only characterization test. The POST sibling at the same path
// is already covered by next-misc-filetarget-write-guards.test.mjs; this file
// pins the GET handler, which that suite never touches. Each case pins the
// CURRENT behavior of one branch so a future refactor cannot silently change a
// status code, an error message, the guard order, or the word count and
// progress math. No source file is edited.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The handler reads the per-file word-count targets from this path, mirroring
// server/index.js (path.join(PROJECT_ROOT, 'var', 'data', 'targets.json')). The mocked
// loadJSON answers only for this exact path, so a stray read on a guard branch
// surfaces as a thrown error instead of silently passing; the same constant is
// handed to the handler through ctx, so the guard and the handler agree on it.
const TARGETS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'targets.json');

// Drive GET /api/file/target over a mocked ctx. isValidFilePath is a per-call
// toggle that records every path it is asked about; fs.existsSync and
// fs.readFileSync are stubs that record their arguments and return the supplied
// `exists` flag and `fileContent`; loadJSON returns a fresh deep copy of
// `targets` keyed on TARGETS_FILE and counts its calls; json captures the
// (status, body) handed back. The recorders let each branch prove exactly which
// steps ran, so the guard order and short-circuit points are pinned, not just
// the final status. The path query parameter is attached only when `pathParam`
// is provided, so omitting it reproduces a request with no path at all.
async function runGetTarget({
  pathParam,
  targets = {},
  validPath = true,
  exists = true,
  fileContent = '',
} = {}) {
  const isValidFilePathCalls = [];
  const existsSyncCalls = [];
  const readFileSyncCalls = [];
  let loadJSONCount = 0;
  let captured = null;
  const ctx = {
    isValidFilePath: (p) => { isValidFilePathCalls.push(p); return validPath; },
    path,
    PROJECT_ROOT,
    TARGETS_FILE,
    fs: {
      existsSync: (p) => { existsSyncCalls.push(p); return exists; },
      readFileSync: (p, enc) => { readFileSyncCalls.push({ p, enc }); return fileContent; },
    },
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === TARGETS_FILE) return JSON.parse(JSON.stringify(targets));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/file/target';
  const url = new URL(`http://localhost${pathname}`);
  if (pathParam !== undefined) url.searchParams.set('path', pathParam);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, isValidFilePathCalls, existsSyncCalls, readFileSyncCalls, loadJSONCount };
}

describe('GET /api/file/target guards in routes/misc-tools.js', () => {
  it('a request with no path query parameter returns 400 Missing path query parameter and runs no validator, fs probe, or load', async () => {
    const r = await runGetTarget({ pathParam: undefined });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing path query parameter' });
    assert.equal(r.isValidFilePathCalls.length, 0, 'the missing-path guard returns before isValidFilePath');
    assert.equal(r.existsSyncCalls.length, 0);
    assert.equal(r.readFileSyncCalls.length, 0);
    assert.equal(r.loadJSONCount, 0);
  });

  it('an empty-string path is falsy and trips the same guard, returning 400 Missing path query parameter', async () => {
    // searchParams.get('path') returns '' for a bare ?path= , which is falsy, so
    // it reaches the same branch as an absent parameter.
    const r = await runGetTarget({ pathParam: '' });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing path query parameter' });
    assert.equal(r.isValidFilePathCalls.length, 0);
    assert.equal(r.existsSyncCalls.length, 0);
    assert.equal(r.loadJSONCount, 0);
  });

  it('a path rejected by isValidFilePath returns 400 Invalid file path, asking the validator once and never touching fs or load', async () => {
    const r = await runGetTarget({ pathParam: '../etc/passwd', validPath: false });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid file path' });
    assert.deepEqual(r.isValidFilePathCalls, ['../etc/passwd']);
    assert.equal(r.existsSyncCalls.length, 0, 'the invalid-path guard returns before existsSync');
    assert.equal(r.readFileSyncCalls.length, 0);
    assert.equal(r.loadJSONCount, 0);
  });

  it('a valid path whose file is absent returns 404 File not found, probing the joined full path once and never loading targets', async () => {
    const r = await runGetTarget({ pathParam: 'content/a.md', exists: false });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'File not found' });
    assert.deepEqual(r.isValidFilePathCalls, ['content/a.md']);
    assert.deepEqual(r.existsSyncCalls, [path.join(PROJECT_ROOT, 'content/a.md')]);
    assert.equal(r.loadJSONCount, 0, 'the not-found guard returns before loadJSON');
    assert.equal(r.readFileSyncCalls.length, 0);
  });

  it('an existing file with no entry in the targets map returns 404 No target set for this file, loading targets once but never reading the file', async () => {
    const r = await runGetTarget({ pathParam: 'content/a.md', exists: true, targets: { 'content/other.md': 50 } });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'No target set for this file' });
    assert.equal(r.loadJSONCount, 1);
    assert.equal(r.readFileSyncCalls.length, 0, 'the no-target guard returns before readFileSync');
  });

  it('an existing file whose stored target is 0 is treated as no target (the guard tests falsiness, not membership), returning 404 No target set for this file', async () => {
    // 0 is a number, but `!target` is true, so a 0 target reaches the same 404 as
    // a missing entry; this pins the falsy-guard semantics, not just absence.
    const r = await runGetTarget({ pathParam: 'content/a.md', exists: true, targets: { 'content/a.md': 0 } });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'No target set for this file' });
    assert.equal(r.loadJSONCount, 1);
    assert.equal(r.readFileSyncCalls.length, 0);
  });

  it('an existing file under its target returns 200 with the word count and a progress rounded to three decimals', async () => {
    // 3 whitespace-split words against a target of 4: progress is 3 / 4 = 0.75.
    const r = await runGetTarget({ pathParam: 'content/a.md', exists: true, targets: { 'content/a.md': 4 }, fileContent: 'one two three' });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(r.captured.body, { target: 4, current: 3, progress: 0.75 });
    assert.deepEqual(r.existsSyncCalls, [path.join(PROJECT_ROOT, 'content/a.md')]);
    assert.deepEqual(r.readFileSyncCalls, [{ p: path.join(PROJECT_ROOT, 'content/a.md'), enc: 'utf-8' }]);
    assert.equal(r.loadJSONCount, 1);
  });

  it('a word count above the target clamps progress to 1', async () => {
    // 5 words against a target of 4: 5 / 4 = 1.25, clamped by Math.min(1, ...).
    const r = await runGetTarget({ pathParam: 'content/a.md', exists: true, targets: { 'content/a.md': 4 }, fileContent: 'a b c d e' });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(r.captured.body, { target: 4, current: 5, progress: 1 });
  });

  it('a fractional progress is rounded to three decimals, not two', async () => {
    // 1 word against a target of 3: 1 / 3 = 0.3333..., which rounds to 0.333.
    const r = await runGetTarget({ pathParam: 'content/a.md', exists: true, targets: { 'content/a.md': 3 }, fileContent: 'solo' });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(r.captured.body, { target: 3, current: 1, progress: 0.333 });
  });

  it('the word count splits on runs of whitespace and drops empty tokens', async () => {
    // Leading, trailing, and repeated whitespace (including newlines) collapse:
    // the content holds exactly four words, so against a target of 8 progress is
    // 4 / 8 = 0.5. This pins the split(/\s+/).filter(Boolean) word count.
    const r = await runGetTarget({ pathParam: 'content/a.md', exists: true, targets: { 'content/a.md': 8 }, fileContent: '  one   two\n\nthree   four  ' });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(r.captured.body, { target: 8, current: 4, progress: 0.5 });
  });
});
