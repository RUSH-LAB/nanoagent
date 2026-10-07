/**
 * Two-way sync between a workspace's documents and a local folder.
 *
 * Every cycle compares three views of each path: the file on disk, the
 * document on the server, and what both looked like after the last successful
 * sync (the base, kept in .mochi/state.json). A side changed when it differs
 * from the base. One changed side is copied to the other; when both changed,
 * the server keeps the path and the local edit is saved beside it as a
 * conflicted copy, which the next cycle uploads as a new document. Nothing is
 * merged silently and nothing is lost.
 *
 * Only .md and .mdx files take part, on both sides, so a file this client
 * cannot represent is never mistaken for a deletion.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const STATE_DIR = '.mochi';
const SYNCED = /\.mdx?$/;

export const hashOf = text => crypto.createHash('sha256').update(text).digest('hex');
const sameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();

/** The file changed again between planning and writing; the next cycle replans. */
class LocalChanged extends Error {}

/** Whether an error means the whole cycle must stop rather than one file. */
export function abortsCycle(error) {
  return error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500;
}

async function readLocal(root, relative) {
  try {
    return await fs.readFile(path.join(root, relative), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function walk(root) {
  const found = new Map();
  async function visit(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), {withFileTypes: true})) {
      // Dotfiles cover .mochi/, editor swap files, and this client's own temp files.
      if (entry.name.startsWith('.')) continue;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile() && SYNCED.test(entry.name)) found.set(relative, hashOf(await readLocal(root, relative)));
    }
  }
  await visit('');
  return found;
}

/** Write `text` at `relative` only if the file still has `expectedHash` (undefined: absent). */
async function writeLocal(root, relative, text, expectedHash) {
  const current = await readLocal(root, relative);
  if ((current === undefined ? undefined : hashOf(current)) !== expectedHash) throw new LocalChanged();
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.mochi-tmp`);
  await fs.writeFile(temp, text);
  await fs.rename(temp, target);
}

async function removeLocal(root, relative, expectedHash) {
  const current = await readLocal(root, relative);
  if (current === undefined) return;
  if (hashOf(current) !== expectedHash) throw new LocalChanged();
  await fs.rm(path.join(root, relative));
  // Remove folders the deletion emptied, as the server has no folders of its own.
  for (let dir = path.dirname(relative); dir !== '.'; dir = path.dirname(dir)) {
    const absolute = path.join(root, dir);
    if ((await fs.readdir(absolute)).length) break;
    await fs.rmdir(absolute);
  }
}

async function conflictedCopyPath(root, relative, host, day) {
  const extension = path.extname(relative);
  const stem = relative.slice(0, -extension.length);
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} (conflicted copy ${host} ${day}${n > 1 ? ` ${n}` : ''})${extension}`;
    if (await readLocal(root, candidate) === undefined) return candidate;
  }
}

/**
 * Run one sync cycle. `api` is the workspace's document API (list, get, create,
 * save, remove, move); `state.files` maps each synced path to its base
 * `{id, updatedAt, hash}`, and `saveState` persists it after every operation so
 * an interrupted cycle resumes where it stopped. `rejected` remembers paths the
 * server refused, by hash, so they are retried only after the file changes.
 * Returns the number of operations performed.
 */
export async function syncOnce({root, api, state, saveState, rejected = new Map(), host, day, log = () => {}}) {
  const remote = new Map((await api.list()).filter(document => SYNCED.test(document.path))
    .map(document => [document.path, document]));
  const local = await walk(root);
  const base = {...state.files};
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
    return now.id !== then.id || !sameTime(now.updatedAt, then.updatedAt);
  };
  const download = async (relative, expectedHash) => {
    const document = await api.get(relative);
    await writeLocal(root, relative, document.markdown, expectedHash);
    await record(relative, {id: document.id, updatedAt: document.updatedAt, hash: hashOf(document.markdown)});
    log(`downloaded ${relative}`);
  };
  const upload = async (relative, existing) => {
    const text = await readLocal(root, relative);
    if (text === undefined) throw new LocalChanged();
    const hash = hashOf(text);
    if (rejected.get(relative) === hash) return;
    const saved = existing
      ? await api.save(relative, text, existing.updatedAt)
      : await api.create(relative, text);
    rejected.delete(relative);
    await record(relative, {id: existing?.id ?? saved.id, updatedAt: saved.updatedAt, hash});
    log(`${existing ? 'uploaded' : 'created'} ${relative}`);
  };

  // A file that vanished locally and an identical one that appeared elsewhere
  // is a rename. Moving the document keeps its id, history, and visibility.
  const vanished = Object.keys(base).filter(relative => !local.has(relative) && !remoteChanged(relative));
  const moved = new Set();
  for (const [to, hash] of local) {
    if (base[to] || remote.has(to)) continue;
    const from = vanished.find(relative => base[relative].hash === hash);
    if (!from) continue;
    vanished.splice(vanished.indexOf(from), 1);
    try {
      const result = await api.move(from, to);
      delete state.files[from];
      await record(to, {...base[from], updatedAt: result.updatedAt});
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
          await api.remove(relative, then.updatedAt);
          await record(relative, null);
          log(`deleted ${relative} on the server`);
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
        // Deleted on the server, edited or deleted here: a local edit wins.
        if (localHash === undefined) await record(relative, null);
        else await upload(relative, null);
      } else if (localHash === undefined) {
        // Deleted here, edited on the server: the server edit wins.
        await download(relative, undefined);
      } else {
        const document = await api.get(relative);
        if (hashOf(document.markdown) !== localHash) {
          const mine = await readLocal(root, relative);
          if (mine === undefined || hashOf(mine) !== localHash) throw new LocalChanged();
          const copy = await conflictedCopyPath(root, relative, host, day);
          await writeLocal(root, copy, mine, undefined);
          await writeLocal(root, relative, document.markdown, localHash);
          log(`conflict on ${relative}; your version is in ${copy}`);
        }
        await record(relative, {id: document.id, updatedAt: document.updatedAt, hash: hashOf(document.markdown)});
      }
    } catch (error) {
      if (error instanceof LocalChanged) continue;
      if (abortsCycle(error)) throw error;
      // A refusal for this one file: invalid MDX, a viewer's write, a path the
      // server rejects. Say why and leave the file as it is until it changes.
      if (error.status === 409) {
        log(`${relative} changed on the server; it will be synced next cycle`);
        continue;
      }
      if (localHash !== undefined) rejected.set(relative, localHash);
      log(`could not sync ${relative}: ${error.message}`);
    }
  }
  return operations;
}
