const {Kysely, PostgresDialect} = require('kysely');
const {createPool, migrate, grantRuntimeAccess, assertRuntimeRoleIsNotOwner} = require('./client');

const enabled = Boolean(process.env.DATABASE_URL);
const pool = enabled ? createPool(process.env) : null;
const migrationPool = enabled && process.env.DATABASE_MIGRATION_URL
  ? createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 2})
  : pool;
const kysely = pool ? new Kysely({dialect: new PostgresDialect({pool})}) : null;
const productionMissingMigrationRole = enabled
  && process.env.NODE_ENV === 'production'
  && !process.env.DATABASE_MIGRATION_URL;
const ready = pool && !productionMissingMigrationRole ? (async () => {
  const applied = await migrate(migrationPool);
  if (migrationPool !== pool) {
    await grantRuntimeAccess(migrationPool, pool);
    await assertRuntimeRoleIsNotOwner(pool);
  }
  return applied;
})() : Promise.resolve([]);

async function close() {
  if (kysely) await kysely.destroy();
  if (migrationPool && migrationPool !== pool) await migrationPool.end();
}

module.exports = {enabled, pool, migrationPool, kysely, ready, close};
