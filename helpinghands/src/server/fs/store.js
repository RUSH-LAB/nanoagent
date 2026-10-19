'use strict';

/**
 * The workspace file system on PostgreSQL (docs/plans/workspace-filesystem.md).
 *
 * A workspace is a tree of nodes, files and folders, each with a stable id.
 * File bytes live once per workspace in fs_content, addressed by SHA-256, and
 * every change is appended to fs_change. A node's `rev` is the seq of its last
 * change, so the log orders every revision and a write naming a stale `baseRev`
 * is refused rather than lost.
 *
 * Every operation runs in one transaction inside the caller's request context,
 * so row-level security decides what is visible and writable. Anonymous
 * readers use `publicReader`, which sees only public nodes.
 */
const crypto = require('crypto');
const path = require('path');
const {withRequestContext} = require('../postgres/client');
const {titleOf} = require('../document-title');

const ACCESS = Object.freeze(['workspace', 'private', 'shared', 'public']);
const MAX_PATH_LENGTH = 400;
const MARKDOWN = /\.mdx?$/i;
const CONTENT_TYPES = Object.freeze({
  '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.bib': 'text/x-bibtex; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.lean': 'text/plain; charset=utf-8',
  '.tex': 'text/x-tex; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
});

class FsError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'FsError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/** A workspace-relative path: no leading or trailing slash, no empty, `.` or `..` segment. */
function cleanPath(value) {
  const input = String(value ?? '').replace(/^\/+|\/+$/g, '');
  if (!input || input.length > MAX_PATH_LENGTH) {
    throw new FsError(400, 'bad-path', `A path must be 1 to ${MAX_PATH_LENGTH} characters`);
  }
  if (input.includes('\\') || input.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new FsError(400, 'bad-path', `Not a workspace path: ${input}`);
  }
  return input;
}

function cleanPrefix(value) {
  if (value === undefined || value === null || value === '') return null;
  return cleanPath(value);
}

const parentOf = value => (value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : null);
const sha256 = body => crypto.createHash('sha256').update(body).digest('hex');
const contentTypeFor = value => CONTENT_TYPES[path.posix.extname(value).toLowerCase()] ?? 'application/octet-stream';
const isMarkdown = value => MARKDOWN.test(value);
// App state (records, chat, plugin blobs) is under a segment starting with a dot: the services
// that own it write it, and the Explorer and sync clients leave it out (docs/plans/filesystem-layout.md).
const isAppState = value => value.split('/').some(part => part.startsWith('.'));
// A change clients are told of: one not to app state, or a move out of sight, so they drop the old path.
const isShownChange = change => !isAppState(change.path) || Boolean(change.fromPath && !isAppState(change.fromPath));
// The content types searched as text (readMany's `text`), as the workbench opens them as text.
const TEXT_TYPES = /^(text\/|application\/(json|yaml|javascript|x-))/;
// node-postgres returns bytea as a Buffer; other drivers return a Uint8Array.
const asBuffer = value => (value == null || Buffer.isBuffer(value) ? value : Buffer.from(value));

/** What the file system derives from a file's content when it is written. */
function metaFor(nodePath, body) {
  return isMarkdown(nodePath) ? {title: titleOf(body.toString('utf8'), nodePath)} : {};
}

const NODE_COLUMNS = `n.id, n.path, n.kind, n.content_hash as "contentHash", n.size::float8 as size,
  n.content_type as "contentType", n.access, n.access_explicit as "accessExplicit", n.owner_id as "ownerId",
  n.share_root as "shareRoot",
  n.meta, n.rev::float8 as rev, n.created_by as "createdBy", n.created_at as "createdAt",
  n.updated_at as "updatedAt", n.deleted_at as "deletedAt"`;
const CHANGE_COLUMNS = `c.seq::float8 as seq, c.node_id as "nodeId", c.op, c.path, c.from_path as "fromPath",
  c.kind, c.content_hash as "contentHash", c.access, c.actor_id as "actorId", c.at`;

const underPrefix = (column, parameter) => `(${column} = ${parameter} or left(${column}, char_length(${parameter}) + 1) = ${parameter} || '/')`;

function requireWorkspace(scope) {
  if (!scope?.workspaceId || typeof scope.workspaceId !== 'string') {
    throw new FsError(409, 'no-workspace', 'This action needs an active workspace');
  }
  return scope.workspaceId;
}

function checkRev(node, baseRev) {
  if (baseRev === undefined || baseRev === null) return;
  if (Number(baseRev) !== node.rev) {
    throw new FsError(409, 'stale-revision', `${node.path} changed after revision ${baseRev}; reload before saving.`, {
      currentRev: node.rev,
    });
  }
}

function uniqueViolation(error, nodePath) {
  return error?.code === '23505'
    ? new FsError(409, 'exists', `Something already exists at ${nodePath}`)
    : error;
}

/** One transaction's file system operations, bound to its client and scope. `logged` is told of each change. */
function operations(client, scope, logged = () => {}) {
  const workspaceId = requireWorkspace(scope);

  async function nodeAt(nodePath, {lock = false} = {}) {
    return (await client.query(
      `select ${NODE_COLUMNS} from fs_node n where n.deleted_at is null and n.path = $1${lock ? ' for update' : ''}`,
      [nodePath],
    )).rows[0] ?? null;
  }

  async function log(node, op, {fromPath = null} = {}) {
    const seq = Number((await client.query(
      `insert into fs_change(workspace_id, node_id, op, path, from_path, kind, content_hash, access, actor_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning seq`,
      [workspaceId, node.id, op, node.path, fromPath, node.kind, node.contentHash, node.access, scope.userId],
    )).rows[0].seq);
    await client.query('update fs_node set rev = $1 where id = $2', [seq, node.id]);
    node.rev = seq;
    logged();
    return seq;
  }

  /** The folder at `folderPath`, created with any missing ancestors; null for the root. */
  async function ensureFolder(folderPath) {
    if (!folderPath) return null;
    const existing = await nodeAt(folderPath);
    if (existing) {
      if (existing.kind !== 'folder') throw new FsError(409, 'not-a-folder', `${folderPath} is a file`);
      return existing;
    }
    const parent = await ensureFolder(parentOf(folderPath));
    // A member's home is private to them from the moment it is made, and only they make it
    // (migration 0044 refuses any other).
    const home = /^home\/([^/]+)$/.exec(folderPath)?.[1];
    if (home && home !== scope.userId) throw new FsError(403, 'not-your-home', `${folderPath} is another member's home`);
    return insertNode({nodePath: folderPath, kind: 'folder', parent, access: home ? 'private' : undefined});
  }

  async function insertNode({nodePath, kind, parent, content = null, contentType = null, meta = {}, access, id}) {
    const inherited = parent?.access ?? 'workspace';
    const effective = access ?? inherited;
    const node = {
      id: id ?? crypto.randomUUID(),
      path: nodePath,
      kind,
      contentHash: content?.hash ?? null,
      size: content?.size ?? 0,
      contentType,
      access: effective,
      accessExplicit: access !== undefined && access !== inherited,
      // A private or shared node belongs to whoever set that: its own creator,
      // or the owner of the folder it inherits from.
      ownerId: ['private', 'shared'].includes(effective) && !access ? parent.ownerId : scope.userId,
      shareRoot: effective === 'shared' ? parent.shareRoot : null,
      meta,
      createdBy: scope.userId,
    };
    try {
      const row = (await client.query(
        `insert into fs_node(id, workspace_id, path, kind, content_hash, size, content_type, access, access_explicit,
                             owner_id, share_root, meta, rev, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13)
         returning created_at as "createdAt", updated_at as "updatedAt"`,
        [node.id, workspaceId, node.path, node.kind, node.contentHash, node.size, node.contentType, node.access,
          node.accessExplicit, node.ownerId, node.shareRoot, JSON.stringify(node.meta), node.createdBy],
      )).rows[0];
      Object.assign(node, row, {deletedAt: null});
    } catch (error) {
      throw uniqueViolation(error, nodePath);
    }
    await log(node, 'create');
    return node;
  }

  async function putContent(body) {
    const hash = sha256(body);
    await client.query(
      `insert into fs_content(workspace_id, hash, body, size) values ($1, $2, $3, $4)
       on conflict (workspace_id, hash) do nothing`,
      [workspaceId, hash, body, body.length],
    );
    return {hash, size: body.length};
  }

  async function subtree(root) {
    return (await client.query(
      `select ${NODE_COLUMNS} from fs_node n where n.deleted_at is null and ${underPrefix('n.path', '$1')}
        order by n.path for update`,
      [root],
    )).rows;
  }

  /**
   * Make `root`'s share list exactly `members`. New members are added before
   * dropped ones are removed: the caller must still see the node while the
   * list changes, even when they are leaving it.
   */
  async function replaceShares(root, members) {
    const wanted = [...new Set(members.map(String))];
    for (const userId of wanted) {
      await client.query(
        'insert into fs_share(node_id, workspace_id, user_id) values ($1, $2, $3) on conflict do nothing',
        [root, workspaceId, userId],
      );
    }
    await client.query('delete from fs_share where node_id = $1 and user_id <> all($2::text[])', [root, wanted]);
  }

  /** Re-derive inherited access below (and including) `root` after its folder or its own access changed. */
  async function inheritAccess(root) {
    const nodes = await subtree(root.path);
    const parent = parentOf(root.path) ? await nodeAt(parentOf(root.path)) : null;
    const effective = new Map([[parentOf(root.path), {
      access: parent?.access ?? 'workspace', ownerId: parent?.ownerId ?? null, shareRoot: parent?.shareRoot ?? null,
    }]]);
    for (const node of nodes) {
      const above = effective.get(parentOf(node.path)) ?? {access: 'workspace', ownerId: null, shareRoot: null};
      const next = node.accessExplicit
        ? {access: node.access, ownerId: node.ownerId, shareRoot: node.access === 'shared' ? node.id : null}
        : {
          access: above.access,
          ownerId: ['private', 'shared'].includes(above.access) ? above.ownerId : node.ownerId,
          shareRoot: above.access === 'shared' ? above.shareRoot : null,
        };
      effective.set(node.path, next);
      if (next.access === node.access && next.ownerId === node.ownerId && next.shareRoot === node.shareRoot) continue;
      await client.query('update fs_node set access = $1, owner_id = $2, share_root = $3, updated_at = now() where id = $4',
        [next.access, next.ownerId, next.shareRoot, node.id]);
      Object.assign(node, next);
      await log(node, 'access');
    }
  }

  return {
    nodeAt,
    /** Run SQL in this transaction, for modules that keep data beside the nodes (fs/crdt.js). */
    query: (sql, parameters) => client.query(sql, parameters),

    async list({prefix, deleted = false} = {}) {
      const clean = cleanPrefix(prefix);
      return (await client.query(
        `select ${NODE_COLUMNS} from fs_node n
          where n.deleted_at is ${deleted ? 'not ' : ''}null${clean ? ` and ${underPrefix('n.path', '$1')}` : ''}
          order by n.path`,
        clean ? [clean] : [],
      )).rows;
    },

    // `markdown` keeps the read to Markdown files in the database, so the
    // bytes of the images and other files beside them never leave it; `text`
    // keeps it to text files of at most that many bytes, for a search.
    async readMany({prefix, paths, markdown = false, text = null} = {}) {
      const clean = cleanPrefix(prefix);
      const parameters = paths ? [paths.map(cleanPath)] : clean ? [clean] : [];
      const filter = (paths ? ' and n.path = any($1::text[])' : clean ? ` and ${underPrefix('n.path', '$1')}` : '')
        + (markdown ? ` and n.path ~* '${MARKDOWN.source}'` : '')
        + (text ? ` and n.content_type ~ '${TEXT_TYPES.source}' and n.size <= ${Number(text)}` : '');
      return (await client.query(
        `select ${NODE_COLUMNS}, c.body from fs_node n
           join fs_content c on c.workspace_id = n.workspace_id and c.hash = n.content_hash
          where n.deleted_at is null and n.kind = 'file'${filter}
          order by n.path`,
        parameters,
      )).rows.map(row => ({...row, body: asBuffer(row.body)}));
    },

    async byId(id) {
      return (await client.query(`select ${NODE_COLUMNS} from fs_node n where n.id = $1`, [String(id)])).rows[0] ?? null;
    },

    async bodyOf(hash) {
      return asBuffer((await client.query(
        'select body from fs_content where workspace_id = $1 and hash = $2', [workspaceId, hash],
      )).rows[0]?.body ?? null);
    },

    async write(nodePath, body, {contentType, baseRev, access, id} = {}) {
      const clean = cleanPath(nodePath);
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
      const existing = await nodeAt(clean, {lock: true});
      if (existing?.kind === 'folder') throw new FsError(409, 'is-a-folder', `${clean} is a folder`);
      if (!existing && baseRev !== undefined && baseRev !== null && Number(baseRev) !== 0) {
        throw new FsError(409, 'stale-revision', `${clean} no longer exists`, {currentRev: 0});
      }
      if (existing && Number(baseRev) === 0) throw new FsError(409, 'exists', `Something already exists at ${clean}`);
      if (existing) checkRev(existing, baseRev);
      const content = await putContent(payload);
      const type = contentType ?? existing?.contentType ?? contentTypeFor(clean);
      const meta = metaFor(clean, payload);
      if (!existing) {
        const parent = await ensureFolder(parentOf(clean));
        return insertNode({nodePath: clean, kind: 'file', parent, content, contentType: type, meta, access, id});
      }
      const row = (await client.query(
        `update fs_node set content_hash = $1, size = $2, content_type = $3, meta = $4, updated_at = now()
          where id = $5 returning updated_at as "updatedAt"`,
        [content.hash, content.size, type, JSON.stringify(meta), existing.id],
      )).rows[0];
      const node = {...existing, contentHash: content.hash, size: content.size, contentType: type, meta, ...row};
      await log(node, 'write');
      return node;
    },

    async mkdir(folderPath) {
      return ensureFolder(cleanPath(folderPath));
    },

    async move(from, to, {baseRev} = {}) {
      const source = cleanPath(from);
      const target = cleanPath(to);
      if (target === source) throw new FsError(400, 'bad-path', 'A node cannot move onto itself');
      if (target.startsWith(`${source}/`)) throw new FsError(400, 'bad-path', 'A folder cannot move inside itself');
      const node = await nodeAt(source, {lock: true});
      if (!node) throw new FsError(404, 'not-found', `Nothing at ${source}`);
      checkRev(node, baseRev);
      if (await nodeAt(target)) throw new FsError(409, 'exists', `Something already exists at ${target}`);
      await ensureFolder(parentOf(target));
      const moving = node.kind === 'folder' ? await subtree(source) : [node];
      for (const each of moving) {
        const fromPath = each.path;
        each.path = target + fromPath.slice(source.length);
        // A Markdown title may come from the file name, so it is derived again.
        if (each.kind === 'file') each.meta = metaFor(each.path, await this.bodyOf(each.contentHash));
        try {
          const row = (await client.query(
            'update fs_node set path = $1, meta = $2, updated_at = now() where id = $3 returning updated_at as "updatedAt"',
            [each.path, JSON.stringify(each.meta), each.id],
          )).rows[0];
          Object.assign(each, row);
        } catch (error) {
          throw uniqueViolation(error, each.path);
        }
        await log(each, 'move', {fromPath});
      }
      const moved = moving.find(each => each.id === node.id);
      await inheritAccess(moved);
      return (await nodeAt(target));
    },

    async remove(nodePath, {baseRev} = {}) {
      const clean = cleanPath(nodePath);
      const node = await nodeAt(clean, {lock: true});
      if (!node) return null;
      checkRev(node, baseRev);
      const removing = node.kind === 'folder' ? await subtree(clean) : [node];
      const at = (await client.query('select now() as at')).rows[0].at;
      for (const each of removing) {
        await client.query('update fs_node set deleted_at = $1 where id = $2', [at, each.id]);
        each.deletedAt = at;
        await log(each, 'delete');
      }
      return node;
    },

    async restore(id) {
      const node = await this.byId(id);
      if (!node?.deletedAt) throw new FsError(404, 'not-found', 'Nothing in the trash with that id');
      if (await nodeAt(node.path)) throw new FsError(409, 'exists', `Something already exists at ${node.path}`);
      await ensureFolder(parentOf(node.path));
      // A folder comes back with what was deleted along with it.
      const restoring = (await client.query(
        `select ${NODE_COLUMNS} from fs_node n where n.deleted_at = $1 and ${underPrefix('n.path', '$2')} order by n.path`,
        [node.deletedAt, node.path],
      )).rows.filter(each => each.id === node.id || node.kind === 'folder');
      for (const each of restoring) {
        try {
          await client.query('update fs_node set deleted_at = null, updated_at = now() where id = $1', [each.id]);
        } catch (error) {
          throw uniqueViolation(error, each.path);
        }
        each.deletedAt = null;
        await log(each, 'restore');
      }
      await inheritAccess(await nodeAt(node.path));
      return nodeAt(node.path);
    },

    async emptyTrash() {
      return (await client.query('delete from fs_node where deleted_at is not null')).rowCount;
    },

    /**
     * Set `access` on a node, or pass null to inherit its folder's again.
     * `shared` takes the `members` it is shared with; the owner is whoever
     * shares it, and sees it whether listed or not, unless `unowned`, when
     * exactly the members do (a chat channel, which its creator may leave).
     */
    async setAccess(nodePath, access, {members = [], unowned = false} = {}) {
      if (access !== null && !ACCESS.includes(access)) throw new FsError(400, 'bad-access', `Not an access level: ${access}`);
      const clean = cleanPath(nodePath);
      const node = await nodeAt(clean, {lock: true});
      if (!node) throw new FsError(404, 'not-found', `Nothing at ${clean}`);
      if (access === null) {
        await client.query('update fs_node set access_explicit = false where id = $1', [node.id]);
        node.accessExplicit = false;
      } else {
        const owned = ['private', 'shared'].includes(access);
        const ownerId = access === 'shared' && unowned ? null : owned ? scope.userId : node.ownerId;
        // An owned share lists its sharer too, so they keep it in either case.
        await replaceShares(node.id, access === 'shared' ? [...(unowned ? [] : [scope.userId]), ...members] : []);
        await client.query(
          `update fs_node set access = $1, access_explicit = true, owner_id = $2, share_root = $3, updated_at = now()
            where id = $4`,
          [access, ownerId, access === 'shared' ? node.id : null, node.id],
        );
        Object.assign(node, {access, accessExplicit: true, ownerId, shareRoot: access === 'shared' ? node.id : null});
        await log(node, 'access');
      }
      await inheritAccess(node);
      return nodeAt(clean);
    },

    /** Replace who the shared node at `nodePath` is shared with, keeping its owner. */
    async shareWith(nodePath, members) {
      const node = await nodeAt(cleanPath(nodePath), {lock: true});
      if (!node || node.access !== 'shared') throw new FsError(409, 'not-shared', `${nodePath} is not shared`);
      // Logged first: a member leaving the list can no longer see the node after.
      await log(node, 'access');
      await replaceShares(node.shareRoot, members);
      return node;
    },

    /** Who the node at `nodePath` is shared with, or null when it is not shared. */
    async sharedWith(nodePath) {
      const node = await nodeAt(cleanPath(nodePath));
      if (!node || node.access !== 'shared') return null;
      return (await client.query('select user_id as "userId" from fs_share where node_id = $1 order by user_id',
        [node.shareRoot])).rows.map(row => row.userId);
    },

    /** Every revision of the node at `nodePath`, newest first. */
    async history(nodePath) {
      const node = await nodeAt(cleanPath(nodePath));
      if (!node) return null;
      return (await client.query(
        `select ${CHANGE_COLUMNS}, f.size::float8 as size from fs_change c
           left join fs_content f on f.workspace_id = c.workspace_id and f.hash = c.content_hash
          where c.node_id = $1 and c.op in ('create', 'write', 'restore') and c.content_hash is not null
          order by c.seq desc`,
        [node.id],
      )).rows;
    },

    /** The bytes of `nodePath` as of change `seq`. */
    async readRevision(nodePath, seq) {
      const node = await nodeAt(cleanPath(nodePath));
      if (!node) return null;
      const change = (await client.query(
        `select ${CHANGE_COLUMNS} from fs_change c where c.node_id = $1 and c.seq = $2 and c.content_hash is not null`,
        [node.id, seq],
      )).rows[0];
      if (!change) return null;
      return {change, body: await this.bodyOf(change.contentHash)};
    },

    /** Changes after `since`, oldest first; `cursor` is where the next call resumes. */
    async changes({since = 0, limit = 1000} = {}) {
      const bounded = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
      const rows = (await client.query(
        `select ${CHANGE_COLUMNS} from fs_change c where c.seq > $1 order by c.seq limit $2`,
        [Number(since) || 0, bounded],
      )).rows;
      return {changes: rows, cursor: rows.length ? rows.at(-1).seq : Number(since) || 0, more: rows.length === bounded};
    },

    /** The seq of the latest change the caller may see, where a change feed that starts now begins. */
    async head() {
      return Number((await client.query('select coalesce(max(seq), 0) as seq from fs_change')).rows[0].seq);
    },
  };
}

/** `onChange(workspaceId)` runs after each transaction that changed something commits (fs/events.js). */
function createPostgresFs({pool, onChange = () => {}}) {
  async function run(scope, operation) {
    let changed = false;
    const result = await withRequestContext(pool, {
      userId: scope?.userId,
      workspaceId: requireWorkspace(scope),
    }, client => operation(operations(client, scope, () => { changed = true; })));
    if (changed) onChange(scope.workspaceId);
    return result;
  }

  return Object.freeze({
    /** Run several operations in one transaction: `transaction(scope, async fs => …)`. */
    transaction: run,
    list: (scope, options) => run(scope, fs => fs.list(options)),
    stat: (scope, nodePath) => run(scope, fs => fs.nodeAt(cleanPath(nodePath))),
    byId: (scope, id) => run(scope, fs => fs.byId(id)),
    readMany: (scope, options) => run(scope, fs => fs.readMany(options)),
    async read(scope, nodePath) {
      const clean = cleanPath(nodePath);
      return run(scope, async fs => {
        const node = await fs.nodeAt(clean);
        if (!node) return null;
        if (node.kind !== 'file') throw new FsError(409, 'is-a-folder', `${clean} is a folder`);
        return {node, body: await fs.bodyOf(node.contentHash)};
      });
    },
    async readById(scope, id) {
      return run(scope, async fs => {
        const node = await fs.byId(id);
        if (!node || node.deletedAt || node.kind !== 'file') return null;
        return {node, body: await fs.bodyOf(node.contentHash)};
      });
    },
    write: (scope, nodePath, body, options) => run(scope, fs => fs.write(nodePath, body, options)),
    mkdir: (scope, nodePath) => run(scope, fs => fs.mkdir(nodePath)),
    move: (scope, from, to, options) => run(scope, fs => fs.move(from, to, options)),
    remove: (scope, nodePath, options) => run(scope, fs => fs.remove(nodePath, options)),
    restore: (scope, id) => run(scope, fs => fs.restore(id)),
    trash: (scope, options) => run(scope, fs => fs.list({...options, deleted: true})),
    emptyTrash: scope => run(scope, fs => fs.emptyTrash()),
    setAccess: (scope, nodePath, access, options) => run(scope, fs => fs.setAccess(nodePath, access, options)),
    sharedWith: (scope, nodePath) => run(scope, fs => fs.sharedWith(nodePath)),
    shareWith: (scope, nodePath, members) => run(scope, fs => fs.shareWith(nodePath, members)),
    history: (scope, nodePath) => run(scope, fs => fs.history(nodePath)),
    readRevision: (scope, nodePath, seq) => run(scope, fs => fs.readRevision(nodePath, seq)),
    changes: (scope, options) => run(scope, fs => fs.changes(options)),
    head: scope => run(scope, fs => fs.head()),
  });
}

/**
 * Read-only access for anyone, signed in or not, to one workspace's public
 * nodes. Runs with no user, so row-level security shows public nodes only.
 */
function createPublicFsReader({pool}) {
  async function run(workspaceId, operation) {
    const client = await pool.connect();
    try {
      await client.query('begin read only');
      await client.query("select set_config('app.user_id', '', true)");
      await client.query("select set_config('app.workspace_id', $1, true)", [String(workspaceId)]);
      const result = await operation(operations(client, {workspaceId: String(workspaceId), userId: null}));
      await client.query('commit');
      return result;
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
  return Object.freeze({
    /** `{id, name, slug, site}` for a workspace that publishes something, or null. */
    async workspace(slug) {
      const client = await pool.connect();
      try {
        return (await client.query('select id, name, slug, site from public_workspace($1)', [String(slug)])).rows[0] ?? null;
      } finally {
        client.release();
      }
    },
    list: (workspaceId, options) => run(workspaceId, fs => fs.list(options)),
    readMany: (workspaceId, options) => run(workspaceId, fs => fs.readMany(options)),
    async read(workspaceId, nodePath) {
      const clean = cleanPath(nodePath);
      return run(workspaceId, async fs => {
        const node = await fs.nodeAt(clean);
        if (!node || node.kind !== 'file') return null;
        return {node, body: await fs.bodyOf(node.contentHash)};
      });
    },
  });
}

module.exports = {
  ACCESS, CONTENT_TYPES, FsError, cleanPath, contentTypeFor, createPostgresFs, createPublicFsReader, isAppState, isMarkdown,
  isShownChange, parentOf,
};
