#!/usr/bin/env node
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {createPool} = require('../../src/server/postgres/client.js');

export function parseRuntimeTarget(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme');
  }
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!role || !password || !database) {
    throw new Error('DATABASE_URL must include a runtime role, password, and database name');
  }
  return {role, password, database};
}

async function formatted(pool, template, values) {
  return (await pool.query(
    `select format($1::text, ${values.map((_, index) => `$${index + 2}::text`).join(', ')}) as sql`,
    [template, ...values],
  )).rows[0].sql;
}

/** Create or repair the non-owner login described by DATABASE_URL. */
export async function bootstrapRuntimeRole(ownerPool, runtimeConnectionString) {
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

  const exists = (await ownerPool.query(
    'select 1 from pg_roles where rolname = $1', [target.role],
  )).rowCount > 0;
  if (!exists) {
    await ownerPool.query(await formatted(ownerPool, 'create role %I', [target.role]));
  }
  await ownerPool.query(await formatted(
    ownerPool,
    // PostgreSQL only permits a true superuser to change several privileged
    // attributes, even when setting them to false. Neon project owners are
    // intentionally not raw superusers, and a newly created role already has
    // those flags disabled. Set only the attributes the owner may manage, then
    // verify every security-sensitive flag below.
    'alter role %I login password %L noinherit',
    [target.role, target.password],
  ));
  await ownerPool.query(await formatted(
    ownerPool, 'grant connect on database %I to %I', [target.database, target.role],
  ));

  const role = (await ownerPool.query(
    `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
       from pg_roles where rolname = $1`, [target.role],
  )).rows[0];
  if (!role?.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole
      || role.rolinherit || role.rolreplication || role.rolbypassrls) {
    throw new Error(`Runtime role ${target.role} does not satisfy the required restricted role policy`);
  }
  return {ownerRole: owner.role, runtimeRole: target.role, database: target.database, created: !exists};
}

export async function main(env = process.env) {
  if (!env.DATABASE_MIGRATION_URL || !env.DATABASE_URL) {
    throw new Error('DATABASE_MIGRATION_URL and DATABASE_URL are required');
  }
  const ownerPool = createPool({...env, DATABASE_URL: env.DATABASE_MIGRATION_URL}, {max: 1});
  try {
    const result = await bootstrapRuntimeRole(ownerPool, env.DATABASE_URL);
    console.log(`${result.created ? 'Created' : 'Updated'} restricted role ${result.runtimeRole} in ${result.database} (owner: ${result.ownerRole}).`);
  } finally {
    await ownerPool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const detail = error?.message || error?.error?.message || error?.error?.code
      || error?.code || String(error);
    console.error(`PostgreSQL role bootstrap failed: ${detail}`);
    process.exitCode = 1;
  });
}
