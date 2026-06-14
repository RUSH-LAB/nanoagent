import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling characterization suites do. The GET enrich handler is already driven by
// tests/next-references-enrich-get-guards.test.mjs (its pre-curl 400/404/400 guard
// rungs), and the loader-throw seam used here is the one already pinned for sibling
// routes by tests/next-references-search-500.test.mjs and
// tests/next-references-format-500.test.mjs. This suite pins the GET
// /api/references/enrich OUTER CATCH (references.js:611 through :612), which returns
// json(res, 500, {error: 'Enrichment failed. Please try again later.'}).
//
// Route shape, read verbatim from references.js:517 through :614:
//   :518  const citationKey = url.searchParams.get('key')
//   :519  if (!citationKey) return json(res, 400, {error: 'Missing key param'})   PRE-TRY guard
//   :521  try {
//   :522    const refs = loadReferencesCached(fs, path, PROJECT_ROOT)             first try statement
//   :523    const entry = refs[citationKey]
//   :524    if (!entry) return json(res, 404, {error: `Reference "${citationKey}" not found`})
//   :526    const title = entry.title
//   :527    if (!title) return json(res, 400, {error: 'Reference has no title to search for'})
//   :544 through :546  curlJSON(...) network calls (Semantic Scholar, Crossref, DBLP)
//   :605    return json(res, 200, {key, current, sources, merged})               success projection
//   :611  } catch (err) {
//   :612    return json(res, 500, {error: 'Enrichment failed. Please try again later.'})
//
// The seam: loadReferencesCached (references.js:33) runs
// path.join(projectRoot, 'bibliography', 'references.yaml') (references.js:34) as the
// one statement OUTSIDE its internal try/catch, so a path stub whose join() throws
// makes the loader throw at its very first op, ahead of any fs access. That throw
// escapes the loader straight into the handler's outer catch. Because it lands at
// references.js:522 it precedes the entry lookup (:523), the not-found 404 (:524), the
// no-title 400 (:527), and every curl network call (:544 through :546), so this is
// faithfully the "bibliography load throws before any network call" path.
// loadReferencesCached's statSync and yaml.load are each try/caught (a YAML error is
// swallowed to {}), so ONLY a throw at the un-guarded path.join 500s here, which is
// why the fs stub below is never reached. This is the same loader error propagation
// already pinned by next-references-search-500 and next-references-format-500.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, payload} shape
// recorded by the json() stub below (matching the enrich-guards sibling).
const GOLDEN_500 = {
  status: 500,
  payload: { error: 'Enrichment failed. Please try again later.' },
};

// Seam: LOADER-LEVEL throw. path.join throws on its only pre-try op inside
// loadReferencesCached, so the loader throws ahead of any fs access. joinCalls records
// that the throwing join is what fired.
function throwingJoinPath() {
  let joinCalls = 0;
  return {
    get joinCalls() { return joinCalls; },
    join() { joinCalls++; throw new Error('path.join boom'); },
  };
}

// A recording fs whose statSync / readFileSync throw if ever reached. Paired with the
// throwing-join path it proves the loader never reached any fs access (both counters
// stay 0) because path.join threw first.
function untouchedFs() {
  let statCalls = 0;
  let readCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readCalls() { return readCalls; },
    statSync() { statCalls++; throw new Error('statSync must stay unreached: path.join throws first'); },
    readFileSync() { readCalls++; throw new Error('readFileSync must stay unreached: path.join throws first'); },
  };
}

// A recording curl stand-in. The loader throw at references.js:522 precedes the
// curlJSON definition and its three network calls, so this must never run; it both
// counts calls and throws, so even a regression that reached it could not spawn a real
// curl subprocess.
function untouchedExec() {
  let calls = 0;
  const fn = () => { calls++; throw new Error('execFileSync (curl) must stay unreached before the network'); };
  fn.calls = () => calls;
  return fn;
}

// Drive the real GET /api/references/enrich handler over a mocked ctx. Only the ctx
// fields this route reads on the failing path are supplied: json (the reply sink), fs
// and path (the loader seams), PROJECT_ROOT, and execFileSync (the curl stand-in
// proved unreached). Every json(res, status, payload) write is captured in `replies`,
// and the stub sets res.writableEnded to mirror the dispatcher's send detection. The
// routes() promise is returned un-awaited as `invocation` so the caller can prove with
// assert.doesNotReject that the handler CATCHES the loader throw rather than rejecting.
function runEnrich({ fs, path, key = 'doe2021' }) {
  const replies = [];
  const res = { writableEnded: false };
  const exec = untouchedExec();
  const ctx = {
    json(_res, status, payload) { const r = { status, payload }; replies.push(r); res.writableEnded = true; return r; },
    fs,
    path,
    PROJECT_ROOT,
    execFileSync: exec,
  };
  const pathname = '/api/references/enrich';
  const url = new URL(`http://localhost${pathname}?key=${encodeURIComponent(key)}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const invocation = routes(req, res, url, pathname, ctx);
  return { invocation, replies, exec };
}

// The shared memo lives at references.js module scope; start every case clean. The
// seam never populates it (path.join throws before statSync), so this only guards
// against a memo left by another suite in a shared process.
beforeEach(() => _resetReferencesCache());

describe('GET /api/references/enrich outer catch returns 500 Enrichment failed', () => {
  it('maps a loader-level throw (path.join throws before any network call) into the lone 500 reply', async () => {
    const fs = untouchedFs();
    const path = throwingJoinPath();
    const { invocation, replies, exec } = runEnrich({ fs, path });

    // The handler CATCHES the loader throw rather than rejecting: awaiting the
    // returned promise does not reject.
    await assert.doesNotReject(invocation, 'the handler catches the loader throw instead of rejecting');

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Enrichment failed. Please try again later.'} payload shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throwing join is what fired, and it fired before any fs access: the loader
    // throws at references.js:34, ahead of statSync / readFileSync.
    assert.ok(path.joinCalls > 0, 'loadReferencesCached called the throwing path.join');
    assert.equal(fs.statCalls, 0, 'no statSync: path.join threw first');
    assert.equal(fs.readCalls, 0, 'no readFileSync: path.join threw first');

    // Never-reached proof, anchored against a vacuous pass by the length check above.
    // The throw at references.js:522 precedes the entry lookup (:523), the not-found
    // 404 (:524), the no-title 400 (:527), and the success projection (:605), and curl
    // never runs.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.status === 404), false);
    assert.equal(replies.some((r) => r.status === 400), false);
    assert.equal(exec.calls(), 0, 'execFileSync (curl) never ran: the loader threw before the network');
  });

  it('emits a byte-identical lone 500 on a second independent invocation (the golden is deterministic)', async () => {
    const a = runEnrich({ fs: untouchedFs(), path: throwingJoinPath() });
    const b = runEnrich({ fs: untouchedFs(), path: throwingJoinPath() });

    await assert.doesNotReject(a.invocation);
    await assert.doesNotReject(b.invocation);

    assert.equal(a.replies.length, 1);
    assert.equal(b.replies.length, 1);
    assert.deepStrictEqual(a.replies[0], GOLDEN_500);
    // The two independent runs converge on the same lone reply.
    assert.deepStrictEqual(b.replies, a.replies);
  });
});
