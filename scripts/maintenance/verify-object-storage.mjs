#!/usr/bin/env node
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {s3ObjectStorage} = require('../../src/server/object-storage.js');

const REQUIRED = Object.freeze([
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
]);

export async function verifyObjectStorage(storage, {
  key = `_mochi-health/${Date.now()}-${crypto.randomUUID()}.bin`,
  payload = crypto.randomBytes(64),
} = {}) {
  let uploaded = false;
  try {
    await storage.put(key, payload, 'application/octet-stream');
    uploaded = true;
    const metadata = await storage.stat(key);
    if (!metadata || metadata.size !== payload.length) {
      throw new Error(`Object metadata mismatch: expected ${payload.length} bytes, received ${metadata?.size ?? 'missing'}`);
    }
    const downloaded = await storage.get(key);
    if (!downloaded || downloaded.length !== payload.length || !crypto.timingSafeEqual(payload, downloaded)) {
      throw new Error('Downloaded object does not match the uploaded bytes');
    }
    if (!await storage.remove(key)) throw new Error('Object deletion failed');
    uploaded = false;
    if (await storage.get(key) !== null) throw new Error('Deleted object is still readable');
    return {ok: true, provider: storage.provider, bytes: payload.length};
  } finally {
    if (uploaded) await storage.remove(key).catch(() => {});
  }
}

export async function main(env = process.env) {
  const missing = REQUIRED.filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing object-storage configuration: ${missing.join(', ')}`);
  const storage = s3ObjectStorage({
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    bucket: env.OBJECT_STORAGE_BUCKET,
    region: env.OBJECT_STORAGE_REGION || 'auto',
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  });
  console.log(JSON.stringify(await verifyObjectStorage(storage), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Object-storage verification failed: ${error.message || error}`);
    process.exitCode = 1;
  });
}
