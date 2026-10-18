/**
 * Two-way sync between a workspace file system and a local folder: the rush
 * CLI's (cli/rush.mjs) and RUSH Lab's (files.mjs).
 *
 * Every cycle compares three views of each path: the file on disk, the file in
 * the workspace, and what both looked like after the last successful sync (the
 * base, kept in .mochi/state.json). A side changed when it differs from the
 * base: on disk by content hash, in the workspace by revision. One changed
 * side is copied to the other; when both changed, the workspace keeps the path
 * and the local edit is saved beside it as a conflicted copy, which the next
 * cycle uploads as a new file. Nothing is merged silently and nothing is lost.
 *
 * Every file takes part, text or binary, except anything with a path segment
 * starting with a dot, on either side: .mochi/ itself, editor swap files, and
 * the workspace's .plugins/.
 *
 * Paths in `onlineOnly` stay in the workspace without a local copy. A synced
 * file under one is synced once more, so a pending local edit is uploaded,
 * then its unchanged local copy is removed. A file created or moved under one
 * locally is uploaded the same way and then removed, so it moves to the cloud.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const STATE_DIR = '.mochi';

export const hashOf = body => crypto.createHash('sha256').update(body).digest('hex');
const hidden = relative => relative.split('/').some(part => part.startsWith('.'));
const under = (relative, paths) => paths.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));

/** The file changed again between planning and writing; the next cycle replans. */
class LocalChanged extends Error {}

/** Whether an error means the whole cycle must stop rather than one file. */
export function abortsCycle(error) {
  return error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500;
}

async function readLocal(root, relative) {
  try {
    return await fs.readFile(path.join(root, relative));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function walk(root) {
  const found = new Map();
  async function visit(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) found.set(relative, hashOf(await readLocal(root, relative)));
    }
  }
  await visit('');
  return found;
}

/** Write `body` at `relative` only if the file still has `expectedHash` (undefined: absent). */
async function writeLocal(root, relative, body, expectedHash) {
  const current = await readLocal(root, relative);
  if ((current === undefined ? undefined : hashOf(current)) !== expectedHash) throw new LocalChanged();
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.mochi-tmp`);
  await fs.writeFile(temp, body);
  await fs.rename(temp, target);
}

async function removeLocal(root, relative, expectedHash) {
  const current = await readLocal(root, relative);
  if (current === undefined) return;
  if (hashOf(current) !== expectedHash) throw new LocalChanged();
  await fs.rm(path.join(root, relative));
  // Remove folders the deletion emptied; the workspace removed its own.
  for (let dir = path.dirname(relative); dir !== '.'; dir = path.dirname(dir)) {
    const absolute = path.join(root, dir);
    if ((await fs.readdir(absolute)).length) break;
    await fs.rmdir(absolute);
  }
}

async function conflictedCopyPath(root, relative, host, day) {
  const extension = path.extname(relative);
  const stem = extension ? relative.slice(0, -extension.length) : relative;
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} (conflicted copy ${host} ${day}${n > 1 ? ` ${n}` : ''})${extension}`;
    if (await readLocal(root, candidate) === undefined) return candidate;
  }
}

/**
 * Run one sync cycle. `api` is the workspace file system (list, get, put,
 * remove, move); `state.files` maps each synced path to its base
 * `{id, rev, hash}`, and `saveState` persists it after every operation so an
 * interrupted cycle resumes where it stopped. `rejected` remembers paths the
 * server refused, by hash, so they are retried only after the file changes.
 * `onlineOnly` lists the workspace paths kept without a local copy.
 * Returns the number of operations performed.
 */
export async function syncOnce({root, api, state, saveState, rejected = new Map(), onlineOnly = [], host, day, log = () => {}}) {
  const base = {...state.files};
  const remote = new Map((await api.list())
    .filter(file => !hidden(file.path) && (!under(file.path, onlineOnly) || base[file.path]))
    .map(file => [file.path, file]));
  const local = await walk(root);
  let operations = 0;

  const record = async (relative, entry) => {
    if (entry) state.files[relative] = entry;
    else delete state.files[relative];
    await saveState(state);
    operations += 1;
  };
  const remoteChanged = relative => {
    const now = remote.get(relative);
    const then = base[relative];
    if (!now || !then) return Boolean(now) !== Boolean(then);
    return now.id !== then.id || now.rev !== then.rev;
  };
  const download = async (relative, expectedHash) => {
    const file = await api.get(relative);
    await writeLocal(root, relative, file.body, expectedHash);
    await record(relative, {id: file.id, rev: file.rev, hash: hashOf(file.body)});
    log(`downloaded ${relative}`);
  };
  const upload = async (relative, existing) => {
    const body = await readLocal(root, relative);
    if (body === undefined) throw new LocalChanged();
    const hash = hashOf(body);
    if (rejected.get(relative) === hash) return;
    const node = await api.put(relative, body, existing ? existing.rev : 0);
    rejected.delete(relative);
    await record(relative, {id: node.id, rev: node.rev, hash});
    log(`${existing ? 'uploaded' : 'created'} ${relative}`);
  };

  // A file that vanished locally and an identical one that appeared elsewhere
  // is a rename. Moving the node keeps its id, history, and access.
  const vanished = Object.keys(base).filter(relative => !local.has(relative) && !remoteChanged(relative));
  const moved = new Set();
  for (const [to, hash] of local) {
    if (base[to] || remote.has(to)) continue;
    const from = vanished.find(relative => base[relative].hash === hash);
    if (!from) continue;
    vanished.splice(vanished.indexOf(from), 1);
    try {
      const node = await api.move(from, to, base[from].rev);
      delete state.files[from];
      await record(to, {id: node.id, rev: node.rev, hash});
      moved.add(from).add(to);
      log(`moved ${from} -> ${to}`);
    } catch (error) {
      // The pass below then syncs both paths as a deletion and a new file.
      if (abortsCycle(error)) throw error;
      log(`could not move ${from} -> ${to}: ${error.message}`);
    }
  }

  const paths = new Set([...Object.keys(base), ...remote.keys(), ...local.keys()]);
  for (const relative of [...paths].sort()) {
    if (moved.has(relative)) continue;
    const localHash = local.get(relative);
    const then = base[relative];
    const localChanged = localHash !== then?.hash;
    const serverChanged = remoteChanged(relative);
    if (!localChanged && !serverChanged) continue;
    try {
      if (!serverChanged) {
        if (localHash === undefined) {
          await api.remove(relative, then.rev);
          await record(relative, null);
          log(`deleted ${relative} in the workspace`);
        } else {
          await upload(relative, then);
        }
      } else if (!localChanged) {
        if (remote.has(relative)) {
          await download(relative, localHash);
        } else {
          await removeLocal(root, relative, localHash);
          await record(relative, null);
          log(`deleted ${relative} locally`);
        }
      } else if (!remote.has(relative)) {
        // Deleted in the workspace, edited or deleted here: a local edit wins.
        if (localHash === undefined) await record(relative, null);
        else await upload(relative, null);
      } else if (localHash === undefined) {
        // Deleted here, edited in the workspace: the workspace's edit wins.
        await download(relative, undefined);
      } else {
        const file = await api.get(relative);
        if (hashOf(file.body) !== localHash) {
          const mine = await readLocal(root, relative);
          if (mine === undefined || hashOf(mine) !== localHash) throw new LocalChanged();
          const copy = await conflictedCopyPath(root, relative, host, day);
          await writeLocal(root, copy, mine, undefined);
          await writeLocal(root, relative, file.body, localHash);
          log(`conflict on ${relative}; your version is in ${copy}`);
        }
        await record(relative, {id: file.id, rev: file.rev, hash: hashOf(file.body)});
      }
    } catch (error) {
      if (error instanceof LocalChanged) continue;
      if (abortsCycle(error)) throw error;
      // A refusal for this one file: a viewer's write, a path the server
      // rejects. Say why and leave the file as it is until it changes.
      if (error.status === 409) {
        log(`${relative} changed in the workspace; it will be synced next cycle`);
        continue;
      }
      if (localHash !== undefined) rejected.set(relative, localHash);
      log(`could not sync ${relative}: ${error.message}`);
    }
  }

  for (const [relative, entry] of Object.entries(state.files)) {
    if (!under(relative, onlineOnly)) continue;
    try {
      await removeLocal(root, relative, entry.hash);
    } catch (error) {
      // Edited since it was synced: the next cycle uploads it first.
      if (error instanceof LocalChanged) continue;
      throw error;
    }
    await record(relative, null);
    log(`${relative} is online only`);
  }
  return operations;
}

/** A client for one server. Errors carry the HTTP status, or 0 when the server is unreachable. */
export function connect(server, token) {
  return async function request(method, route, {body, headers = {}, raw = false} = {}) {
    let response;
    try {
      response = await fetch(`${server}${route}`, {
        method,
        headers: {
          // Node's fetch sends Fetch Metadata headers, which make Better Auth
          // require an origin. The server's own origin is a trusted one.
          Origin: server,
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
          ...(body === undefined ? {} : {'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json'}),
          ...headers,
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
    } catch (error) {
      throw Object.assign(new Error(`Cannot reach ${server}: ${error.cause?.message ?? error.message}`), {status: 0});
    }
    if (response.status === 304) return {response, data: null};
    if (raw && response.ok) return {response, data: Buffer.from(await response.arrayBuffer())};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(data.error || data.message || `${method} ${route} failed with ${response.status}`),
        {status: response.status});
    }
    return {response, data};
  };
}

/**
 * The file system API `syncOnce` expects, over one workspace's /fs endpoints: the
 * whole workspace, or only what is under the folder `prefix`, by paths relative to it.
 */
export function filesApi(request, workspaceId, {prefix = ''} = {}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/fs`;
  const full = filePath => (prefix ? `${prefix}/${filePath}` : filePath);
  const query = filePath => `path=${encodeURIComponent(full(filePath))}`;
  const relative = node => ({...node, path: prefix ? node.path.slice(prefix.length + 1) : node.path});
  const tree = prefix ? `${base}/tree?prefix=${encodeURIComponent(prefix)}` : `${base}/tree`;
  let etag = null;
  let files = null;
  return {
    async list() {
      const {response, data} = await request('GET', tree, {headers: etag ? {'If-None-Match': etag} : {}});
      if (data) {
        etag = response.headers.get('etag');
        files = data.nodes.filter(node => node.kind === 'file').map(node => relative({path: node.path, id: node.id, rev: node.rev}));
      }
      return files;
    },
    async get(filePath) {
      const {response, data} = await request('GET', `${base}/file?${query(filePath)}`, {raw: true});
      return {body: data, id: response.headers.get('x-node-id'), rev: Number(response.headers.get('x-rev'))};
    },
    async put(filePath, body, baseRev) {
      return relative((await request('PUT', `${base}/file?${query(filePath)}&baseRev=${baseRev}`, {body})).data.node);
    },
    async remove(filePath, baseRev) {
      await request('DELETE', `${base}/node?${query(filePath)}&baseRev=${baseRev}`);
    },
    async move(from, to, baseRev) {
      return relative((await request('POST', `${base}/move`, {body: {from: full(from), to: full(to), baseRev}})).data.node);
    },
  };
}
