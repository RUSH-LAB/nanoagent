#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {createPool} = require('../../src/server/postgres/client.js');
const {postgresObjectStorage} = require('../../src/server/object-storage.js');

const apply = process.argv.includes('--apply');
const root = path.resolve(process.env.OBJECTS_ROOT || 'var/objects');

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

export async function migrateLocalObjects({pool, storage, objectRoot = root, write = apply}) {
  const assets = (await pool.query(
    `select object_key as "objectKey", content_type as "contentType",
            byte_size as "byteSize", sha256
       from asset order by object_key`,
  )).rows;
  const report = {expected: assets.length, verified: 0, copied: 0, missing: [], mismatched: []};

  for (const asset of assets) {
    const absolute = path.resolve(objectRoot, ...String(asset.objectKey).split('/'));
    if (absolute !== objectRoot && !absolute.startsWith(`${objectRoot}${path.sep}`)) {
      throw new Error(`Unsafe object key: ${asset.objectKey}`);
    }
    if (!fs.existsSync(absolute)) {
      report.missing.push(asset.objectKey);
      continue;
    }
    const body = fs.readFileSync(absolute);
    const actualHash = digest(body);
    if (body.length !== Number(asset.byteSize) || actualHash !== asset.sha256) {
      report.mismatched.push(asset.objectKey);
      continue;
    }
    report.verified++;
    if (write) {
      await storage.put(asset.objectKey, body, asset.contentType);
      report.copied++;
    }
  }

  if (report.missing.length || report.mismatched.length) {
    throw new Error(`Object migration validation failed: ${report.missing.length} missing, ${report.mismatched.length} mismatched`);
  }
  return report;
}

export async function main(env = process.env) {
  if (!env.DATABASE_MIGRATION_URL) throw new Error('DATABASE_MIGRATION_URL is required');
  if (!fs.existsSync(root)) throw new Error(`Object source does not exist: ${root}`);
  const pool = createPool({...env, DATABASE_URL: env.DATABASE_MIGRATION_URL}, {max: 1});
  try {
    const report = await migrateLocalObjects({
      pool,
      storage: postgresObjectStorage({pool}),
      objectRoot: root,
      write: apply,
    });
    console.log(JSON.stringify({mode: apply ? 'apply' : 'dry-run', source: root, ...report}, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Object migration failed: ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}
