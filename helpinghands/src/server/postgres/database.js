const {Kysely, PostgresDialect} = require('kysely');
const {createPool, migrate, grantRuntimeAccess, assertRuntimeRoleIsNotOwner} = require('./client');

const enabled = Boolean(process.env.DATABASE_URL);
const pool = enabled ? createPool(process.env) : null;
// The server migrates its database as the schema owner and serves it as the
// runtime role: production's on Railway, the local one under npm start
// (scripts/db/local.mjs).
const migrationPool = enabled && process.env.DATABASE_MIGRATION_URL
  ? createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 2})
  : null;
const kysely = pool ? new Kysely({dialect: new PostgresDialect({pool})}) : null;
const productionMissingMigrationRole = enabled
  && process.env.NODE_ENV === 'production'
  && !process.env.DATABASE_MIGRATION_URL;
const ready = pool && !productionMissingMigrationRole ? (async () => {
  if (!migrationPool) throw new Error('DATABASE_MIGRATION_URL is required beside DATABASE_URL: the server migrates its database');
  const applied = await migrate(migrationPool);
  await grantRuntimeAccess(migrationPool, pool);
  await assertRuntimeRoleIsNotOwner(pool);
  return applied;
})() : Promise.resolve([]);

async function close() {
  if (kysely) await kysely.destroy();
  if (migrationPool) await migrationPool.end();
}

module.exports = {enabled, pool, migrationPool, kysely, ready, close};
