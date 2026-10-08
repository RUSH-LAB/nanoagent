#!/usr/bin/env node
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {
  createPool, migrate, grantRuntimeAccess, assertRuntimeRoleIsNotOwner,
} = require('../../src/server/postgres/client.js');

const migrationPool = createPool(process.env.DATABASE_MIGRATION_URL
  ? {...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}
  : process.env);
const runtimePool = process.env.DATABASE_MIGRATION_URL && process.env.DATABASE_URL
  ? createPool(process.env, {max: 1})
  : null;
try {
  const applied = await migrate(migrationPool);
  if (runtimePool) {
    await grantRuntimeAccess(migrationPool, runtimePool);
    await assertRuntimeRoleIsNotOwner(runtimePool);
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('Production migrations require DATABASE_URL and DATABASE_MIGRATION_URL');
  }
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'PostgreSQL schema is current.');
} finally {
  if (runtimePool) await runtimePool.end();
  await migrationPool.end();
}
