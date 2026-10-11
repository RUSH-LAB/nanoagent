#!/usr/bin/env node
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createPool, quoteIdentifier} = require('../../src/server/postgres/client.js');
import {parseRuntimeTarget} from './bootstrap-runtime-role.mjs';

/**
 * Repair objects accidentally created by the restricted runtime role.
 *
 * This is intentionally idempotent. A correctly provisioned database owns no
 * schema objects through the runtime role, so normal deployments are a no-op.
 */
export async function repairRuntimeOwnership(ownerPool, runtimeConnectionString) {
  const target = parseRuntimeTarget(runtimeConnectionString);
  const owner = (await ownerPool.query(
    'select current_user as role, current_database() as database',
  )).rows[0];
  if (owner.role === target.role) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must use different PostgreSQL roles');
  }
  if (owner.database !== target.database) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must point to the same database');
  }

  const owned = Number((await ownerPool.query(
    `select count(*)::int as count
       from pg_class c
       join pg_roles r on r.oid = c.relowner
      where r.rolname = $1
        and c.relnamespace not in (select oid from pg_namespace where nspname like 'pg_%')`,
    [target.role],
  )).rows[0]?.count || 0);
  if (!owned) return {reassigned: 0, ownerRole: owner.role, runtimeRole: target.role};

  const runtimeRole = quoteIdentifier(target.role);
  const ownerRole = quoteIdentifier(owner.role);
  const alreadyMember = Boolean((await ownerPool.query(
    'select pg_has_role($1, $2, $3) as member', [owner.role, target.role, 'MEMBER'],
  )).rows[0]?.member);

  if (!alreadyMember) await ownerPool.query(`grant ${runtimeRole} to ${ownerRole}`);
  try {
    await ownerPool.query(`reassign owned by ${runtimeRole} to ${ownerRole}`);
  } finally {
    if (!alreadyMember) await ownerPool.query(`revoke ${runtimeRole} from ${ownerRole}`);
  }
  return {reassigned: owned, ownerRole: owner.role, runtimeRole: target.role};
}

export async function main(env = process.env) {
  if (!env.DATABASE_MIGRATION_URL || !env.DATABASE_URL) {
    throw new Error('DATABASE_MIGRATION_URL and DATABASE_URL are required');
  }
  const ownerPool = createPool({...env, DATABASE_URL: env.DATABASE_MIGRATION_URL}, {max: 1});
  try {
    const result = await repairRuntimeOwnership(ownerPool, env.DATABASE_URL);
    console.log(result.reassigned
      ? `Reassigned ${result.reassigned} objects from ${result.runtimeRole} to ${result.ownerRole}.`
      : `Runtime role ${result.runtimeRole} owns no schema objects.`);
  } finally {
    await ownerPool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const detail = error?.message || error?.error?.message || error?.error?.code
      || error?.code || String(error);
    console.error(`PostgreSQL ownership repair failed: ${detail}`);
    process.exitCode = 1;
  });
}
