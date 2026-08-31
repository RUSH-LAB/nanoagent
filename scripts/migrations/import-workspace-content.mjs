#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const postgres = require('../../src/server/postgres/database.js');
const postgresServices = postgres.enabled ? require('../../src/server/postgres/services.js') : null;
const db = postgres.enabled ? null : require('../../src/server/db.js').db;
const documents = postgresServices?.documents ?? require('../../src/server/documents.js');
const store = postgresServices?.store ?? require('../../src/server/store/index.js');
const assets = postgresServices?.assets ?? require('../../src/server/assets.js');
const workspaceSettings = postgresServices?.workspaceSettings ?? require('../../src/server/workspace-settings.js');
const {createObjectStorage} = require('../../src/server/object-storage.js');
const {cleanAssetPath, contentTypeForAsset, assetObjectKey} = require('../../src/server/asset-paths.js');
const {paperForStorage, isIntegrationTestPaper} = require('../../plugins/bibliography/lib/protocol.js');
const {PROJECT_ROOT} = require('../../src/server/paths.js');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const overwrite = args.has('--overwrite');
const selected = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const contentRoot = path.join(PROJECT_ROOT, 'content');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function valueHash(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function markdownFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.mdx?$/.test(entry.name)) out.push(absolute);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

function assetFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (cleanAssetPath(relative)) out.push(absolute);
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

async function workspaces() {
  await postgres.ready;
  const rows = postgres.enabled
    ? (await postgres.pool.query('select id, slug, name, owner_id as "ownerId" from list_scheduled_workspaces() order by slug')).rows
    : db.prepare(`SELECT o.id, o.slug, o.name,
        (SELECT userId FROM member WHERE organizationId = o.id AND role = 'owner' ORDER BY createdAt, rowid LIMIT 1) AS ownerId
        FROM organization o ORDER BY o.slug`).all();
  return selected ? rows.filter(row => row.slug === selected) : rows;
}

const report = [];
let conflicts = 0;
const objectStorage = apply ? createObjectStorage() : null;
for (const workspace of await workspaces()) {
  const root = path.join(contentRoot, workspace.slug);
  const files = markdownFiles(root);
  const binaryFiles = assetFiles(root);
  const scope = {
    workspaceId: workspace.id,
    userId: workspace.ownerId,
    membershipId: null,
    role: 'owner',
    kind: 'migration',
  };
  const summary = {
    workspace: workspace.slug,
    files: files.length,
    create: 0,
    unchanged: 0,
    update: 0,
    conflicts: [],
    assets: {source: binaryFiles.length, create: 0, unchanged: 0, update: 0, conflicts: []},
    siteSettings: 'unchanged',
    references: {source: 0, create: 0, unchanged: 0, update: 0, conflicts: []},
  };

  if (workspace.slug === 'mochi') {
    const currentSettings = await workspaceSettings.get(scope);
    if (!currentSettings.schemaVersion) {
      summary.siteSettings = apply ? 'created' : 'create';
      if (apply) {
        await workspaceSettings.update(scope, {
          schemaVersion: 1,
          site: {
            title: 'Mochi Lab',
            tagline: 'Innovative Research & Development',
            logoAssetId: null,
            homeDocument: 'books/programming/0-intro.md',
          },
          navigation: [
            {label: 'Research', path: 'posts/research'},
            {label: 'Blog', path: 'posts/blog'},
            {label: 'Survey', path: 'books/survey/intro.md'},
            {label: 'Programming', path: 'books/programming/0-intro.md'},
            {label: 'Math', path: 'books/math/0-intro.md'},
          ],
          rendering: {math: true, citations: true, wikiLinks: true, leanProofs: true, interactiveMath: true},
        });
      }
    }
  }
  const sourceDocuments = [];
  const destinationDocuments = [];
  const sourceReferences = [];
  const destinationReferences = [];
  const existingDocuments = new Map(
    (await documents.snapshot(scope)).map(document => [document.path, document]),
  );

  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const markdown = fs.readFileSync(absolute, 'utf8');
    const sourceHash = sha256(markdown);
    sourceDocuments.push([relative, sourceHash]);
    const existing = existingDocuments.get(relative);
    if (!existing) {
      summary.create += 1;
      if (apply) await documents.create(scope, {path: relative, markdown});
      destinationDocuments.push([relative, apply ? sourceHash : null]);
      continue;
    }
    const databaseHash = sha256(existing.markdown);
    destinationDocuments.push([relative, databaseHash]);
    if (sourceHash === databaseHash) {
      summary.unchanged += 1;
      continue;
    }
    if (!overwrite) {
      conflicts += 1;
      summary.conflicts.push({path: relative, sourceHash, databaseHash});
      continue;
    }
    summary.update += 1;
    if (apply) {
      await documents.save(scope, relative, markdown);
      destinationDocuments[destinationDocuments.length - 1][1] = sourceHash;
    }
  }
  summary.verification = {
    sourceHash: valueHash(sourceDocuments),
    databaseHash: valueHash(destinationDocuments),
    matches: valueHash(sourceDocuments) === valueHash(destinationDocuments),
  };

  const existingAssets = new Map((await assets.list(scope)).map(asset => [asset.path, asset]));
  const sourceAssets = [];
  const destinationAssets = [];
  for (const absolute of binaryFiles) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const body = fs.readFileSync(absolute);
    const sourceHash = sha256(body);
    const existing = existingAssets.get(relative);
    sourceAssets.push([relative, sourceHash]);
    if (existing?.sha256 === sourceHash) {
      summary.assets.unchanged += 1;
      destinationAssets.push([relative, sourceHash]);
      if (apply && !await objectStorage.stat(existing.objectKey)) {
        await objectStorage.put(existing.objectKey, body, existing.contentType);
      }
      continue;
    }
    if (existing && !overwrite) {
      conflicts += 1;
      summary.assets.conflicts.push({path: relative, sourceHash, databaseHash: existing.sha256});
      destinationAssets.push([relative, existing.sha256]);
      continue;
    }
    if (existing) summary.assets.update += 1;
    else summary.assets.create += 1;
    if (apply) {
      const objectKey = assetObjectKey(workspace.id, relative, sourceHash);
      const contentType = contentTypeForAsset(relative);
      await objectStorage.put(objectKey, body, contentType);
      await assets.put(scope, {
        path: relative,
        objectKey,
        contentType,
        byteSize: body.length,
        sha256: sourceHash,
      });
      if (existing && existing.objectKey !== objectKey) {
        await objectStorage.remove(existing.objectKey).catch(() => {});
      }
      destinationAssets.push([relative, sourceHash]);
    } else {
      destinationAssets.push([relative, null]);
    }
  }
  summary.assets.verification = {
    sourceHash: valueHash(sourceAssets),
    databaseHash: valueHash(destinationAssets),
    matches: valueHash(sourceAssets) === valueHash(destinationAssets),
  };

  const bibliographyPath = path.join(root, 'bibliography', 'references.yaml');
  if (fs.existsSync(bibliographyPath)) {
    let bibliography;
    try {
      bibliography = yaml.load(fs.readFileSync(bibliographyPath, 'utf8')) || {};
    } catch (error) {
      conflicts += 1;
      summary.references.conflicts.push({path: 'bibliography/references.yaml', error: error.message});
      report.push(summary);
      continue;
    }
    const paperRecords = store.collection('plugin:bibliography:papers');
    const existingPapers = await paperRecords.entries(scope);
    for (const [key, raw] of Object.entries(bibliography)) {
      if (isIntegrationTestPaper(key, raw)) continue;
      summary.references.source += 1;
      const paper = paperForStorage(raw);
      const sourceHash = valueHash(paper);
      sourceReferences.push([key, sourceHash]);
      const existing = existingPapers[key];
      if (!existing) {
        summary.references.create += 1;
        if (apply) await paperRecords.put(scope, key, paper);
        destinationReferences.push([key, apply ? sourceHash : null]);
        continue;
      }
      const databaseHash = valueHash(existing);
      destinationReferences.push([key, databaseHash]);
      if (sourceHash === databaseHash) {
        summary.references.unchanged += 1;
        continue;
      }
      if (!overwrite) {
        conflicts += 1;
        summary.references.conflicts.push({key, sourceHash, databaseHash});
        continue;
      }
      summary.references.update += 1;
      if (apply) {
        await paperRecords.put(scope, key, paper);
        destinationReferences[destinationReferences.length - 1][1] = sourceHash;
      }
    }
  }
  summary.references.verification = {
    sourceHash: valueHash(sourceReferences),
    databaseHash: valueHash(destinationReferences),
    matches: valueHash(sourceReferences) === valueHash(destinationReferences),
  };
  report.push(summary);
}

await postgres.close();

if (selected && report.length === 0) {
  console.error(`No workspace has slug "${selected}".`);
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({mode: apply ? 'apply' : 'dry-run', overwrite, report}, null, 2));
  if (conflicts) {
    console.error(`${conflicts} content conflict(s); inspect hashes or rerun with --apply --overwrite.`);
    process.exitCode = 3;
  }
}
