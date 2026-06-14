import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load the real module via createRequire the way
// the sibling cached-first route suites do (next-byauthor-500, next-byvenue-500),
// so this characterization test drives the genuine GET /api/references/export
// handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH (research-tools.js:808 through :810), which
// returns json(res, 500, {error: 'Export failed: ' + err.message}) — a PREFIX
// golden whose suffix is the thrown message verbatim, so each seam must throw a
// known message and the composed string is asserted exactly. The try opens at
// research-tools.js:765 with no pre-try guard; its first statement is
// loadReferencesCached(fs, path, PROJECT_ROOT) (research-tools.js:769).
//
// Unlike the sibling JSON routes, the SUCCESS path here STREAMS: it builds a
// BibTeX string, then calls res.writeHead(200, ...) (research-tools.js:801) and
// res.end(bibtex) (research-tools.js:807); only the failure path uses json(). So
// the never-reached proof additionally asserts writeHead was never called with 200
// and res.end never fired.
//
// loadReferencesCached (references.js:33) swallows fs and parse errors: its
// fs.statSync is try/caught (null on throw, so the cache is skipped and the file
// is read directly) and its yaml.load(fs.readFileSync(...)) is try/caught ({} on
// any read or parse error). Because a swallowed read leaves refs === {}, the
// handler re-reads raw when Object.keys(refs).length === 0 (research-tools.js:774
// through :777) to keep the original 500-on-broken-bibliography reachable. The two
// seams below are the verified ways the outer catch actually fires.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/research-tools.js');

const PROJECT_ROOT = '/virtual-root';

// The outer catch composes 'Export failed: ' + err.message, so the golden is a
// PREFIX whose suffix is exactly the message thrown on each seam. deepStrictEqual
// pins both the status and the full {error} body shape.
function golden(message) {
  return { status: 500, body: { error: 'Export failed: ' + message } };
}

// Seam (a): LOADER-LEVEL throw. A path whose .join throws makes
// loadReferencesCached throw at references.js:34 (the one op outside its internal
// try/catch), before any fs call and before any streaming. The fs is never
// reached, so its methods assert they stay untouched. Golden suffix:
// 'path.join unavailable'.
function throwingJoinPath() {
  return {
    join() { throw new Error('path.join unavailable'); },
  };
}
function unreachedFs() {
  return {
    statSync() { throw new Error('fs.statSync must stay unreached on seam (a)'); },
    readFileSync() { throw new Error('fs.readFileSync must stay unreached on seam (a)'); },
  };
}

// Seam (b): RE-READ-GUARD throw. Paired with the real node path module so
// path.join succeeds. loadReferencesCached computes the file path, then statSync
// throws (stat stays null, cache skipped) and readFileSync throws 'bibliography
// unreadable', which the loader swallows to {}. refs is therefore empty, so the
// handler's Object.keys(refs).length === 0 guard re-reads raw and the SAME
// readFileSync throws again, this time outside the loader, landing in the outer
// catch. Golden suffix: 'bibliography unreadable'. This pins the deliberate
// re-read-on-empty guard that keeps the 500 reachable.
function unreadableFs() {
  return {
    statSync() { throw new Error('stat unavailable'); },
    readFileSync() { throw new Error('bibliography unreadable'); },
  };
}

// A res that records the streaming success path so the never-reached proof can
// assert it never started. writeHead(code, headers) and end(body) push onto
// `calls`; on success the real handler calls writeHead(200, ...) then end(bibtex).
function makeRes() {
  const calls = { writeHead: [], end: [] };
  return {
    writableEnded: false,
    writeHead(code, headers) { calls.writeHead.push({ code, headers }); return this; },
    end(body) { calls.end.push(body); this.writableEnded = true; return this; },
    calls,
  };
}

// Drive the real GET /api/references/export handler over a mocked ctx. The caller
// supplies the fs and path seams that steer the single try into its catch. Every
// json(res, status, payload) write is captured in `replies`, and the res records
// any writeHead/end so a test can prove the 200 stream never fired. Only the ctx
// fields this branch reads are supplied (json, fs, path, PROJECT_ROOT); the rest
// stay undefined because the failing path never touches them, and the cache is
// bypassed (statSync throws, so no clock dependence).
async function runExport({ fs, path: pathArg }) {
  const replies = [];
  const res = makeRes();
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path: pathArg,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/export';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, res, url, pathname, ctx);
  return { replies, res };
}

describe('GET /api/references/export outer catch returns 500 Export failed: <message>', () => {
  it('maps a loader-level throw (path.join throws) into the prefix 500 reply', async () => {
    const { replies, res } = await runExport({ fs: unreachedFs(), path: throwingJoinPath() });

    // The single reply is the catch's 500; deepStrictEqual pins the status and the
    // exact 'Export failed: path.join unavailable' body.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], golden('path.join unavailable'));

    // Never-reached proof, anchored against a vacuous pass by the length check
    // above: the success stream never started (no writeHead, no res.end), in
    // particular writeHead was never called with 200, and no reply carries a 200.
    assert.equal(res.calls.writeHead.length, 0);
    assert.equal(res.calls.end.length, 0);
    assert.equal(res.calls.writeHead.some((c) => c.code === 200), false);
    assert.equal(replies.some((r) => r.status === 200), false);
  });

  it('maps the re-read-guard throw (empty refs then readFileSync throws) into the SAME-shaped 500 reply', async () => {
    const { replies, res } = await runExport({ fs: unreadableFs(), path });

    // loadReferencesCached swallows the broken read to {}, so the handler re-reads
    // raw and the same readFileSync throw lands in the SAME outer catch as seam (a),
    // here with the suffix 'bibliography unreadable'.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], golden('bibliography unreadable'));

    assert.equal(res.calls.writeHead.length, 0);
    assert.equal(res.calls.end.length, 0);
    assert.equal(res.calls.writeHead.some((c) => c.code === 200), false);
    assert.equal(replies.some((r) => r.status === 200), false);
  });
});
