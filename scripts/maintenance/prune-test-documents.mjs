#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {createRequire} from 'node:module';
import {isKnownTestDocumentPath} from './test-content-paths.mjs';

const require = createRequire(import.meta.url);
const {createPool} = require('../../src/server/postgres/client.js');

const apply = process.argv.includes('--apply');
const workspaceSlug = process.argv.slice(2).find(argument => !argument.startsWith('--')) || 'mochi';
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required');

const root = path.resolve(import.meta.dirname, '../..');
const contentRoot = path.join(root, 'content', workspaceSlug);
if (!fs.existsSync(contentRoot)) throw new Error(`Canonical content directory does not exist: ${contentRoot}`);

const canonical = new Set();
function walk(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (/\.mdx?$/.test(entry.name)) {
      canonical.add(path.relative(contentRoot, absolute).split(path.sep).join('/'));
    }
  }
}
walk(contentRoot);

const pool = createPool({...process.env, DATABASE_URL: migrationUrl}, {max: 1});
try {
  const workspace = (await pool.query('select id, slug from workspace where slug = $1 limit 1', [workspaceSlug])).rows[0];
  if (!workspace) throw new Error(`No workspace has slug "${workspaceSlug}"`);
  const rows = (await pool.query(
    `select id, path, title, markdown, visibility, created_by as "createdBy",
            created_at as "createdAt", updated_at as "updatedAt"
       from document
      where workspace_id = $1 and deleted_at is null
      order by path`,
    [workspace.id],
  )).rows;
  const candidates = rows.filter(document =>
    !canonical.has(document.path) && isKnownTestDocumentPath(document.path));

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    workspace: workspace.slug,
    activeDocuments: rows.length,
    canonicalDocuments: canonical.size,
    testDocuments: candidates.length,
    paths: candidates.map(document => document.path),
  };

  if (apply && candidates.length) {
    const backupDirectory = path.join(root, 'var', 'backups');
    fs.mkdirSync(backupDirectory, {recursive: true});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDirectory, `postgres-test-documents-${workspace.slug}-${stamp}.json`);
    fs.writeFileSync(backupPath, `${JSON.stringify(candidates, null, 2)}\n`, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(
        'update document set deleted_at = now() where workspace_id = $1 and id = any($2::text[]) and deleted_at is null',
        [workspace.id, candidates.map(document => document.id)],
      );
      if (result.rowCount !== candidates.length) {
        throw new Error(`Expected to soft-delete ${candidates.length} rows, changed ${result.rowCount}`);
      }
      await client.query('commit');
      report.backup = backupPath;
      report.softDeleted = result.rowCount;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
