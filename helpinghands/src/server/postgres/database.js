const {Kysely, PostgresDialect} = require('kysely');
const {createPool, migrate, assertSchemaCurrent, grantRuntimeAccess, assertRuntimeRoleIsNotOwner} = require('./client');

const enabled = Boolean(process.env.DATABASE_URL);
const pool = enabled ? createPool(process.env) : null;
// Only production's server holds the schema owner's URL and migrates. The
// local server shares production's database with the runtime role, and
// refuses to start unless production has applied exactly its migrations.
const migrationPool = enabled && process.env.DATABASE_MIGRATION_URL
  ? createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 2})
  : null;
const kysely = pool ? new Kysely({dialect: new PostgresDialect({pool})}) : null;
const productionMissingMigrationRole = enabled
  && process.env.NODE_ENV === 'production'
  && !process.env.DATABASE_MIGRATION_URL;
const ready = pool && !productionMissingMigrationRole ? (async () => {
  if (!migrationPool) {
    await assertSchemaCurrent(pool);
    return [];
  }
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
