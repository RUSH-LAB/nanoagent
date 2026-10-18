/**
 * Moving data between production and the local database (local.mjs), each
 * only when asked.
 *
 * `pull` replaces the whole local database with a copy of production's, less
 * RUSH Lab's desktop bundles and every sign-in secret, and records a
 * fingerprint of each workspace as it was.
 *
 * `push` replaces one workspace on production with the local one: the
 * `workspace` row and every row of every table with a `workspace_id`. It
 * refuses unless production's copy of that workspace is still exactly what was
 * pulled (or, for a workspace made locally, production has none), both
 * databases have applied the same migrations, and every account the workspace
 * names already exists on production. Nothing else on production changes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {LOCAL_DIR, LOCAL_OWNER_URL, recreateLocalDatabase, runPg, startLocal} from './local.mjs';

const {Client, escapeIdentifier: id, escapeLiteral} = pg;

// Every row's text depends on these, and a fingerprint must read alike on both databases.
const SESSION = `set timezone = 'UTC'; set datestyle = 'ISO, MDY'; set intervalstyle = 'postgres';
  set extra_float_digits = 1; set bytea_output = 'hex'`;
// A batch of rows copied in one statement: few, as a file's content can be large.
const BATCH = 50;

export async function connect(connectionString) {
  const client = new Client({connectionString});
  await client.connect();
  await client.query(SESSION);
  return client;
}

/**
 * The workspace's tables, parents first: `workspace` and every table with a
 * `workspace_id`, each with the column a row is matched on, the columns a copy
 * writes (not generated, not drawn from a sequence), the sequence column a
 * copy is ordered by, and its references to accounts.
 */
export async function workspaceTables(client) {
  const {rows} = await client.query(`
    select c.oid, c.relname::text as name,
           array_agg(a.attname::text order by a.attnum) filter (
             where a.attgenerated = '' and a.attidentity = ''
               and coalesce(pg_get_expr(d.adbin, d.adrelid), '') not like 'nextval(%') as columns,
           min(a.attname::text) filter (
             where a.attidentity <> '' or pg_get_expr(d.adbin, d.adrelid) like 'nextval(%') as serial
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
     where c.relkind = 'r'
       and (c.relname = 'workspace' or exists (select 1 from pg_attribute w
             where w.attrelid = c.oid and w.attname = 'workspace_id' and not w.attisdropped))
     group by c.oid, c.relname`);
  const byOid = new Map(rows.map(row => [row.oid, {
    name: row.name, key: row.name === 'workspace' ? 'id' : 'workspace_id',
    columns: row.columns, serial: row.serial, parents: new Set(), users: [],
  }]));
  const references = (await client.query(`
    select conrelid as child, confrelid as parent, confrelid = 'public.app_user'::regclass as to_user,
           (select array_agg(a.attname::text order by k.n) from unnest(conkey) with ordinality k(attnum, n)
              join pg_attribute a on a.attrelid = conrelid and a.attnum = k.attnum) as columns
      from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`)).rows;
  for (const reference of references) {
    const child = byOid.get(reference.child);
    if (!child) continue;
    if (reference.to_user) child.users.push(reference.columns[0]);
    else if (byOid.has(reference.parent) && reference.parent !== reference.child) child.parents.add(reference.parent);
  }
  const ordered = [];
  const placed = new Set();
  while (placed.size < byOid.size) {
    const ready = [...byOid].filter(([oid, table]) => !placed.has(oid) && [...table.parents].every(parent => placed.has(parent)));
    if (!ready.length) throw new Error('The workspace tables reference each other in a cycle');
    ready.sort(([, a], [, b]) => a.name.localeCompare(b.name));
    for (const [oid, table] of ready) {
      placed.add(oid);
      ordered.push(table);
    }
  }
  return ordered;
}

/** A digest of every row the workspace `workspaceId` has, the same on any database of this schema. */
export async function fingerprint(client, tables, workspaceId) {
  const parts = [];
  for (const table of tables) {
    const {rows: [{digest}]} = await client.query(
      `select coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as digest
         from public.${id(table.name)} x where x.${id(table.key)} = $1`, [workspaceId]);
    parts.push(`${table.name}:${digest}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

async function migrations(client) {
  return (await client.query('select name, checksum from schema_migration order by name')).rows
    .map(row => `${row.name}:${row.checksum}`);
}

/** Pull: production's data, in place of the local database's. */
export async function pull({ownerUrl}) {
  startLocal();
  const source = new URL(ownerUrl);
  const password = decodeURIComponent(source.password);
  source.password = '';
  const dump = path.join(LOCAL_DIR, 'pull.dump');
  try {
    runPg('pg_dump', ['--format=custom', '--schema=public', '--no-owner', '--no-acl',
      '--exclude-table-data=public.lab_bundle', '--exclude-table-data=public.lab_bundle_chunk',
      `--file=${dump}`, `--dbname=${source}`], {env: {...process.env, PGPASSWORD: password}});
    recreateLocalDatabase();
    runPg('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${LOCAL_OWNER_URL}`, dump]);
  } finally {
    fs.rmSync(dump, {force: true});
  }

  const local = await connect(LOCAL_OWNER_URL);
  try {
    await local.query(`
      delete from auth_session; delete from auth_verification; delete from auth_device_code;
      update auth_account set access_token = null, refresh_token = null, id_token = null, password = null;
      create schema mochi_pull;
      create table mochi_pull.pulled (at timestamptz not null, migrations text[] not null);
      create table mochi_pull.workspace (id text primary key, fingerprint text not null);`);
    await local.query('insert into mochi_pull.pulled values (now(), $1)', [await migrations(local)]);
    const tables = await workspaceTables(local);
    const workspaces = (await local.query('select id from workspace')).rows;
    for (const {id: workspaceId} of workspaces) {
      await local.query('insert into mochi_pull.workspace values ($1, $2)', [workspaceId, await fingerprint(local, tables, workspaceId)]);
    }
    return {workspaces: workspaces.length};
  } finally {
    await local.end();
  }
}

/** When the local database was last pulled, or null. */
export async function pulledAt() {
  const local = await connect(LOCAL_OWNER_URL);
  try {
    if (!(await local.query("select to_regclass('mochi_pull.pulled') as t")).rows[0].t) return null;
    return (await local.query('select at from mochi_pull.pulled')).rows[0]?.at ?? null;
  } finally {
    await local.end();
  }
}

class Refusal extends Error {}

async function counts(client, tables, workspaceId) {
  const result = {};
  for (const table of tables) {
    result[table.name] = (await client.query(
      `select count(*)::int as n from public.${id(table.name)} where ${id(table.key)} = $1`, [workspaceId])).rows[0].n;
  }
  return result;
}

/**
 * Push: the local workspace `slug` in place of production's. `confirm` is
 * shown what changes, `{name, rows: [{table, local, production}]}`, and
 * answers whether to go ahead. Returns what was pushed, or null when not confirmed.
 */
export async function push({ownerUrl, slug, confirm}) {
  startLocal();
  const local = await connect(LOCAL_OWNER_URL);
  const production = await connect(ownerUrl);
  try {
    const [localMigrations, productionMigrations] = await Promise.all([migrations(local), migrations(production)]);
    if (localMigrations.join() !== productionMigrations.join()) {
      throw new Refusal('The local database and production have applied different migrations: release them, or run npm start to apply them locally, first');
    }
    if (!(await local.query("select to_regclass('mochi_pull.pulled') as t")).rows[0].t) {
      throw new Refusal('The local database was never pulled: run npm run db:pull first');
    }
    // A fingerprint reads a workspace's tables as they were when it was taken.
    if ((await local.query('select migrations from mochi_pull.pulled')).rows[0].migrations.join() !== productionMigrations.join()) {
      throw new Refusal('Production has applied migrations since your pull: pull again');
    }
    const workspace = (await local.query('select id, name from workspace where lower(slug) = lower($1)', [slug])).rows[0];
    if (!workspace) throw new Refusal(`The local database has no workspace ${slug}`);
    const taken = (await production.query('select id from workspace where lower(slug) = lower($1) and id <> $2', [slug, workspace.id])).rows[0];
    if (taken) throw new Refusal(`Another workspace on production is called ${slug}`);
    const tables = await workspaceTables(local);
    const pulled = (await local.query('select fingerprint from mochi_pull.workspace where id = $1', [workspace.id])).rows[0]?.fingerprint ?? null;

    const assertUnchanged = async () => {
      const exists = (await production.query('select 1 from workspace where id = $1', [workspace.id])).rows.length > 0;
      if (!pulled && exists) throw new Refusal(`${slug} was made on production after your pull: pull again`);
      if (pulled && !exists) throw new Refusal(`${slug} was deleted on production since your pull`);
      if (pulled && await fingerprint(production, tables, workspace.id) !== pulled) {
        throw new Refusal(`${slug} changed on production since your pull. Pull again, which discards your local changes, then make them again`);
      }
    };
    await assertUnchanged();

    const named = new Set();
    for (const table of tables) {
      for (const column of table.users) {
        const {rows} = await local.query(`select distinct ${id(column)} as v from public.${id(table.name)}
          where ${id(table.key)} = $1 and ${id(column)} is not null`, [workspace.id]);
        for (const row of rows) named.add(row.v);
      }
    }
    const known = new Set((await production.query('select id from app_user where id = any($1)', [[...named]])).rows.map(row => row.id));
    const missing = [...named].filter(user => !known.has(user));
    if (missing.length) {
      const labels = (await local.query('select coalesce(display_name, email) as label from app_user where id = any($1) order by 1', [missing])).rows;
      throw new Refusal(`${slug} names accounts production does not have: ${labels.map(row => row.label).join(', ')}. They sign in on rush-lab.org first`);
    }

    const [localCounts, productionCounts] = await Promise.all([counts(local, tables, workspace.id), counts(production, tables, workspace.id)]);
    const rows = tables.map(table => ({table: table.name, local: localCounts[table.name], production: productionCounts[table.name]}))
      .filter(row => row.local || row.production);
    if (!await confirm({name: workspace.name, rows})) return null;

    await production.query('begin');
    try {
      // Writes to these tables wait until the push commits, so nothing lands between the check and the copy.
      await production.query(`lock table ${tables.map(table => `public.${id(table.name)}`).join(', ')} in exclusive mode`);
      await assertUnchanged();
      for (const table of [...tables].reverse()) {
        await production.query(`delete from public.${id(table.name)} where ${id(table.key)} = $1`, [workspace.id]);
      }
      await local.query('begin');
      for (const table of tables) {
        const columns = table.columns.map(id).join(', ');
        await local.query(`declare copy no scroll cursor for
          select row_to_json(x) as row from public.${id(table.name)} x
           where x.${id(table.key)} = ${escapeLiteral(workspace.id)}${table.serial ? ` order by x.${id(table.serial)}` : ''}`);
        for (;;) {
          const batch = (await local.query(`fetch ${BATCH} from copy`)).rows;
          if (!batch.length) break;
          await production.query(`insert into public.${id(table.name)} (${columns})
            select ${columns} from json_populate_recordset(null::public.${id(table.name)}, $1::json)`,
          [JSON.stringify(batch.map(item => item.row))]);
        }
        await local.query('close copy');
      }
      await local.query('commit');
      const pushed = await fingerprint(production, tables, workspace.id);
      await production.query('commit');
      await local.query('insert into mochi_pull.workspace values ($1, $2) on conflict (id) do update set fingerprint = excluded.fingerprint',
        [workspace.id, pushed]);
      return {name: workspace.name, rows};
    } catch (error) {
      await production.query('rollback').catch(() => {});
      await local.query('rollback').catch(() => {});
      throw error;
    }
  } finally {
    await Promise.all([local.end(), production.end()]);
  }
}

export {Refusal};
