import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the REAL route module the way the sibling
// route suites do (next-trashname-re-hoist, next-folder-crud-guards) rather than
// reimplementing the handler. This add-only suite characterizes the CURRENT
// behavior of DELETE /api/trash/empty so a future refactor cannot silently change
// it. The handler reads TRASH_DIR, fs, path, rateLimit, and json from ctx, so each
// case drives it over a mocked ctx: real fs/path over a temporary .trash/ directory
// for the success paths, and a call-counting fs stub for the guard, no-op, and
// error paths where the mutating calls are proven to fire (or not). Network free.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// Temp roots created during the run, removed in after().
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

// Create a fresh temp root and return its path.
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-empty-'));
  roots.push(root);
  return root;
}

// Write each [relUnderTrash, body] entry under root/.trash/ (relUnderTrash may
// include subdirectories) and return the .trash path.
function seedTrash(root, files) {
  const trashDir = path.join(root, '.trash');
  for (const [rel, body] of files) {
    const full = path.join(trashDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
  return trashDir;
}

// A call-counting fs stub covering only the methods this handler touches:
// existsSync (the absent-dir guard), readdirSync (the recursive file walk, fed
// {withFileTypes:true} entries), and rmSync (the destructive empty). rmSync can be
// told to throw so the catch branch is reached. Each method tallies its calls so a
// test can prove a guard path performed no filesystem work and an error path still
// attempted the delete.
function makeCountingFs({ exists = false, entries = [], rmThrows = false } = {}) {
  const calls = { existsSync: 0, readdirSync: 0, rmSync: 0 };
  const fsStub = {
    existsSync() { calls.existsSync++; return exists; },
    readdirSync() { calls.readdirSync++; return entries; },
    rmSync() { calls.rmSync++; if (rmThrows) throw new Error('rmSync failed'); },
  };
  return { fs: fsStub, calls };
}

// A {withFileTypes:true} directory entry that is a plain file (never a directory),
// so countFiles tallies it without recursing.
function fileEntry(name) {
  return { name, isDirectory: () => false };
}

// Drive the real DELETE /api/trash/empty handler over a mocked ctx; capture json().
// rateLimit defaults to allowing the request; pass a recorder to assert the key and
// limit, or a false-returning stub to exercise the 429 gate. path is always the real
// module so countFiles joins subdirectories exactly as production does.
async function emptyTrash({ fs: fsArg, TRASH_DIR, rateLimit = () => true }) {
  let captured = null;
  const res = { writableEnded: false };
  const ctx = {
    fs: fsArg,
    path,
    TRASH_DIR,
    rateLimit,
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
  };
  const url = new URL('http://localhost/api/trash/empty');
  const req = { method: 'DELETE', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/trash/empty', ctx);
  return captured;
}

describe('DELETE /api/trash/empty — guard, no-op, and error paths (counting fs stub)', () => {
  it('returns 429 and performs no filesystem work when rate limited', async () => {
    const { fs: fsStub, calls } = makeCountingFs({ exists: true, entries: [fileEntry('a.md')] });
    let rlArgs = null;
    const rateLimit = (key, limit) => { rlArgs = { key, limit }; return false; };
    const captured = await emptyTrash({ fs: fsStub, TRASH_DIR: '/fake/root/.trash', rateLimit });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    // The gate runs before the try, so nothing on disk is read or removed.
    assert.equal(calls.existsSync, 0, 'a rate-limited request never probes the trash dir');
    assert.equal(calls.readdirSync, 0, 'a rate-limited request never walks the trash dir');
    assert.equal(calls.rmSync, 0, 'a rate-limited request never removes the trash dir');
    // The rate-limit key is scoped to trash-empty plus the caller address, limit 2.
    assert.deepEqual(rlArgs, { key: 'trash-empty:127.0.0.1', limit: 2 });
  });

  it('returns 200 {success:true, deleted:0} and never calls rmSync when TRASH_DIR is absent', async () => {
    const { fs: fsStub, calls } = makeCountingFs({ exists: false });
    const captured = await emptyTrash({ fs: fsStub, TRASH_DIR: '/fake/root/.trash' });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, deleted: 0 });
    // The guard probes the dir exactly once, then returns before any walk or remove
    // (the symmetric counterpart to the 429 case, where existsSync stays at zero).
    assert.equal(calls.existsSync, 1, 'the absent-dir guard probes the trash dir exactly once');
    assert.equal(calls.readdirSync, 0, 'an absent trash dir is never walked');
    assert.equal(calls.rmSync, 0, 'an absent trash dir is never removed');
  });

  it('returns 500 {error:"Failed to empty trash"} when rmSync throws', async () => {
    const { fs: fsStub, calls } = makeCountingFs({
      exists: true,
      entries: [fileEntry('a.md'), fileEntry('b.md')],
      rmThrows: true,
    });
    const captured = await emptyTrash({ fs: fsStub, TRASH_DIR: '/fake/root/.trash' });
    assert.equal(captured.status, 500);
    assert.deepEqual(captured.body, { error: 'Failed to empty trash' });
    assert.equal(calls.rmSync, 1, 'the destructive remove was attempted exactly once');
  });
});

describe('DELETE /api/trash/empty — real .trash directory', () => {
  it('removes a flat trash dir and reports the exact file count', async () => {
    const root = makeRoot();
    const TRASH_DIR = seedTrash(root, [
      ['note-1.md', 'one'],
      ['note-2.mdx', 'two'],
      ['note-3.md', 'three'],
    ]);
    assert.ok(fs.existsSync(TRASH_DIR), 'trash dir exists before empty');
    const captured = await emptyTrash({ fs, TRASH_DIR });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, deleted: 3 });
    assert.equal(fs.existsSync(TRASH_DIR), false, 'the trash dir is gone afterward');
  });

  it('counts files nested across subdirectories recursively without counting the directories', async () => {
    const root = makeRoot();
    // Files at three different depths; the sub and sub/deep directories are walked
    // but must not add to the count.
    const TRASH_DIR = seedTrash(root, [
      ['top.md', 'depth 0'],
      [path.join('sub', 'middle.md'), 'depth 1'],
      [path.join('sub', 'deep', 'bottom.md'), 'depth 2'],
    ]);
    const captured = await emptyTrash({ fs, TRASH_DIR });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, deleted: 3 });
    assert.equal(fs.existsSync(TRASH_DIR), false, 'the whole tree is removed');
  });

  it('returns 200 {success:true, deleted:0} for an existing but empty trash dir and removes it', async () => {
    const root = makeRoot();
    const TRASH_DIR = path.join(root, '.trash');
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const captured = await emptyTrash({ fs, TRASH_DIR });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, deleted: 0 });
    assert.equal(fs.existsSync(TRASH_DIR), false, 'the empty trash dir is removed');
  });

  it('returns 200 {success:true, deleted:0} when the real root has no .trash dir', async () => {
    const root = makeRoot();
    const TRASH_DIR = path.join(root, '.trash'); // never created
    const captured = await emptyTrash({ fs, TRASH_DIR });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, deleted: 0 });
  });
});
