import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  saveJSON,
  loadJSON,
  _cacheSize,
  _clearCache,
} = require('../server/data-store.js');

let root;

// Mirror the tmp-leftover probe from tests/data-store.test.mjs: list the entries
// that are leftover atomic-write temp files.
const tmpLeftovers = (d) => fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));

// Build an isolated parent directory that holds a directory target. saveJSON
// resolves its temp file into path.dirname(target), so giving each case its own
// parent keeps the .tmp leftover check scoped to that single failing call.
function makeDirTarget(name) {
  const parent = path.join(root, name);
  fs.mkdirSync(parent);
  const target = path.join(parent, 'iam-a-dir');
  fs.mkdirSync(target);
  return { parent, target };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsrename-'));
});

beforeEach(() => {
  _clearCache(); // never let the module cache leak across cases
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// These cases pin the CURRENT, correct behavior of saveJSON when the atomic
// fs.renameSync fails. The failure is provoked with a real filesystem condition
// (no fs mocking): the target is an existing directory, so renameSync(tmp, key)
// throws (EISDIR on this darwin platform). The assertions use a bare
// assert.throws and never inspect err.code, so they hold regardless of the
// platform-specific errno.
describe('saveJSON rename failure', () => {
  it('rethrows the error when the target path is an existing directory', () => {
    const { target } = makeDirTarget('rethrows');
    assert.throws(() => saveJSON(target, { v: 1 }));
  });

  it('removes the temp file so no .tmp leftover remains after the failure', () => {
    const { parent, target } = makeDirTarget('cleanup');
    assert.throws(() => saveJSON(target, { v: 2 }));
    // The catch unlinks the temp file before rethrowing, so the parent that
    // received the temp file holds no .tmp leftover.
    assert.deepEqual(tmpLeftovers(parent), []);
  });

  it('installs no cache entry when the save fails', () => {
    // Prime the cache with an unrelated, valid key; write-through installs it.
    const good = path.join(root, 'good.json');
    saveJSON(good, { ok: true });
    const before = _cacheSize();
    assert.equal(before, 1);

    const { target } = makeDirTarget('nocache');
    assert.throws(() => saveJSON(target, { v: 3 }));

    // The throw happens before the write-through cache block, so the failed save
    // installs nothing: the size is unchanged and the primed key is intact.
    assert.equal(_cacheSize(), before);
    assert.deepEqual(loadJSON(good), { ok: true });
  });
});
