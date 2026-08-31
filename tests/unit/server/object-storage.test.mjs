import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mockFs} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {createObjectStorage, localObjectStorage, s3ObjectStorage} = require('../../../src/server/object-storage.js');

describe('object storage', () => {
  it('uses a local implementation outside production', async () => {
    const files = mockFs();
    const storage = localObjectStorage({root: '/objects', files});
    await storage.put('workspace/assets/file.bin', Buffer.from('hello'));
    assert.equal((await storage.get('workspace/assets/file.bin')).toString(), 'hello');
    assert.equal((await storage.stat('workspace/assets/file.bin')).size, 5);
    assert.equal(await storage.remove('workspace/assets/file.bin'), true);
    assert.equal(await storage.get('workspace/assets/file.bin'), null);
  });

  it('signs S3-compatible requests without exposing credentials in the URL', async () => {
    const calls = [];
    const storage = s3ObjectStorage({
      endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'assets', region: 'auto',
      accessKeyId: 'access', secretAccessKey: 'secret',
      fetchImpl: async (url, init) => {
        calls.push({url: String(url), init});
        return {ok: true, status: 200, arrayBuffer: async () => Buffer.from('saved'), headers: new Headers({'content-length': '5'})};
      },
    });
    await storage.put('workspace id/file.pdf', Buffer.from('pdf'), 'application/pdf');
    assert.match(calls[0].url, /assets\/workspace%20id\/file.pdf$/);
    assert.match(calls[0].init.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(calls[0].url.includes('secret'), false);
  });

  it('requires S3/R2 configuration in production', () => {
    assert.throws(() => createObjectStorage({NODE_ENV: 'production'}), /requires S3\/R2/);
  });
});
