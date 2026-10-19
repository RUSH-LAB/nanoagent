/**
 * RUSH Lab's folder of its member's own files. For each workspace they are in,
 * `<root>/<slug>/` is kept in sync both ways (sync.mjs) with their home there,
 * `home/<user>/`: private to them, so only they and their plugin runs write it,
 * and the two sides never race another member. The workspace's shared files
 * stay on RUSH.
 *
 * A folder's .mochi/state.json names its workspace by id, so a workspace whose
 * slug changes keeps its folder, renamed to the new slug. A folder of a
 * workspace the member left is no longer synced, and stays as it is.
 */
import {watch} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {STATE_DIR, abortsCycle, connect, filesApi, syncOnce} from './sync.mjs';

const POLL_MS = 30_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(file, value) {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, file);
}

const stateFile = folder => path.join(folder, STATE_DIR, 'state.json');

/**
 * Sync `root` with the homes of the member `userId` on `site`, signed in with
 * `token`: once now, every POLL_MS, soon after a file in it changes, and on
 * `sync()`. `stop()` ends it. `log` hears what each cycle did.
 */
export function syncFiles({site, token, userId, root, log}) {
  const request = connect(site, token);
  const rejected = new Map(); // workspace id -> the paths RUSH refused, by hash
  let running = false;
  let pending = false;
  let pausedUntil = 0;
  let stopped = false;

  /** The folder in `root` of each workspace synced before, by workspace id. */
  async function folders() {
    const found = new Map();
    for (const entry of await fs.readdir(root, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const state = await readJson(stateFile(path.join(root, entry.name)));
      if (state?.workspace) found.set(state.workspace, entry.name);
    }
    return found;
  }

  /** The folder for `workspace`, made, or renamed to its slug, as needed; null when another holds the name. */
  async function folderFor(workspace, had) {
    const folder = path.join(root, workspace.slug);
    const name = had.get(workspace.id);
    if (name === workspace.slug) return folder;
    const taken = await readJson(stateFile(folder)).catch(() => null);
    if (taken?.workspace || (name && await fs.stat(folder).then(() => true, () => false))) {
      log(`${workspace.slug}: another folder is already named ${folder}; ${workspace.name} is not synced until it moves`);
      return null;
    }
    if (name) {
      await fs.rename(path.join(root, name), folder);
      return folder;
    }
    // A folder the member made for it before is synced as it is.
    await fs.mkdir(path.join(folder, STATE_DIR), {recursive: true});
    await writeJson(stateFile(folder), {workspace: workspace.id, files: {}});
    return folder;
  }

  async function syncWorkspace(workspace, folder) {
    const state = await readJson(stateFile(folder));
    if (!rejected.has(workspace.id)) rejected.set(workspace.id, new Map());
    const api = filesApi(request, workspace.id, {prefix: `home/${userId}`});
    // Repeat while a cycle did work: a conflict leaves a copy for the next one to upload.
    while (await syncOnce({
      root: folder, api, state, rejected: rejected.get(workspace.id),
      saveState: value => writeJson(stateFile(folder), value),
      host: os.hostname().split('.')[0],
      day: new Date().toISOString().slice(0, 10),
      log: message => log(`${workspace.slug}: ${message}`),
    }));
  }

  async function syncAll() {
    await fs.mkdir(root, {recursive: true});
    const {workspaces} = (await request('GET', '/api/workspaces')).data;
    const had = await folders();
    for (const workspace of workspaces) {
      const folder = await folderFor(workspace, had);
      if (!folder) continue;
      try {
        await syncWorkspace(workspace, folder);
      } catch (error) {
        if (abortsCycle(error)) throw error;
        log(`${workspace.slug}: sync stopped: ${error.message}`);
      }
    }
  }

  async function cycle() {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        if (stopped || Date.now() < pausedUntil) break;
        try {
          await syncAll();
        } catch (error) {
          if (error.status === 429) pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
          log(`sync paused: ${error.message}`);
        }
      } while (pending);
    } finally {
      running = false;
    }
  }

  let watcher = null;
  let debounce;
  fs.mkdir(root, {recursive: true}).then(() => {
    if (stopped) return;
    watcher = watch(root, {recursive: true}, (event, filename) => {
      if (!filename || filename.split(path.sep).some(part => part.startsWith('.'))) return;
      clearTimeout(debounce);
      debounce = setTimeout(cycle, 500);
    });
    cycle();
  }, error => log(`cannot make ${root}: ${error.message}`));
  const timer = setInterval(cycle, POLL_MS);

  return {
    sync: cycle,
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(debounce);
      watcher?.close();
    },
  };
}
