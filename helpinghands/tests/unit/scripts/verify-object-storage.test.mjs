import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {verifyObjectStorage} from '../../../scripts/maintenance/verify-object-storage.mjs';

describe('object-storage verification', () => {
  it('checks upload, metadata, download, and deletion', async () => {
    const objects = new Map();
    const calls = [];
    const storage = {
      provider: 'test-s3',
      async put(key, body) { calls.push('put'); objects.set(key, Buffer.from(body)); },
      async stat(key) { calls.push('stat'); return objects.has(key) ? {size: objects.get(key).length} : null; },
      async get(key) { calls.push('get'); return objects.get(key) ?? null; },
      async remove(key) { calls.push('remove'); return objects.delete(key); },
    };
    const result = await verifyObjectStorage(storage, {key: '_mochi-health/test.bin', payload: Buffer.from('probe')});
    assert.deepEqual(result, {ok: true, provider: 'test-s3', bytes: 5});
    assert.deepEqual(calls, ['put', 'stat', 'get', 'remove', 'get']);
    assert.equal(objects.size, 0);
  });

  it('cleans up an uploaded probe when verification fails', async () => {
    const removed = [];
    const storage = {
      provider: 'test-s3',
      async put() {},
      async stat() { return {size: 999}; },
      async get() { return null; },
      async remove(key) { removed.push(key); return true; },
    };
    await assert.rejects(
      verifyObjectStorage(storage, {key: '_mochi-health/failure.bin', payload: Buffer.from('probe')}),
      /metadata mismatch/,
    );
    assert.deepEqual(removed, ['_mochi-health/failure.bin']);
  });
});
