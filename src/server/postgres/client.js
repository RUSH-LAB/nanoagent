const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {Pool: PgPool} = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK = 786234901;

function createPool(env = process.env, options = {}) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL');
  const pool = new PgPool({
    connectionString: env.DATABASE_URL,
    max: Number(env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(env.PG_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(env.PG_CONNECT_TIMEOUT_MS || 10_000),
    ssl: env.PG_SSL === 'disable' ? false
      : env.PG_SSL === 'require' || env.NODE_ENV === 'production'
        ? {rejectUnauthorized: env.PG_SSL_REJECT_UNAUTHORIZED !== 'false'}
        : undefined,
    ...options,
  });
  pool.on('error', error => console.error('[postgres] Idle connection failed:', error.message));
  return pool;
}

function migrationFiles(directory = MIGRATIONS_DIR) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function migrate(pool, {directory = MIGRATIONS_DIR} = {}) {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`create table if not exists schema_migration (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const applied = new Map((await client.query('select name, checksum from schema_migration')).rows
      .map(row => [row.name, row.checksum]));
    const completed = [];
    for (const name of migrationFiles(directory)) {
      const sql = fs.readFileSync(path.join(directory, name), 'utf8');
      const digest = checksum(sql);
      if (applied.has(name)) {
        if (applied.get(name) !== digest) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migration(name, checksum) values ($1, $2)', [name, digest]);
        await client.query('commit');
        completed.push(name);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    return completed;
  } finally {
    try { await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]); } finally { client.release(); }
  }
}

async function withRequestContext(pool, context, operation) {
  if (!context?.userId) throw new Error('A verified user context is required');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [String(context.userId)]);
    await client.query("select set_config('app.workspace_id', $1, true)", [String(context.workspaceId ?? '')]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function quoteIdentifier(value) {
  const name = String(value ?? '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid PostgreSQL role name: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}

async function grantRuntimeAccess(migrationPool, runtimePool) {
  const runtimeRole = (await runtimePool.query('select current_user as role')).rows[0].role;
  const quoted = quoteIdentifier(runtimeRole);
  await migrationPool.query(`grant usage on schema public to ${quoted}`);
  await migrationPool.query(`grant select, insert, update, delete on all tables in schema public to ${quoted}`);
  await migrationPool.query(`grant usage, select on all sequences in schema public to ${quoted}`);
  await migrationPool.query(`grant execute on all functions in schema public to ${quoted}`);
  return runtimeRole;
}

async function assertRuntimeRoleIsNotOwner(runtimePool) {
  const result = await runtimePool.query(`select current_user as runtime_role,
    pg_get_userbyid(c.relowner) as owner_role,
    r.rolsuper as runtime_superuser,
    r.rolbypassrls as runtime_bypass_rls
    from pg_class c
    join pg_roles r on r.rolname = current_user
    where c.relname = 'workspace' and c.relkind = 'r'`);
  const row = result.rows[0];
  if (row && (row.runtime_role === row.owner_role || row.runtime_superuser || row.runtime_bypass_rls)) {
    throw new Error('DATABASE_URL must use a non-owner, non-superuser PostgreSQL role without BYPASSRLS');
  }
  return row;
}

module.exports = {
  MIGRATIONS_DIR, createPool, migrate, withRequestContext, checksum, migrationFiles,
  quoteIdentifier, grantRuntimeAccess, assertRuntimeRoleIsNotOwner,
};
