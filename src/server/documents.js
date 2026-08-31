/**
 * Content, read and written through the database rather than the filesystem.
 *
 * The same rule as ./store: every function takes the caller's scope and applies
 * the organization itself, so a handler cannot name another workspace's page
 * and cannot forget to say which workspace it means. Content gets its own
 * module rather than a store domain because it needs columns a JSON value
 * cannot give it: a version history, a visibility, a title to list by, and
 * eventually a Yjs update alongside the text.
 *
 * Visibility is the one thing here that ./store has no equivalent of. A store
 * item is one person's or the workspace's, decided per domain and fixed. A
 * document is the workspace's by default and can be made private per document,
 * because a draft is a normal thing to have and a lab's pages are normally the
 * lab's. So the read predicate is not "whose is it" but "may this caller see
 * it", and it is applied in SQL rather than by filtering afterwards: a page
 * somebody may not read should not be a row that reached the process.
 */
const crypto = require('crypto');

/** Raised when a caller has no workspace to read or write content in. */
class NoWorkspaceError extends Error {
  constructor() {
    super('This action needs an active workspace');
    this.name = 'NoWorkspaceError';
    this.status = 409;
    this.code = 'no-workspace';
  }
}

/** What a document may be visible to. */
const VISIBILITIES = Object.freeze(['org', 'private']);

/**
 * Paths are workspace-relative and go into URLs, so the same shape the file
 * handlers already enforce: no leading slash, no traversal, no backslashes.
 * Checked here as well as at the route, because this module is reachable from
 * the importer and from the CLI too.
 */
const MAX_PATH_LENGTH = 400;

function checkPath(value) {
  const input = String(value ?? '');
  const path = input.startsWith('content/') ? input.slice('content/'.length) : input;
  if (!path || path.length > MAX_PATH_LENGTH) {
    throw new TypeError(`A document path must be 1 to ${MAX_PATH_LENGTH} characters`);
  }
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new TypeError(`Not a document path: ${path}`);
  }
  return path;
}

function workspaceOf(context) {
  const workspaceId = context?.workspaceId;
  if (!workspaceId || typeof workspaceId !== 'string') throw new NoWorkspaceError();
  return workspaceId;
}

/**
 * The title a document lists under, taken from its frontmatter and falling back
 * to its filename.
 *
 * Derived on write rather than on read, so listing a tree of several hundred
 * pages is a column read instead of several hundred regex passes over bodies
 * the caller did not ask for.
 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;

function titleOf(markdown, path) {
  const frontmatter = String(markdown ?? '').match(FRONTMATTER_RE);
  const titled = frontmatter?.[1].match(TITLE_RE);
  if (titled) return titled[1];
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.mdx?$/, '');
}

/**
 * Build the document layer over `db`. Exported so tests and the importer can
 * drive a throwaway database, and so the eventual Postgres connection is an
 * argument rather than a rewrite. Same shape as store's createStore.
 */
function createDocuments({db = require('./db').db, now = () => new Date().toISOString(), newId = () => crypto.randomUUID()} = {}) {
  // A caller sees a document if it belongs to their workspace AND either it is
  // visible to the workspace or they are the one who made it. Written once and
  // reused, because a read that got it wrong would be the whole point of the
  // module going missing.
  const VISIBLE = `"organizationId" = ? AND "deletedAt" IS NULL
                   AND ("visibility" = 'org' OR "createdBy" = ?)`;

  const columns = '"id", "path", "title", "visibility", "createdBy", "createdAt", "updatedAt"';

  const statements = {
    list: db.prepare(`SELECT ${columns} FROM document WHERE ${VISIBLE} ORDER BY "path"`),
    get: db.prepare(`SELECT ${columns}, "markdown" FROM document WHERE ${VISIBLE} AND "path" = ?`),
    getById: db.prepare(`SELECT ${columns}, "markdown" FROM document WHERE ${VISIBLE} AND "id" = ?`),
    // Deliberately not visibility-scoped: a path is taken or it is not, and a
    // create that succeeded because it could not see the private page already
    // there would fail on the unique index a moment later with a worse message.
    pathTaken: db.prepare(
      'SELECT "id", "createdBy" FROM document WHERE "organizationId" = ? AND "path" = ? AND "deletedAt" IS NULL',
    ),
    insert: db.prepare(
      `INSERT INTO document
         ("id", "organizationId", "path", "title", "markdown", "visibility", "createdBy", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    update: db.prepare(
      'UPDATE document SET "markdown" = ?, "title" = ?, "updatedAt" = ? WHERE "id" = ?',
    ),
    setVisibility: db.prepare('UPDATE document SET "visibility" = ?, "updatedAt" = ? WHERE "id" = ?'),
    move: db.prepare('UPDATE document SET "path" = ?, "title" = ?, "updatedAt" = ? WHERE "id" = ?'),
    softDelete: db.prepare('UPDATE document SET "deletedAt" = ? WHERE "id" = ?'),
    countDeleted: db.prepare(
      'SELECT COUNT(*) AS count FROM document WHERE "organizationId" = ? AND "deletedAt" IS NOT NULL',
    ),
    purgeDeleted: db.prepare(
      'DELETE FROM document WHERE "organizationId" = ? AND "deletedAt" IS NOT NULL',
    ),

    nextSeq: db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM document_version WHERE "documentId" = ?'),
    addVersion: db.prepare(
      `INSERT INTO document_version ("id", "documentId", "seq", "markdown", "authorId", "createdAt")
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    listVersions: db.prepare(
      `SELECT "id", "seq", "authorId", "createdAt", length("markdown") AS "length"
         FROM document_version WHERE "documentId" = ? ORDER BY "seq" DESC`,
    ),
    getVersion: db.prepare(
      'SELECT "id", "seq", "markdown", "authorId", "createdAt" FROM document_version WHERE "documentId" = ? AND "seq" = ?',
    ),
  };

  /** Every document in scope the caller may read, without their bodies. */
  function list(scope) {
    return statements.list.all(workspaceOf(scope), scope?.userId ?? null);
  }

  /** All visible document metadata and bodies in one scoped query. */
  function snapshot(scope) {
    return list(scope).map(row => get(scope, row.path)).filter(Boolean);
  }

  /** One document by path, with its body, or undefined. */
  function get(scope, path) {
    return statements.get.get(workspaceOf(scope), scope?.userId ?? null, checkPath(path)) ?? undefined;
  }

  /**
   * The document a URL means.
   *
   * A reader asks for /w/books/math/0-intro, not for a filename, so the
   * extension and the index convention have to be resolved somewhere. Here
   * rather than in the client, because the client would have to guess and then
   * ask up to four times to find out which guess was right, and because these
   * are the same four forms the build already resolves.
   *
   * An exact path still wins, so a caller that does know the filename is not
   * made to go through this.
   */
  function resolve(scope, urlPath) {
    const trimmed = String(urlPath ?? '').replace(/^\/+|\/+$/g, '');
    if (!trimmed) return undefined;
    const candidates = /\.mdx?$/.test(trimmed)
      ? [trimmed]
      : [`${trimmed}.md`, `${trimmed}.mdx`, `${trimmed}/index.md`, `${trimmed}/index.mdx`];
    for (const candidate of candidates) {
      const found = get(scope, candidate);
      if (found) return found;
    }
    return undefined;
  }

  /** One document by id, with its body, or undefined. */
  function getById(scope, id) {
    return statements.getById.get(workspaceOf(scope), scope?.userId ?? null, id) ?? undefined;
  }

  /**
   * Create a document. Throws if the path is taken, which the unique index
   * would also do; asking first is what makes the message about the path.
   */
  function create(scope, {path, markdown = '', visibility = 'org'}) {
    const workspaceId = workspaceOf(scope);
    const clean = checkPath(path);
    if (!VISIBILITIES.includes(visibility)) {
      throw new TypeError(`Not a visibility: ${visibility}`);
    }
    if (statements.pathTaken.get(workspaceId, clean)) {
      const taken = new Error(`A document already exists at ${clean}`);
      taken.status = 409;
      taken.code = 'path-taken';
      throw taken;
    }
    const at = now();
    const id = newId();
    statements.insert.run(
      id, workspaceId, clean, titleOf(markdown, clean), markdown, visibility, scope?.userId ?? null, at, at,
    );
    return {id, path: clean, title: titleOf(markdown, clean), visibility, createdAt: at, updatedAt: at};
  }

  /**
   * Replace a document's body, keeping what it replaced.
   *
   * The version and the update are one transaction: a history with a gap where
   * a save half-succeeded is worse than no history, because it reads as though
   * that edit never happened.
   */
  function save(scope, path, markdown) {
    const current = get(scope, path);
    if (!current) return undefined;
    const at = now();
    const run = db.transaction(() => {
      const {seq} = statements.nextSeq.get(current.id);
      statements.addVersion.run(newId(), current.id, seq, current.markdown, scope?.userId ?? null, at);
      statements.update.run(markdown, titleOf(markdown, current.path), at, current.id);
      return seq;
    });
    const seq = run();
    return {...current, markdown, title: titleOf(markdown, current.path), updatedAt: at, version: seq};
  }

  /** Change who may read a document. Only its author may. */
  function setVisibility(scope, path, visibility) {
    if (!VISIBILITIES.includes(visibility)) throw new TypeError(`Not a visibility: ${visibility}`);
    const current = get(scope, path);
    if (!current) return undefined;
    if (current.createdBy && current.createdBy !== scope?.userId) {
      const refused = new Error('Only the author of a document may change who can read it');
      refused.status = 403;
      refused.code = 'not-author';
      throw refused;
    }
    statements.setVisibility.run(visibility, now(), current.id);
    return {...current, visibility};
  }

  /** Move a document to another path in the same workspace. */
  function move(scope, from, to) {
    const workspaceId = workspaceOf(scope);
    const current = get(scope, from);
    if (!current) return undefined;
    const clean = checkPath(to);
    if (statements.pathTaken.get(workspaceId, clean)) {
      const taken = new Error(`A document already exists at ${clean}`);
      taken.status = 409;
      taken.code = 'path-taken';
      throw taken;
    }
    const at = now();
    statements.move.run(clean, titleOf(current.markdown, clean), at, current.id);
    return {...current, path: clean, updatedAt: at};
  }

  /** Soft-delete a document, freeing its path. True when there was one. */
  function remove(scope, path) {
    const current = get(scope, path);
    if (!current) return false;
    statements.softDelete.run(now(), current.id);
    return true;
  }

  /** Permanently remove only this workspace's already-soft-deleted documents. */
  function emptyTrash(scope) {
    const workspaceId = workspaceOf(scope);
    const count = statements.countDeleted.get(workspaceId).count;
    statements.purgeDeleted.run(workspaceId);
    return count;
  }

  /** A document's history, newest first, without the bodies. */
  function versions(scope, path) {
    const current = get(scope, path);
    if (!current) return undefined;
    return statements.listVersions.all(current.id);
  }

  /** One past version of a document, with its body. */
  function version(scope, path, seq) {
    const current = get(scope, path);
    if (!current) return undefined;
    return statements.getVersion.get(current.id, seq) ?? undefined;
  }

  return {
    list, snapshot, get, getById, resolve, create, save, setVisibility, move, remove, emptyTrash,
    versions, version, titleOf, db,
  };
}

const documents = createDocuments();

module.exports = {
  ...documents,
  createDocuments,
  NoWorkspaceError,
  VISIBILITIES,
  MAX_PATH_LENGTH,
};
