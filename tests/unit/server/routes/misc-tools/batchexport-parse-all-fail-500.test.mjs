import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the REAL route module the way the sibling
// batch-export tests do (next-batchexport-guard-branches.test.mjs shares this
// same driver and ctx harness).
const require = createRequire(import.meta.url);
const miscRoutes = require('../../../../../src/server/routes/misc-tools.js');
// Reuse the production isValidDir so the first guard is pinned against the real
// contract, exactly as the guard-branches sibling does.
const { isValidDir } = require('../../../../../src/server/server-utils.js');

const PROJECT_ROOT = '/fake/root';
const EXPORT_DIR = 'content/batch-sample';

// A Dirent-like entry for the readdirSync(d, {withFileTypes: true}) walk.
function dirent(name, kind) {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
  };
}

// An fs whose directory walk SUCCEEDS (the markdown files are found, so the
// 404 'No markdown files found in directory' branch is passed) but whose
// readFileSync THROWS for every file. existsSync/statSync/readdirSync are
// deliberately non-throwing: they run OUTSIDE the per-file try/catch, so a throw
// there would surface through the handler's outer catch as the unrelated
// 'Batch export failed' 500 rather than the 'Failed to parse any files' branch
// under test. `reads` counts the swallowed readFileSync attempts so the test can
// prove every discovered file was tried and threw.
function makeAllReadsThrowFs(names) {
  const fullDir = path.join(PROJECT_ROOT, EXPORT_DIR);
  const counter = { reads: 0 };
  const fs = {
    existsSync: (p) => p === fullDir,
    statSync: (p) => ({ isDirectory: () => p === fullDir }),
    readdirSync: (d) => (d === fullDir ? names.map((n) => dirent(n, 'file')) : []),
    readFileSync: () => {
      counter.reads++;
      const err = new Error('EIO: simulated unreadable file');
      err.code = 'EIO';
      throw err;
    },
  };
  return { fs, counter };
}

// Same harness, except ONE named file reads successfully while the rest throw.
// Used as the boundary control: a single surviving section is enough to leave
// the empty-sections branch, so the 500 above is provably specific to the
// all-reads-fail condition rather than a mock that 500s regardless.
function makeOneReadableFs(goodName, goodText, badNames) {
  const fullDir = path.join(PROJECT_ROOT, EXPORT_DIR);
  const goodAbs = path.join(fullDir, goodName);
  const all = [goodName, ...badNames];
  return {
    existsSync: (p) => p === fullDir,
    statSync: (p) => ({ isDirectory: () => p === fullDir }),
    readdirSync: (d) => (d === fullDir ? all.map((n) => dirent(n, 'file')) : []),
    readFileSync: (p) => {
      if (p === goodAbs) return goodText;
      const err = new Error('EIO: simulated unreadable file');
      err.code = 'EIO';
      throw err;
    },
  };
}

// Drive GET /api/export/batch through a mocked ctx (no network, no real fs).
// Returns whatever the handler emitted: the {status, body} captured by json()
// on an error path, or the HTML string passed to res.end on the success path.
async function runBatch(fs) {
  let captured = null;
  const res = {
    writableEnded: false,
    writeHead() { return res; },
    end(body) { captured = body; res.writableEnded = true; return res; },
  };
  const ctx = {
    path,
    PROJECT_ROOT,
    CORS_ORIGIN: '*',
    isValidDir,
    fs,
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
  };
  const url = new URL(
    `http://localhost/api/export/batch?dir=${encodeURIComponent(EXPORT_DIR)}&format=html`,
  );
  await miscRoutes({ method: 'GET' }, res, url, '/api/export/batch', ctx);
  return captured;
}

describe('GET /api/export/batch 500 when every file read throws (pins current behavior)', () => {
  it('returns 500 "Failed to parse any files" when markdown is found but all reads throw', async () => {
    // Two .md files are discovered (so the 404 'No markdown files' branch is
    // passed), but every readFileSync throws and the handler swallows each error
    // inside the per-file try/catch. No section accumulates, so misc-tools.js
    // line 1036 returns the 500.
    const { fs, counter } = makeAllReadsThrowFs(['alpha.md', 'beta.md']);
    const captured = await runBatch(fs);
    assert.deepStrictEqual(captured, {
      status: 500,
      body: { error: 'Failed to parse any files' },
    });
    // Every discovered file was attempted and threw: this is the genuine
    // all-reads-fail precondition, not an empty-directory 404 reached without
    // any read at all.
    assert.equal(counter.reads, 2);
  });

  it('does NOT hit that 500 when a single file reads successfully (boundary control)', async () => {
    // One readable file is enough to skip the empty-sections branch and emit the
    // HTML export document, proving the 500 above is specific to the
    // all-reads-fail condition.
    const captured = await runBatch(
      makeOneReadableFs('good.md', '# Hello', ['bad.md']),
    );
    assert.notDeepStrictEqual(captured, {
      status: 500,
      body: { error: 'Failed to parse any files' },
    });
    assert.equal(typeof captured, 'string');
    assert.ok(captured.includes('<!DOCTYPE html>'));
  });
});
