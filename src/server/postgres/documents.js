const crypto = require('crypto');
const {withRequestContext} = require('./client');
const {titleOf} = require('../document-title');
const VISIBILITIES = Object.freeze(['org', 'private']);
const MAX_PATH_LENGTH = 400;

class NoWorkspaceError extends Error {
  constructor() {
    super('This action needs an active workspace');
    this.name = 'NoWorkspaceError';
    this.status = 409;
    this.code = 'no-workspace';
  }
}

function workspaceOf(context) {
  if (!context?.workspaceId || typeof context.workspaceId !== 'string') throw new NoWorkspaceError();
  return context.workspaceId;
}

function checkPath(value) {
  const input = String(value ?? '');
  const path = input.startsWith('content/') ? input.slice('content/'.length) : input;
  if (!path || path.length > MAX_PATH_LENGTH) throw new TypeError(`A document path must be 1 to ${MAX_PATH_LENGTH} characters`);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new TypeError(`Not a document path: ${path}`);
  return path;
}

function prefixOf(value) {
  if (value === undefined || value === null || value === '') return null;
  return checkPath(String(value).replace(/\/+$/, ''));
}

function createPostgresDocuments({pool, now = () => new Date().toISOString(), newId = () => crypto.randomUUID()}) {
  const inScope = (scope, operation) => withRequestContext(pool, {
    userId: scope?.userId,
    workspaceId: workspaceOf(scope),
  }, operation);
  const columns = `id, path, title, visibility, created_by as "createdBy",
    created_at as "createdAt", updated_at as "updatedAt"`;

  const api = {
    titleOf,
    async list(scope, {prefix} = {}) {
      const cleanPrefix = prefixOf(prefix);
      return inScope(scope, async client => (await client.query(
        `select ${columns} from document
          where deleted_at is null${cleanPrefix ? " and left(path, char_length($1) + 1) = $1 || '/'" : ''}
          order by path`,
        cleanPrefix ? [cleanPrefix] : [],
      )).rows);
    },
    async snapshot(scope, {prefix} = {}) {
      const cleanPrefix = prefixOf(prefix);
      return inScope(scope, async client => (await client.query(
        `select ${columns}, markdown from document
          where deleted_at is null${cleanPrefix ? " and left(path, char_length($1) + 1) = $1 || '/'" : ''}
          order by path`,
        cleanPrefix ? [cleanPrefix] : [],
      )).rows);
    },
    async get(scope, path) {
      return inScope(scope, async client => (await client.query(
        `select ${columns}, markdown from document where deleted_at is null and path = $1 limit 1`,
        [checkPath(path)],
      )).rows[0]);
    },
    async getById(scope, id) {
      return inScope(scope, async client => (await client.query(
        `select ${columns}, markdown from document where deleted_at is null and id = $1 limit 1`, [id],
      )).rows[0]);
    },
    async resolve(scope, urlPath) {
      const trimmed = String(urlPath ?? '').replace(/^\/+|\/+$/g, '');
      if (!trimmed) return undefined;
      const candidates = /\.mdx?$/.test(trimmed)
        ? [trimmed]
        : [`${trimmed}.md`, `${trimmed}.mdx`, `${trimmed}/index.md`, `${trimmed}/index.mdx`];
      return inScope(scope, async client => (await client.query(
        `select ${columns}, markdown from document
          where deleted_at is null and path = any($1::text[])
          order by array_position($1::text[], path) limit 1`, [candidates],
      )).rows[0]);
    },
    async create(scope, {path, markdown = '', visibility = 'org'}) {
      const workspaceId = workspaceOf(scope);
      const clean = checkPath(path);
      if (!VISIBILITIES.includes(visibility)) throw new TypeError(`Not a visibility: ${visibility}`);
      return inScope(scope, async client => {
        const taken = await client.query(
          'select 1 from document where workspace_id = $1 and path = $2 and deleted_at is null',
          [workspaceId, clean],
        );
        if (taken.rowCount) {
          const error = new Error(`A document already exists at ${clean}`);
          error.status = 409;
          error.code = 'path-taken';
          throw error;
        }
        const at = now();
        const id = newId();
        const title = titleOf(markdown, clean);
        try {
          await client.query(
            `insert into document(id, workspace_id, path, title, markdown, visibility, created_by, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
            [id, workspaceId, clean, title, markdown, visibility, scope.userId, at],
          );
        } catch (error) {
          if (error?.code !== '23505') throw error;
          const taken = new Error(`A document already exists at ${clean}`);
          taken.status = 409;
          taken.code = 'path-taken';
          throw taken;
        }
        return {id, path: clean, title, visibility, createdAt: at, updatedAt: at};
      });
    },
    async save(scope, path, markdown) {
      return inScope(scope, async client => {
        const current = (await client.query(
          `select ${columns}, markdown from document where deleted_at is null and path = $1 for update`,
          [checkPath(path)],
        )).rows[0];
        if (!current) return undefined;
        const seq = Number((await client.query(
          'select coalesce(max(seq), 0) + 1 as seq from document_version where document_id = $1', [current.id],
        )).rows[0].seq);
        const at = now();
        await client.query(
          `insert into document_version(id, workspace_id, document_id, seq, markdown, author_id, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [newId(), workspaceOf(scope), current.id, seq, current.markdown, scope.userId, at],
        );
        const title = titleOf(markdown, current.path);
        await client.query('update document set markdown = $1, title = $2, updated_at = $3 where id = $4',
          [markdown, title, at, current.id]);
        return {...current, markdown, title, updatedAt: at, version: seq};
      });
    },
    async setVisibility(scope, path, visibility) {
      if (!VISIBILITIES.includes(visibility)) throw new TypeError(`Not a visibility: ${visibility}`);
      return inScope(scope, async client => {
        const current = (await client.query(
          `select ${columns}, markdown from document where deleted_at is null and path = $1 for update`,
          [checkPath(path)],
        )).rows[0];
        if (!current) return undefined;
        if (current.createdBy && current.createdBy !== scope.userId) {
          const error = new Error('Only the author of a document may change who can read it');
          error.status = 403;
          error.code = 'not-author';
          throw error;
        }
        await client.query('update document set visibility = $1, updated_at = $2 where id = $3', [visibility, now(), current.id]);
        return {...current, visibility};
      });
    },
    async move(scope, from, to) {
      const clean = checkPath(to);
      return inScope(scope, async client => {
        const current = (await client.query(
          `select ${columns}, markdown from document where deleted_at is null and path = $1 for update`, [checkPath(from)],
        )).rows[0];
        if (!current) return undefined;
        const taken = await client.query('select 1 from document where path = $1 and deleted_at is null', [clean]);
        if (taken.rowCount) {
          const error = new Error(`A document already exists at ${clean}`);
          error.status = 409;
          error.code = 'path-taken';
          throw error;
        }
        const at = now();
        try {
          await client.query('update document set path = $1, title = $2, updated_at = $3 where id = $4',
            [clean, titleOf(current.markdown, clean), at, current.id]);
        } catch (error) {
          if (error?.code !== '23505') throw error;
          const conflict = new Error(`A document already exists at ${clean}`);
          conflict.status = 409;
          conflict.code = 'path-taken';
          throw conflict;
        }
        return {...current, path: clean, updatedAt: at};
      });
    },
    async remove(scope, path) {
      return inScope(scope, async client => (await client.query(
        'update document set deleted_at = $1 where path = $2 and deleted_at is null', [now(), checkPath(path)],
      )).rowCount > 0);
    },
    async emptyTrash(scope) {
      return inScope(scope, async client => (await client.query('delete from document where deleted_at is not null')).rowCount);
    },
    async versions(scope, path) {
      return inScope(scope, async client => {
        const current = (await client.query('select id from document where path = $1 and deleted_at is null', [checkPath(path)])).rows[0];
        if (!current) return undefined;
        return (await client.query(
          `select id, seq, author_id as "authorId", created_at as "createdAt", length(markdown) as length
             from document_version where document_id = $1 order by seq desc`, [current.id],
        )).rows;
      });
    },
    async version(scope, path, seq) {
      return inScope(scope, async client => {
        const current = (await client.query('select id from document where path = $1 and deleted_at is null', [checkPath(path)])).rows[0];
        if (!current) return undefined;
        return (await client.query(
          `select id, seq, markdown, author_id as "authorId", created_at as "createdAt"
             from document_version where document_id = $1 and seq = $2`, [current.id, seq],
        )).rows[0];
      });
    },
  };
  return Object.freeze(api);
}

module.exports = {createPostgresDocuments, titleOf, checkPath, prefixOf};
