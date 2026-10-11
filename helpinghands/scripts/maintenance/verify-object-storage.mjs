#!/usr/bin/env node
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {createPool} = require('../../src/server/postgres/client.js');
const {postgresObjectStorage} = require('../../src/server/object-storage.js');

const REQUIRED = Object.freeze([
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
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
  const runtimePool = createPool(env, {max: 1});
  const ownerPool = createPool({...env, DATABASE_URL: env.DATABASE_MIGRATION_URL}, {max: 1});
  try {
    const workspace = (await ownerPool.query(
      "select id from workspace where status = 'active' order by created_at, id limit 1",
    )).rows[0];
    if (!workspace) throw new Error('At least one active workspace is required');
    const storage = postgresObjectStorage({pool: runtimePool});
    console.log(JSON.stringify(await verifyObjectStorage(storage, {
      key: `${workspace.id}/_mochi-health/${Date.now()}-${crypto.randomUUID()}.bin`,
    }), null, 2));
  } finally {
    await runtimePool.end();
    await ownerPool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Object-storage verification failed: ${error.message || error}`);
    process.exitCode = 1;
  });
}
