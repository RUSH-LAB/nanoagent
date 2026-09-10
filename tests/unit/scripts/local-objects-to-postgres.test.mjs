import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {migrateLocalObjects} from '../../../scripts/migrations/local-objects-to-postgres.mjs';

const digest = body => crypto.createHash('sha256').update(body).digest('hex');

describe('local object migration', () => {
  it('copies only database-known objects after verifying their size and hash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-objects-'));
    const body = Buffer.from('%PDF-test');
    const objectKey = 'workspace/assets/id/file.pdf';
    const file = path.join(root, ...objectKey.split('/'));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, body);
    const copied = [];
    try {
      const report = await migrateLocalObjects({
        pool: {query: async () => ({rows: [{objectKey, contentType: 'application/pdf', byteSize: body.length, sha256: digest(body)}]})},
        storage: {put: async (...args) => copied.push(args)},
        objectRoot: root,
        write: true,
      });
      assert.deepEqual(report, {expected: 1, verified: 1, copied: 1, missing: [], mismatched: []});
      assert.equal(copied[0][0], objectKey);
      assert.equal(copied[0][1].toString(), '%PDF-test');
      assert.equal(copied[0][2], 'application/pdf');
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('refuses missing or changed bytes instead of silently producing broken metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-objects-'));
    try {
      await assert.rejects(() => migrateLocalObjects({
        pool: {query: async () => ({rows: [{
          objectKey: 'workspace/assets/missing.pdf', contentType: 'application/pdf',
          byteSize: 10, sha256: '0'.repeat(64),
        }]})},
        storage: {put: async () => assert.fail('must not write')},
        objectRoot: root,
        write: true,
      }), /1 missing, 0 mismatched/);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });
});
