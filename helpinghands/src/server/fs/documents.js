'use strict';

/**
 * The document repository, served from the workspace file system. A document
 * is a Markdown file; its id is the node id, its revision check is still
 * `updatedAt`, and its versions are the node's revisions in the change log.
 */
const {checkPath, prefixOf, titleOf} = require('../postgres/documents');
const {isMarkdown} = require('./store');

const VISIBILITIES = Object.freeze(['org', 'private']);

function conflict(currentUpdatedAt) {
  const error = new Error('This document changed after you opened it. Reload before saving.');
  error.status = 409;
  error.code = 'document-conflict';
  error.currentUpdatedAt = currentUpdatedAt;
  return error;
}

function pathTaken(path) {
  const error = new Error(`A document already exists at ${path}`);
  error.status = 409;
  error.code = 'path-taken';
  return error;
}

function assertCurrentRevision(node, expectedUpdatedAt) {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) return;
  const current = new Date(node.updatedAt).getTime();
  const expected = new Date(expectedUpdatedAt).getTime();
  if ((!Number.isNaN(current) && current === expected) || String(node.updatedAt) === String(expectedUpdatedAt)) return;
  throw conflict(node.updatedAt);
}

function toDocument(node) {
  return {
    id: node.id,
    path: node.path,
    title: node.meta?.title ?? titleOf('', node.path),
    // Public documents read as workspace documents here; publishing is a
    // file system permission the document interface does not model.
    visibility: node.access === 'private' ? 'private' : 'org',
    createdBy: node.createdBy,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

const withMarkdown = ({node, body}) => ({...toDocument(node), markdown: body.toString('utf8')});
const isDocument = node => node.kind === 'file' && isMarkdown(node.path);

function createFsDocuments({fs}) {
  return Object.freeze({
    titleOf,
    async list(scope, {prefix} = {}) {
      return (await fs.list(scope, {prefix: prefixOf(prefix)})).filter(isDocument).map(toDocument);
    },
    async snapshot(scope, {prefix} = {}) {
      return (await fs.readMany(scope, {prefix: prefixOf(prefix), markdown: true}))
        .filter(isDocument)
        .map(row => withMarkdown({node: row, body: row.body}));
    },
    async get(scope, path) {
      const found = await fs.read(scope, checkPath(path));
      return found && isDocument(found.node) ? withMarkdown(found) : undefined;
    },
    async getById(scope, id) {
      const found = await fs.readById(scope, id);
      return found && isDocument(found.node) ? withMarkdown(found) : undefined;
    },
    async resolve(scope, urlPath) {
      const trimmed = String(urlPath ?? '').replace(/^\/+|\/+$/g, '');
      if (!trimmed) return undefined;
      const candidates = /\.mdx?$/.test(trimmed)
        ? [trimmed]
        : [`${trimmed}.md`, `${trimmed}.mdx`, `${trimmed}/index.md`, `${trimmed}/index.mdx`];
      const found = await fs.readMany(scope, {paths: candidates});
      const first = candidates.map(candidate => found.find(row => row.path === candidate)).find(Boolean);
      return first ? withMarkdown({node: first, body: first.body}) : undefined;
    },
    async create(scope, {path, markdown = '', visibility = 'org'}) {
      const clean = checkPath(path);
      if (!VISIBILITIES.includes(visibility)) throw new TypeError(`Not a visibility: ${visibility}`);
      try {
        const node = await fs.write(scope, clean, markdown, {baseRev: 0, ...(visibility === 'private' ? {access: 'private'} : {})});
        return {id: node.id, path: node.path, title: node.meta.title, visibility, createdAt: node.createdAt, updatedAt: node.updatedAt};
      } catch (error) {
        if (error.code === 'exists') throw pathTaken(clean);
        throw error;
      }
    },
    async save(scope, path, markdown, {expectedUpdatedAt} = {}) {
      const clean = checkPath(path);
      return fs.transaction(scope, async tree => {
        const current = await tree.nodeAt(clean, {lock: true});
        if (!current || !isDocument(current)) return undefined;
        assertCurrentRevision(current, expectedUpdatedAt);
        const node = await tree.write(clean, markdown, {baseRev: current.rev});
        return {...toDocument(node), markdown, version: node.rev};
      });
    },
    async setVisibility(scope, path, visibility) {
      if (!VISIBILITIES.includes(visibility)) throw new TypeError(`Not a visibility: ${visibility}`);
      const clean = checkPath(path);
      return fs.transaction(scope, async tree => {
        const current = await tree.nodeAt(clean, {lock: true});
        if (!current || !isDocument(current)) return undefined;
        if (current.createdBy && current.createdBy !== scope.userId) {
          const error = new Error('Only the author of a document may change who can read it');
          error.status = 403;
          error.code = 'not-author';
          throw error;
        }
        const node = await tree.setAccess(clean, visibility === 'private' ? 'private' : null);
        return {...toDocument(node), visibility};
      });
    },
    async move(scope, from, to) {
      const source = checkPath(from);
      const target = checkPath(to);
      return fs.transaction(scope, async tree => {
        const current = await tree.nodeAt(source, {lock: true});
        if (!current || !isDocument(current)) return undefined;
        try {
          return toDocument(await tree.move(source, target));
        } catch (error) {
          if (error.code === 'exists') throw pathTaken(target);
          throw error;
        }
      });
    },
    async remove(scope, path, {expectedUpdatedAt} = {}) {
      const clean = checkPath(path);
      return fs.transaction(scope, async tree => {
        const current = await tree.nodeAt(clean, {lock: true});
        if (!current || !isDocument(current)) return false;
        assertCurrentRevision(current, expectedUpdatedAt);
        await tree.remove(clean, {baseRev: current.rev});
        return true;
      });
    },
    async emptyTrash(scope) {
      return fs.emptyTrash(scope);
    },
    async versions(scope, path) {
      const history = await fs.history(scope, checkPath(path));
      if (!history) return undefined;
      return history.map(change => ({
        id: String(change.seq), seq: change.seq, authorId: change.actorId, createdAt: change.at, length: change.size,
      }));
    },
    async version(scope, path, seq) {
      const found = await fs.readRevision(scope, checkPath(path), seq);
      if (!found) return undefined;
      return {
        id: String(found.change.seq), seq: found.change.seq, markdown: found.body.toString('utf8'),
        authorId: found.change.actorId, createdAt: found.change.at,
      };
    },
  });
}

/**
 * The read side of the document repository for visitors: one workspace's
 * public documents, through the public reader. It has no write methods; the
 * content routes reach none for a viewer.
 */
function createPublicDocuments({publicFs, workspaceId}) {
  return Object.freeze({
    titleOf,
    async list(scope, {prefix} = {}) {
      return (await publicFs.list(workspaceId, {prefix: prefixOf(prefix)})).filter(isDocument).map(toDocument);
    },
    async snapshot(scope, {prefix} = {}) {
      return (await publicFs.readMany(workspaceId, {prefix: prefixOf(prefix), markdown: true}))
        .filter(isDocument)
        .map(row => withMarkdown({node: row, body: row.body}));
    },
    async get(scope, path) {
      const found = await publicFs.read(workspaceId, checkPath(path));
      return found && isDocument(found.node) ? withMarkdown(found) : undefined;
    },
    async resolve(scope, urlPath) {
      const trimmed = String(urlPath ?? '').replace(/^\/+|\/+$/g, '');
      if (!trimmed) return undefined;
      const candidates = /\.mdx?$/.test(trimmed)
        ? [trimmed]
        : [`${trimmed}.md`, `${trimmed}.mdx`, `${trimmed}/index.md`, `${trimmed}/index.mdx`];
      const found = await publicFs.readMany(workspaceId, {paths: candidates});
      const first = candidates.map(candidate => found.find(row => row.path === candidate)).find(Boolean);
      return first ? withMarkdown({node: first, body: first.body}) : undefined;
    },
  });
}

module.exports = {createFsDocuments, createPublicDocuments};
