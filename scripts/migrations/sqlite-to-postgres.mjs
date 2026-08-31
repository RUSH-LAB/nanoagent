#!/usr/bin/env node
/**
 * One-time cutover from the local SQLite schema to the canonical PostgreSQL
 * schema. Dry-run is the default. --apply requires an empty destination and
 * verifies row counts plus canonical SHA-256 hashes after the transaction.
 *
 * Sessions and verification tokens are intentionally not copied: a database
 * cutover invalidates existing sessions and makes every user authenticate
 * against the migrated credential record again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {
  createPool, migrate, grantRuntimeAccess, assertRuntimeRoleIsNotOwner,
} = require('../../src/server/postgres/client.js');
const {s3ObjectStorage} = require('../../src/server/object-storage.js');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const sourceOnly = args.has('--source-only');
const skipAssetBytes = args.has('--skip-asset-bytes');
const sourceFile = process.env.DATABASE_FILE || path.resolve('var/data/mochi.db');
const sourceObjectRoot = path.resolve(process.env.SOURCE_OBJECT_ROOT
  || path.resolve(path.dirname(sourceFile), '..', 'objects'));
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;

if (apply && sourceOnly) throw new Error('--apply and --source-only cannot be used together');
if (!sourceOnly && !migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required');
if (!sourceOnly && !runtimeUrl) throw new Error('DATABASE_URL is required so runtime-role RLS can be verified');
if (!fs.existsSync(sourceFile)) throw new Error(`SQLite source does not exist: ${sourceFile}`);

const source = new Database(sourceFile, {readonly: true, fileMustExist: true});
const migrationPool = sourceOnly ? null : createPool({...process.env, DATABASE_URL: migrationUrl}, {max: 2});
const runtimePool = sourceOnly ? null : createPool(process.env, {max: 2});
const role = value => ({owner: 'owner', admin: 'editor', member: 'viewer', editor: 'editor', viewer: 'viewer'}[value] || 'viewer');
const parse = value => {
  if (value == null || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
const bool = value => Boolean(value);

function rows(sql) {
  return source.prepare(sql).all();
}

function hasTable(name) {
  return Boolean(source.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  if (Buffer.isBuffer(value)) return {base64: value.toString('base64')};
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function digest(data) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
}

function sorted(data, keys) {
  return [...data].sort((a, b) => keys.map(key => String(a[key] ?? '').localeCompare(String(b[key] ?? '')))
    .find(value => value !== 0) || 0);
}

const datasets = [
  {
    table: 'app_user', keys: ['id'], columns: ['id', 'email', 'display_name', 'email_verified', 'image', 'created_at', 'updated_at'],
    source: () => rows('select id, lower(trim(email)) as email, name as display_name, emailVerified as email_verified, image, createdAt as created_at, updatedAt as updated_at from user')
      .map(row => ({...row, email_verified: bool(row.email_verified)})),
    destination: 'select id, email, display_name, email_verified, image, created_at, updated_at from app_user',
  },
  {
    table: 'auth_account', keys: ['id'], columns: ['id', 'issuer', 'account_id', 'provider_id', 'user_id', 'access_token', 'refresh_token', 'id_token', 'access_token_expires_at', 'refresh_token_expires_at', 'scope', 'password', 'created_at', 'updated_at'],
    source: () => rows('select id, issuer, accountId as account_id, providerId as provider_id, userId as user_id, accessToken as access_token, refreshToken as refresh_token, idToken as id_token, accessTokenExpiresAt as access_token_expires_at, refreshTokenExpiresAt as refresh_token_expires_at, scope, password, createdAt as created_at, updatedAt as updated_at from account'),
    destination: 'select id, issuer, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at from auth_account',
  },
  {
    table: 'workspace', keys: ['id'], columns: ['id', 'name', 'slug', 'logo', 'status', 'created_by', 'created_at', 'updated_at', 'archived_at'],
    source: () => rows('select id, name, lower(slug) as slug, logo, status, createdBy as created_by, createdAt as created_at, createdAt as updated_at, archivedAt as archived_at from organization'),
    destination: 'select id, name, slug, logo, status, created_by, created_at, updated_at, archived_at from workspace',
  },
  {
    table: 'workspace_member', keys: ['id'], columns: ['id', 'workspace_id', 'user_id', 'role', 'created_at'],
    source: () => rows('select id, organizationId as workspace_id, userId as user_id, role, createdAt as created_at from member').map(row => ({...row, role: role(row.role)})),
    destination: 'select id, workspace_id, user_id, role, created_at from workspace_member',
  },
  {
    table: 'workspace_invitation', keys: ['id'], columns: ['id', 'workspace_id', 'email', 'role', 'status', 'expires_at', 'invited_by', 'created_at'],
    source: () => rows('select id, organizationId as workspace_id, lower(trim(email)) as email, role, status, expiresAt as expires_at, inviterId as invited_by, createdAt as created_at from invitation').map(row => ({...row, role: role(row.role)})),
    destination: 'select id, workspace_id, email, role, status, expires_at, invited_by, created_at from workspace_invitation',
  },
  {
    table: 'workspace_settings', keys: ['workspace_id'], columns: ['workspace_id', 'value', 'updated_at'],
    source: () => rows('select organizationId as workspace_id, value, updatedAt as updated_at from workspace_settings').map(row => ({...row, value: parse(row.value)})),
    destination: 'select workspace_id, value, updated_at from workspace_settings',
  },
  {
    table: 'user_preferences', keys: ['user_id'], columns: ['user_id', 'value', 'updated_at'],
    source: () => rows('select userId as user_id, value, updatedAt as updated_at from user_preferences').map(row => ({...row, value: parse(row.value)})),
    destination: 'select user_id, value, updated_at from user_preferences',
  },
  {
    table: 'workspace_member_preferences', keys: ['workspace_id', 'user_id'], columns: ['workspace_id', 'user_id', 'value', 'updated_at'],
    source: () => rows('select organizationId as workspace_id, userId as user_id, value, updatedAt as updated_at from workspace_member_preferences').map(row => ({...row, value: parse(row.value)})),
    destination: 'select workspace_id, user_id, value, updated_at from workspace_member_preferences',
  },
  {
    table: 'document', keys: ['id'], columns: ['id', 'workspace_id', 'path', 'title', 'markdown', 'ydoc', 'visibility', 'created_by', 'created_at', 'updated_at', 'deleted_at'],
    source: () => rows('select id, organizationId as workspace_id, path, title, markdown, ydoc, visibility, createdBy as created_by, createdAt as created_at, updatedAt as updated_at, deletedAt as deleted_at from document'),
    destination: 'select id, workspace_id, path, title, markdown, ydoc, visibility, created_by, created_at, updated_at, deleted_at from document',
  },
  {
    table: 'document_version', keys: ['id'], columns: ['id', 'workspace_id', 'document_id', 'seq', 'markdown', 'author_id', 'created_at'],
    source: () => rows('select v.id, d.organizationId as workspace_id, v.documentId as document_id, v.seq, v.markdown, v.authorId as author_id, v.createdAt as created_at from document_version v join document d on d.id = v.documentId'),
    destination: 'select id, workspace_id, document_id, seq::int as seq, markdown, author_id, created_at from document_version',
  },
  {
    table: 'asset', keys: ['id'], columns: ['id', 'workspace_id', 'object_key', 'content_type', 'byte_size', 'sha256', 'created_by', 'created_at'],
    source: () => rows('select id, organizationId as workspace_id, objectKey as object_key, contentType as content_type, byteSize as byte_size, sha256, createdBy as created_by, createdAt as created_at from asset'),
    destination: 'select id, workspace_id, object_key, content_type, byte_size::int as byte_size, sha256, created_by, created_at from asset',
  },
  {
    table: 'reference', keys: ['workspace_id', 'citation_key'], columns: ['id', 'workspace_id', 'citation_key', 'value', 'created_by', 'created_at', 'updated_at'],
    source: () => rows("select organizationId as workspace_id, key as citation_key, value, createdAt as created_at, updatedAt as updated_at from store_item where domain = 'plugin:bibliography:papers'")
      .map(row => ({id: crypto.randomUUID(), ...row, value: parse(row.value), created_by: null})),
    destination: 'select workspace_id, citation_key, value, created_at, updated_at from reference',
    compareColumns: ['workspace_id', 'citation_key', 'value', 'created_at', 'updated_at'],
  },
  {
    table: 'store_item', keys: ['workspace_id', 'domain', 'owner_id', 'key'], columns: ['workspace_id', 'owner_id', 'domain', 'key', 'value', 'created_at', 'updated_at'],
    source: () => rows("select organizationId as workspace_id, ownerId as owner_id, domain, key, value, createdAt as created_at, updatedAt as updated_at from store_item where domain <> 'plugin:bibliography:papers'")
      .map(row => ({...row, value: parse(row.value)})),
    destination: 'select workspace_id, owner_id, domain, key, value, created_at, updated_at from store_item',
  },
  {
    table: 'channel', keys: ['id'], columns: ['id', 'workspace_id', 'kind', 'name', 'topic', 'dm_key', 'created_by', 'created_at', 'archived_at'],
    source: () => rows('select id, organizationId as workspace_id, kind, name, topic, dmKey as dm_key, createdBy as created_by, createdAt as created_at, archivedAt as archived_at from channel'),
    destination: 'select id, workspace_id, kind, name, topic, dm_key, created_by, created_at, archived_at from channel',
  },
  {
    table: 'channel_member', keys: ['channel_id', 'user_id'], columns: ['workspace_id', 'channel_id', 'user_id', 'joined_at', 'last_read_seq'],
    source: () => rows('select c.organizationId as workspace_id, m.channelId as channel_id, m.userId as user_id, m.joinedAt as joined_at, m.lastReadSeq as last_read_seq from channel_member m join channel c on c.id = m.channelId'),
    destination: 'select workspace_id, channel_id, user_id, joined_at, last_read_seq::int as last_read_seq from channel_member',
  },
  {
    table: 'message', keys: ['id'], columns: ['id', 'workspace_id', 'seq', 'channel_id', 'user_id', 'body', 'created_at', 'edited_at', 'deleted_at'],
    source: () => rows('select m.id, c.organizationId as workspace_id, m.seq, m.channelId as channel_id, m.userId as user_id, m.body, m.createdAt as created_at, m.editedAt as edited_at, m.deletedAt as deleted_at from message m join channel c on c.id = m.channelId'),
    destination: 'select id, workspace_id, seq::int as seq, channel_id, user_id, body, created_at, edited_at, deleted_at from message',
  },
  {
    table: 'workspace_audit', keys: ['id'], columns: ['id', 'workspace_id', 'action', 'actor_id', 'actor_label', 'target_id', 'target_label', 'detail', 'at'],
    source: () => rows('select id, organizationId as workspace_id, action, actorId as actor_id, actorLabel as actor_label, targetId as target_id, targetLabel as target_label, detail, at from org_audit').map(row => ({...row, detail: parse(row.detail)})),
    destination: 'select id, workspace_id, action, actor_id, actor_label, target_id, target_label, detail, at from workspace_audit',
  },
  {
    table: 'platform_admin', keys: ['user_id'], columns: ['user_id', 'granted_at'],
    source: () => rows('select userId as user_id, addedAt as granted_at from platform_admin'),
    destination: 'select user_id, granted_at from platform_admin',
  },
  {
    table: 'object_deletion', keys: ['id'], columns: ['id', 'workspace_id', 'object_key', 'requested_at', 'attempts', 'last_error'],
    source: () => hasTable('object_deletion')
      ? rows('select id, workspaceId as workspace_id, objectKey as object_key, requestedAt as requested_at, attempts, lastError as last_error from object_deletion')
      : [],
    destination: 'select id, workspace_id, object_key, requested_at, attempts, last_error from object_deletion',
  },
];

for (const dataset of datasets) dataset.rows = sorted(dataset.source(), dataset.keys);

const duplicateEmails = datasets[0].rows.reduce((seen, user) => {
  seen.set(user.email, (seen.get(user.email) || 0) + 1);
  return seen;
}, new Map());
const collisions = [...duplicateEmails].filter(([, count]) => count > 1).map(([email]) => email);
if (collisions.length) throw new Error(`Normalized email collision(s): ${collisions.join(', ')}`);

function insertSql(dataset) {
  const names = dataset.columns.map(name => `"${name}"`).join(', ');
  const values = dataset.columns.map((_, index) => `$${index + 1}`).join(', ');
  return `insert into "${dataset.table}" (${names}) values (${values})`;
}

async function destinationRows(client, dataset) {
  const data = (await client.query(dataset.destination)).rows;
  const columns = dataset.compareColumns || dataset.columns;
  return sorted(data.map(row => Object.fromEntries(columns.map(column => [column, row[column]]))), dataset.keys);
}

function comparableSource(dataset) {
  const columns = dataset.compareColumns || dataset.columns;
  return dataset.rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
}

async function verify(client) {
  const report = [];
  let ok = true;
  for (const dataset of datasets) {
    const expected = comparableSource(dataset);
    const actual = await destinationRows(client, dataset);
    const sourceHash = digest(expected);
    const destinationHash = digest(actual);
    const matches = expected.length === actual.length && sourceHash === destinationHash;
    report.push({table: dataset.table, source: expected.length, destination: actual.length, sourceHash, destinationHash, matches});
    if (!matches) ok = false;
  }
  return {ok, report};
}

async function copyAssetBytes() {
  const assets = datasets.find(item => item.table === 'asset').rows;
  if (!assets.length || skipAssetBytes) return {total: assets.length, copied: 0, skipped: assets.length};
  const required = ['OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_BUCKET', 'OBJECT_STORAGE_ACCESS_KEY_ID', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'];
  const missing = required.filter(name => !process.env[name]);
  if (apply && missing.length) throw new Error(`Asset migration requires ${missing.join(', ')} or --skip-asset-bytes`);
  const storage = apply ? s3ObjectStorage({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    bucket: process.env.OBJECT_STORAGE_BUCKET,
    region: process.env.OBJECT_STORAGE_REGION || 'auto',
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  }) : null;
  let copied = 0;
  for (const asset of assets) {
    const absolute = path.resolve(sourceObjectRoot, asset.object_key);
    if (absolute !== sourceObjectRoot && !absolute.startsWith(`${sourceObjectRoot}${path.sep}`)) {
      throw new Error(`Unsafe object key: ${asset.object_key}`);
    }
    const body = fs.readFileSync(absolute);
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (hash !== asset.sha256 || body.length !== asset.byte_size) throw new Error(`Asset checksum mismatch: ${asset.id}`);
    if (apply) await storage.put(asset.object_key, body, asset.content_type);
    copied++;
  }
  return {total: assets.length, copied: apply ? copied : 0, verified: copied};
}

if (sourceOnly) {
  const assetBytes = await copyAssetBytes();
  console.log(JSON.stringify({
    mode: 'source-only',
    source: sourceFile,
    sessionsInvalidated: rows('select id from session').length,
    verificationsInvalidated: rows('select id from verification').length,
    assetBytes,
    tables: datasets.map(dataset => ({
      table: dataset.table,
      rows: comparableSource(dataset).length,
      sourceHash: digest(comparableSource(dataset)),
    })),
  }, null, 2));
  source.close();
  process.exit(0);
}

try {
  await migrate(migrationPool);
  await grantRuntimeAccess(migrationPool, runtimePool);
  await assertRuntimeRoleIsNotOwner(runtimePool);

  const before = await verify(migrationPool);
  const destinationRowsTotal = before.report.reduce((sum, item) => sum + item.destination, 0);
  const alreadyMatches = before.ok;

  if (apply && destinationRowsTotal && !alreadyMatches) {
    throw new Error('Destination contains data that does not exactly match the source; refusing a partial merge');
  }

  const assetBytes = await copyAssetBytes();

  if (apply && !alreadyMatches) {
    const client = await migrationPool.connect();
    try {
      await client.query('begin');
      for (const dataset of datasets) {
        const statement = insertSql(dataset);
        for (const row of dataset.rows) {
          const values = dataset.columns.map(column => {
            const value = row[column];
            return value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)
              ? JSON.stringify(value)
              : value;
          });
          await client.query(statement, values);
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  const after = apply ? await verify(migrationPool) : before;
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    source: sourceFile,
    sessionsInvalidated: rows('select id from session').length,
    verificationsInvalidated: rows('select id from verification').length,
    assetBytes,
    destinationInitiallyEmpty: destinationRowsTotal === 0,
    verified: apply ? after.ok : alreadyMatches,
    tables: apply ? after.report : before.report,
  }, null, 2));
  if (apply && !after.ok) throw new Error('Post-migration count/hash verification failed');
} finally {
  source.close();
  await runtimePool.end();
  await migrationPool.end();
}
