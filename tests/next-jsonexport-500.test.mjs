import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// content-analysis-a.js is CommonJS; load the REAL module via createRequire the way
// the sibling route suites do (next-byauthor-500, next-byvenue-500), so this
// characterization test drives the genuine GET /api/references/export-json handler
// instead of a reimplementation.
//
// Unlike its references.js siblings, this handler STREAMS its success: on the happy
// path it builds `JSON.stringify(refs, null, 2)` and writes it with
// `res.writeHead(200, {...})` + `res.end(jsonStr)` (content-analysis-a.js:668-670).
// ONLY the failure path uses json(): the whole body runs inside one try (opens at
// content-analysis-a.js:666) whose first failable step is
// `loadReferencesCached(fs, path, PROJECT_ROOT)` (:667). A throw there lands in the
// outer catch at :671-672, which returns json(res, 500, {error: 'JSON export
// failed'}). Because success streams rather than calling json(), the mock res below
// records writeHead/end so a test can prove the streamed 200 is bypassed on the 500
// seam, and conversely that the swallow path really streams a 200 (not a 500).
//
// Reaching this 500 is subtle because loadReferencesCached SWALLOWS fs and parse
// errors. Its fs.statSync is try/caught (→ null on throw, so the module cache is
// bypassed and the file is read directly) and its yaml.load(fs.readFileSync(...)) is
// try/caught (→ {} on ANY read or parse error). So a throwing readFileSync, or
// genuinely-invalid YAML, is swallowed to {}; JSON.stringify({}) succeeds and the
// handler STREAMS a 200. The reliable 500 seam is therefore a LOADER-LEVEL throw:
// loadReferencesCached's first statement,
// `path.join(projectRoot, 'bibliography', 'references.yaml')` (references.js:34), is
// the one op outside the loader's internal try/catch, so a throwing path.join escapes
// the loader and lands in this handler's outer catch.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/virtual-root';
const CORS_ORIGIN = 'https://example.test';

// The exact reply the outer catch emits, captured in the {status, body} shape used by
// the json() stub below.
const GOLDEN_500 = {
  status: 500,
  body: { error: 'JSON export failed' },
};

// The exact headers the streaming success path writes at content-analysis-a.js:669,
// with CORS_ORIGIN threaded from ctx. The contrast case pins this to document the real
// 200 streaming contract.
const STREAM_200_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Content-Disposition': 'attachment; filename="references.json"',
  'Access-Control-Allow-Origin': CORS_ORIGIN,
};

// Seam (500): LOADER-LEVEL throw. A path whose join() throws makes
// loadReferencesCached throw at its very first statement (references.js:34, the only
// op outside the loader's internal try/catch), before any stat or read, so the throw
// escapes the loader straight into the handler's outer catch → json(res, 500, ...).
function throwingJoinPath() {
  let joinCalls = 0;
  return {
    get joinCalls() { return joinCalls; },
    join() { joinCalls++; throw new Error('path.join unavailable'); },
  };
}

// The fs paired with the 500 seam records its calls so the test can prove neither the
// stat nor the read ran (the path.join throw precedes both). Its return values are
// benign and never observed.
function recordingFs() {
  let statCalls = 0;
  let readFileCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readFileCalls() { return readFileCalls; },
    statSync() { statCalls++; return { mtimeMs: 0, size: 0 }; },
    readFileSync() { readFileCalls++; return 'k:\n'; },
  };
}

// Seam (contrast / streaming 200): a SWALLOWED fs failure. statSync throws so the
// loader's best-effort stat falls through (stat stays null, the cache is skipped) and
// readFileSync ALSO throws, so loadReferencesCached's inner try/catch returns {}.
// JSON.stringify({}, null, 2) then succeeds and the handler STREAMS a 200, proving a
// swallowed fs error is NOT a 500.
function swallowingFs() {
  let statCalls = 0;
  let readFileCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readFileCalls() { return readFileCalls; },
    statSync() { statCalls++; throw new Error('stat unavailable'); },
    readFileSync() { readFileCalls++; throw new Error('read unavailable'); },
  };
}

// A mock res that records the streaming primitives the success path uses. Methods are
// closed over `res` (not `this`) so the recordings survive however the handler calls
// them, and each flips writableEnded the way Node's ServerResponse would.
function makeRes() {
  const res = {
    writableEnded: false,
    writeHeadCalls: [],
    endCalls: [],
    writeHead(status, headers) {
      res.writeHeadCalls.push({ status, headers });
      res.writableEnded = true;
      return res;
    },
    end(body) {
      res.endCalls.push(body);
      res.writableEnded = true;
      return res;
    },
  };
  return res;
}

// Drive the REAL GET /api/references/export-json handler over a mocked ctx. The caller
// supplies the fs and path seams used to steer the single try, plus the res whose
// writeHead/end are recorded. Every json(res, status, payload) write is captured in
// `replies` so a test can assert whether the 500 fired. Only the ctx fields this route
// reads are supplied (json, fs, path, PROJECT_ROOT, CORS_ORIGIN); the rest stay
// undefined because this handler never touches them.
//
// No cache reset is needed for isolation: the references memo (module state in
// references.js) is bypassed on BOTH seams. The 500 seam throws at path.join before
// the stat, and the streaming seam's statSync throw forces stat=null, so the loader's
// `if (stat && referencesCache && ...)` check is skipped regardless of prior state.
async function runExportJson({ fs, path }) {
  const replies = [];
  const res = makeRes();
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path,
    PROJECT_ROOT,
    CORS_ORIGIN,
  };
  const pathname = '/api/references/export-json';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, res, url, pathname, ctx);
  return { replies, res };
}

describe('GET /api/references/export-json outer catch returns 500 JSON export failed', () => {
  it('maps a loader-level throw (path.join throws) into the 500 reply, before any stat or read', async () => {
    const fs = recordingFs();
    const path = throwingJoinPath();
    const { replies, res } = await runExportJson({ fs, path });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and the
    // exact error-body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the loader's first statement path.join (the only op
    // outside its internal try/catch), so neither the stat nor the read ran.
    assert.equal(path.joinCalls, 1, 'the loader reached its path.join first statement');
    assert.equal(fs.statCalls, 0, 'the throw preceded the best-effort stat');
    assert.equal(fs.readFileCalls, 0, 'the throw preceded the file read');

    // Never-reached proof for the streaming 200, anchored against a vacuous pass by the
    // length check above: no json() reply carries a 200, res.writeHead was never called
    // (so never with 200), res.end never fired, and the response never ended. The
    // success projection at content-analysis-a.js:669-670 is fully bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(res.writeHeadCalls.length, 0, 'writeHead never fired on the 500 seam');
    assert.equal(res.writeHeadCalls.some((c) => c.status === 200), false);
    assert.equal(res.endCalls.length, 0, 'res.end never fired on the 500 seam');
    assert.equal(res.writableEnded, false);
  });

  it('STREAMS a 200 (NOT a 500) when the loader swallows an fs failure to {}', async () => {
    const fs = swallowingFs();
    const { replies, res } = await runExportJson({ fs, path: nodePath });

    // Contrast case: the swallowed fs error never reaches the catch, so json() (and
    // thus the 500) is never invoked.
    assert.equal(replies.length, 0, 'no json() reply: the swallow path is a 200, not a 500');
    assert.equal(replies.some((r) => r.status === 500), false);

    // The handler streamed a 200 with the export headers and the serialized empty
    // bibliography. JSON.stringify({}, null, 2) is '{}', confirming loadReferencesCached
    // swallowed both fs throws to {}.
    assert.equal(res.writeHeadCalls.length, 1, 'writeHead fired exactly once');
    assert.equal(res.writeHeadCalls[0].status, 200);
    assert.deepStrictEqual(res.writeHeadCalls[0].headers, STREAM_200_HEADERS);
    assert.equal(res.endCalls.length, 1, 'res.end fired exactly once');
    assert.equal(res.endCalls[0], JSON.stringify({}, null, 2));
    assert.equal(res.writableEnded, true);

    // The loader ran fresh: it attempted the best-effort stat (which threw, so the
    // cache was bypassed) and then read the file (which also threw, so it returned {}).
    assert.equal(fs.statCalls, 1, 'the loader attempted its best-effort stat');
    assert.equal(fs.readFileCalls, 1, 'the loader read the file fresh after the stat threw');
  });
});
