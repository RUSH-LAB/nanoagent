'use strict';

/**
 * Copy the legacy content tables into the workspace file system.
 *
 * Documents keep their ids, authors, timestamps, visibility, and trash state,
 * and their saved versions become the node's earlier revisions in fs_change.
 * Uploaded assets keep their ids and bytes; a plugin's blob, which has no path
 * of its own, goes under `.plugins/blobs/`. App records (store_item, and the
 * bibliography's `reference` rows) become the JSON files fs/records.js reads,
 * members' own under their private home folder; internal state such as page
 * analytics stays where it is. Folders are created for every path.
 *
 * Runs on the schema owner's connection, which row-level security does not
 * restrict, because it writes on behalf of every author at once. A workspace
 * that already has file system content is skipped unless `replace` is set, and
 * nothing is written unless `apply` is set. After writing, every document and
 * asset is compared with its node by SHA-256.
 */
const crypto = require('crypto');
const path = require('path');
const {cleanAssetPath} = require('../asset-paths');
const {contentTypeFor, parentOf} = require('./store');
const {titleOf} = require('../document-title');
const {SYSTEM_DOMAINS, fileNameFor, folderFor, serialize} = require('./records');

const sha256 = body => crypto.createHash('sha256').update(body).digest('hex');
const asBuffer = value => (Buffer.isBuffer(value) ? value : Buffer.from(value));
const time = value => new Date(value).getTime();

/** Everything one workspace's file system will hold, in the order it happened. */
async function plan(client, workspaceId) {
  const documents = (await client.query(
    `select id, path, markdown, visibility, created_by, created_at, updated_at, deleted_at
       from document where workspace_id = $1 order by created_at, id`, [workspaceId],
  )).rows;
  const versions = (await client.query(
    `select document_id, seq, markdown, author_id, created_at
       from document_version where workspace_id = $1 order by document_id, seq`, [workspaceId],
  )).rows;
  const assets = (await client.query(
    `select a.id, a.path, a.object_key, a.content_type, a.sha256, a.created_by, a.created_at, b.body
       from asset a left join object_blob b on b.object_key = a.object_key
      where a.workspace_id = $1 order by a.created_at, a.id`, [workspaceId],
  )).rows;

  const files = [];
  const events = [];
  for (const document of documents) {
    const history = versions.filter(version => version.document_id === document.id);
    // A version row holds the text a save replaced, so the k-th text was
    // written when the previous save happened, by that save's author.
    const texts = [...history.map(version => version.markdown), document.markdown];
    const at = [document.created_at, ...history.map(version => version.created_at)];
    const by = [document.created_by, ...history.map(version => version.author_id ?? document.created_by)];
    const file = {
      id: document.id,
      path: document.path,
      body: Buffer.from(document.markdown),
      contentType: contentTypeFor(document.path),
      meta: {title: titleOf(document.markdown, document.path)},
      access: document.visibility === 'private' ? 'private' : 'workspace',
      accessExplicit: document.visibility === 'private',
      ownerId: document.created_by,
      createdBy: document.created_by,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
      deletedAt: document.deleted_at,
    };
    files.push(file);
    texts.forEach((text, index) => events.push({
      node: file, op: index === 0 ? 'create' : 'write', body: Buffer.from(text), actor: by[index], at: at[index],
    }));
    if (document.deleted_at) events.push({node: file, op: 'delete', actor: document.created_by, at: document.deleted_at});
  }
  for (const asset of assets) {
    if (!asset.body) throw new Error(`Asset ${asset.id} has no stored bytes at ${asset.object_key}`);
    const body = asBuffer(asset.body);
    if (sha256(body) !== asset.sha256) throw new Error(`Asset ${asset.id} bytes do not match their recorded SHA-256`);
    const logical = cleanAssetPath(asset.path) && asset.path !== asset.id
      ? asset.path
      : `.plugins/blobs/${asset.id}${path.posix.extname(asset.object_key)}`;
    const file = {
      id: asset.id,
      path: logical,
      body,
      contentType: asset.content_type,
      meta: {},
      access: 'workspace',
      accessExplicit: false,
      ownerId: asset.created_by,
      createdBy: asset.created_by,
      createdAt: asset.created_at,
      updatedAt: asset.created_at,
      deletedAt: null,
    };
    files.push(file);
    events.push({node: file, op: 'create', body, actor: asset.created_by, at: asset.created_at});
  }

  const records = (await client.query(
    `select domain, owner_id, key, value, created_at, updated_at from store_item
      where workspace_id = $1 and domain <> all($2::text[]) order by created_at, key`,
    [workspaceId, [...SYSTEM_DOMAINS]],
  )).rows;
  const references = (await client.query(
    `select id, citation_key, value, created_by, created_at, updated_at
       from reference where workspace_id = $1 order by created_at, citation_key`, [workspaceId],
  )).rows;
  const homes = new Map();
  const recordFiles = [
    ...records.map(record => ({...record, id: crypto.randomUUID(), author: record.owner_id})),
    ...references.map(reference => ({
      id: reference.id, domain: 'plugin:bibliography:papers', owner_id: null, key: reference.citation_key,
      value: reference.value, author: reference.created_by, created_at: reference.created_at, updated_at: reference.updated_at,
    })),
  ];
  for (const record of recordFiles) {
    const folder = folderFor(record.domain, {workspaceId, userId: record.owner_id});
    const home = folder.startsWith('home/') ? folder.split('/').slice(0, 2).join('/') : null;
    if (home) homes.set(home, record.owner_id);
    const body = Buffer.from(serialize(record.key, record.value));
    const file = {
      id: record.id,
      path: `${folder}/${fileNameFor(record.key)}`,
      body,
      contentType: 'application/json',
      meta: {},
      access: home ? 'private' : 'workspace',
      accessExplicit: false,
      ownerId: record.owner_id,
      createdBy: record.author,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      deletedAt: null,
    };
    files.push(file);
    events.push({node: file, op: 'create', body, actor: record.author, at: record.created_at});
  }

  const live = new Map();
  for (const file of files.filter(each => !each.deletedAt)) {
    if (live.has(file.path)) throw new Error(`Two files would share the path ${file.path} in workspace ${workspaceId}`);
    live.set(file.path, file);
  }
  const folders = new Map();
  for (const file of files) {
    for (let folder = parentOf(file.path); folder; folder = parentOf(folder)) {
      if (live.has(folder)) throw new Error(`${folder} is both a file and a folder in workspace ${workspaceId}`);
      const known = folders.get(folder);
      if (!known || time(file.createdAt) < time(known.createdAt)) {
        // A member's home folder is private to them, and everything in it inherits that.
        const home = [...homes.keys()].find(each => folder === each || folder.startsWith(`${each}/`));
        folders.set(folder, {
          id: known?.id ?? crypto.randomUUID(), path: folder, createdBy: file.createdBy, createdAt: file.createdAt,
          access: home ? 'private' : 'workspace', accessExplicit: folder === home, ownerId: home ? homes.get(home) : file.createdBy,
        });
      }
    }
  }
  for (const folder of folders.values()) {
    events.push({node: {...folder, kind: 'folder'}, op: 'create', actor: folder.createdBy, at: folder.createdAt, folder: true});
  }
  // Folders before what they contain when two things happened at once.
  events.sort((a, b) => time(a.at) - time(b.at) || Number(Boolean(b.folder)) - Number(Boolean(a.folder))
    || a.node.path.length - b.node.path.length);
  return {documents, assets, records: recordFiles, files, folders: [...folders.values()], events};
}

async function importWorkspace(client, workspace, {replace}) {
  const existing = Number((await client.query(
    'select count(*)::int as count from fs_node where workspace_id = $1', [workspace.id],
  )).rows[0].count);
  if (existing && !replace) return {workspace: workspace.slug, skipped: `already has ${existing} file system nodes`};
  const {documents, assets, records, files, folders, events} = await plan(client, workspace.id);
  if (existing) {
    await client.query('delete from fs_change where workspace_id = $1', [workspace.id]);
    await client.query('delete from fs_node where workspace_id = $1', [workspace.id]);
    await client.query('delete from fs_content where workspace_id = $1', [workspace.id]);
  }
  const stored = new Set();
  const store = async body => {
    const hash = sha256(body);
    if (!stored.has(hash)) {
      await client.query(
        'insert into fs_content(workspace_id, hash, body, size) values ($1, $2, $3, $4) on conflict do nothing',
        [workspace.id, hash, body, body.length],
      );
      stored.add(hash);
    }
    return hash;
  };
  // Nodes first, with their final state, so every change can name one.
  for (const folder of folders) {
    await client.query(
      `insert into fs_node(id, workspace_id, path, kind, access, access_explicit, owner_id, rev, created_by, created_at, updated_at)
       values ($1, $2, $3, 'folder', $4, $5, $6, 0, $7, $8, $8)`,
      [folder.id, workspace.id, folder.path, folder.access, folder.accessExplicit, folder.ownerId, folder.createdBy, folder.createdAt],
    );
  }
  for (const file of files) {
    const hash = await store(file.body);
    await client.query(
      `insert into fs_node(id, workspace_id, path, kind, content_hash, size, content_type, access, access_explicit,
                           owner_id, meta, rev, created_by, created_at, updated_at, deleted_at)
       values ($1, $2, $3, 'file', $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13, $14)`,
      [file.id, workspace.id, file.path, hash, file.body.length, file.contentType, file.access, file.accessExplicit,
        file.ownerId, JSON.stringify(file.meta), file.createdBy, file.createdAt, file.updatedAt, file.deletedAt],
    );
  }
  for (const event of events) {
    const hash = event.body ? await store(event.body) : null;
    const seq = (await client.query(
      `insert into fs_change(workspace_id, node_id, op, path, kind, content_hash, access, actor_id, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning seq`,
      [workspace.id, event.node.id, event.op, event.node.path, event.node.kind ?? 'file', hash,
        event.node.access ?? 'workspace', event.actor, event.at],
    )).rows[0].seq;
    await client.query('update fs_node set rev = $1 where id = $2', [seq, event.node.id]);
  }
  return {
    workspace: workspace.slug, documents: documents.length, assets: assets.length, records: records.length, folders: folders.length,
  };
}

/** Compare every legacy document and asset with its file system node. */
async function verifyWorkspace(client, workspace) {
  const mismatches = (await client.query(
    `select d.id, d.path from document d
       left join fs_node n on n.id = d.id and n.workspace_id = d.workspace_id
      where d.workspace_id = $1
        and (n.id is null or n.content_hash <> encode(sha256(convert_to(d.markdown, 'UTF8')), 'hex')
             or (n.deleted_at is null) <> (d.deleted_at is null))
     union all
     select a.id, a.path from asset a
       left join fs_node n on n.id = a.id and n.workspace_id = a.workspace_id
      where a.workspace_id = $1 and (n.id is null or n.content_hash <> a.sha256)`,
    [workspace.id],
  )).rows;
  return mismatches;
}

async function importLegacyContent(pool, {apply = false, replace = false, log = () => {}} = {}) {
  const client = await pool.connect();
  try {
    const workspaces = (await client.query('select id, slug from workspace order by created_at, id')).rows;
    const report = [];
    await client.query('begin');
    for (const workspace of workspaces) {
      const result = await importWorkspace(client, workspace, {replace});
      if (!result.skipped) {
        const mismatches = await verifyWorkspace(client, workspace);
        if (mismatches.length) {
          throw new Error(`Imported content does not match the originals in ${workspace.slug}: `
            + mismatches.map(row => row.path).join(', '));
        }
        result.verified = true;
      }
      report.push(result);
      log(result);
    }
    await client.query(apply ? 'commit' : 'rollback');
    return {applied: apply, workspaces: report};
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {importLegacyContent};
