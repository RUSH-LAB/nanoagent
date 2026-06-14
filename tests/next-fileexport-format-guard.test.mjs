import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the sibling route tests do.
//
// This is an add-only characterization suite: it pins the CURRENT error contract of
// the two query-param guards on GET /api/file/export
// (server/routes/graph-trash-files.js) and changes no source. The handler head is:
//
//   const filePath = url.searchParams.get('path');
//   const format = url.searchParams.get('format');
//   if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
//   if (!['md','html','pdf','latex','slides'].includes(format))
//     return json(res, 400, {error: 'Invalid format. Must be md, html, pdf, latex, or slides'});
//   ... fs.readFileSync(...)
//
// Three behaviors are pinned: the exact invalid-format 400 body; the omitted-format
// arm (an absent format key makes url.searchParams.get('format') return null, and
// ['md',...].includes(null) is false, so it reuses the SAME format guard); and the
// path-before-format precedence (the path guard wins when both inputs are bad). Both
// guards run before fs.readFileSync, so a zero-call fs tripwire proves the rejection
// happens with no file read on every branch.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

const FORMAT_ERROR = 'Invalid format. Must be md, html, pdf, latex, or slides';
const PATH_ERROR = 'Invalid path';
const PROJECT_ROOT = '/tmp/fileexport-format-guard-root';

// Drive GET /api/file/export through the real handler with the path/format guards
// under test. Passing `format: undefined` leaves the query key absent, so
// url.searchParams.get('format') returns null (the omitted-format arm). The fs stub's
// readFileSync is a tripwire: it counts calls and throws, so any read reached before
// the guards both bumps the counter and (via the handler's try/catch) changes the
// captured response. The handler only uses json/isValidFilePath/path/PROJECT_ROOT on
// the guard branches, mirroring the minimal ctx the sibling export tests supply.
async function runExport({ filePath, format, isValidFilePath }) {
  const captured = { status: null, body: null };
  let readCount = 0;
  // The guard branches always return through the json() stub below, so writeHead/end
  // are never reached here; they exist only so res mirrors the real response object.
  const res = {
    writableEnded: false,
    writeHead() { this.writableEnded = true; return this; },
    end() { this.writableEnded = true; return this; },
  };
  const fsTripwire = {
    readFileSync() {
      readCount += 1;
      throw new Error('fs.readFileSync reached before the export guards');
    },
  };
  const ctx = {
    fs: fsTripwire,
    path,
    PROJECT_ROOT,
    isValidFilePath,
    json(_res, status, body) { captured.status = status; captured.body = body; res.writableEnded = true; },
  };
  const url = new URL('http://localhost/api/file/export');
  if (filePath !== undefined) url.searchParams.set('path', filePath);
  if (format !== undefined) url.searchParams.set('format', format);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/file/export', ctx);
  return { captured, readCount };
}

describe('GET /api/file/export — query-param guard error contract (characterization)', () => {
  it('returns the exact 400 format-error body for an unknown format, before any read', async () => {
    // Valid path, isValidFilePath true, so the path guard passes and the format
    // guard fires on the unknown 'docx'. The body string is pinned in full.
    const { captured, readCount } = await runExport({
      filePath: 'content/note.md',
      format: 'docx',
      isValidFilePath: () => true,
    });
    assert.deepEqual(captured, { status: 400, body: { error: FORMAT_ERROR } });
    assert.equal(readCount, 0);
  });

  it('hits the same 400 format-error when the format key is omitted (null format)', async () => {
    // No format query key at all: url.searchParams.get('format') is null and
    // ['md','html','pdf','latex','slides'].includes(null) is false, so the omitted
    // format reuses the very same format guard and 400 body.
    const { captured, readCount } = await runExport({
      filePath: 'content/note.md',
      format: undefined,
      isValidFilePath: () => true,
    });
    assert.deepEqual(captured, { status: 400, body: { error: FORMAT_ERROR } });
    assert.equal(readCount, 0);
  });

  it('lets the path guard win over the format guard when both inputs are invalid', async () => {
    // Invalid path AND an unknown format: the path guard runs first, so the response
    // is the Invalid path 400, proving precedence rather than the format 400. The real
    // isValidFilePath is stubbed to false purely to isolate guard order; its own
    // validation logic is characterized elsewhere, not in this guard-contract suite.
    const { captured, readCount } = await runExport({
      filePath: '../etc/passwd',
      format: 'docx',
      isValidFilePath: () => false,
    });
    assert.deepEqual(captured, { status: 400, body: { error: PATH_ERROR } });
    assert.equal(readCount, 0);
  });
});
