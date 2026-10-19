/**
 * A plugin run's files, kept on the member's own computer. NanoAgent runs a plugin in a scratch
 * folder of its own (nanoagent.web.workspaces), which the relay fills, before the run, from the
 * member's folder for that plugin, `plugins/<plugin>/files/` in their folder of the workspace
 * here (files.mjs), and whose changes it writes back there after it, answered, failed or stopped
 * part way, then removes. File sync takes them to RUSH as it takes any of the member's edits, so
 * nothing of the run's crosses the network on the run's way.
 *
 * Writing back is measured against what the run started from, so an edit made meanwhile is never
 * overwritten: a file both changed is kept twice, the run's version as a conflicted copy beside
 * it, named as sync names one (sync.mjs).
 */
import path from 'node:path';
import {workspaceFolders} from './files.mjs';
import {LocalChanged, conflictedCopyPath, hashOf, readLocal, removeLocal, walk, writeLocal} from './sync.mjs';

const encodedPath = relative => relative.split('/').map(encodeURIComponent).join('/');

/**
 * The run files of the member whose workspaces are synced in `root`, on the NanoAgent at
 * `nanoagent`; `sync()` syncs those folders with RUSH, resolving once it has.
 */
export function runFiles({root, nanoagent, nanoagentToken, sync}) {
  async function call(method, route, body) {
    const response = await fetch(`${nanoagent}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : {'Content-Type': 'application/octet-stream'}),
        ...(nanoagentToken ? {Authorization: `Bearer ${nanoagentToken}`} : {}),
      },
      ...(body === undefined ? {} : {body}),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(`NanoAgent on this computer refused ${method} ${route} (${response.status}): ${data.error ?? data.detail ?? ''}`);
    }
    return response;
  }
  const inScratch = (scratch, rest = '') => `/v1/workspaces/${encodeURIComponent(scratch)}${rest}`;

  /** The member's folder here for `plugin` in `workspace`, after syncing it with RUSH. */
  async function folderOf({workspace, plugin}) {
    await sync();
    const name = (await workspaceFolders(root)).get(workspace);
    if (!name) throw new Error('RUSH Lab has no folder of this workspace\'s files on this computer yet, so the plugin cannot run on them');
    return path.join(root, name, 'plugins', plugin, 'files');
  }

  /** Write what the run did in `scratch` back into `folder`, measured against `sent`. */
  async function writeBack(plugin, scratch, folder, sent) {
    const listing = await (await call('GET', inScratch(scratch, '/files'))).json();
    if (listing.truncated) {
      throw new Error(`NanoAgent listed only part of the run's folder (${listing.files.length} files); nothing was written back`);
    }
    const day = new Date().toISOString().slice(0, 10);
    const left = new Set();
    for (const {path: relative} of listing.files) {
      left.add(relative);
      const body = Buffer.from(await (await call('GET', inScratch(scratch, `/files/${encodedPath(relative)}`))).arrayBuffer());
      if (sent.get(relative) === hashOf(body)) continue;
      try {
        await writeLocal(folder, relative, body, sent.get(relative));
      } catch (error) {
        if (!(error instanceof LocalChanged)) throw error;
        await writeLocal(folder, await conflictedCopyPath(folder, relative, `${plugin} run`, day), body, undefined);
      }
    }
    for (const [relative, hash] of sent) {
      if (left.has(relative)) continue;
      try {
        await removeLocal(folder, relative, hash);
      } catch (error) {
        // Edited since the run started; the edit stays.
        if (!(error instanceof LocalChanged)) throw error;
      }
    }
  }

  return Object.freeze({
    /**
     * Fill NanoAgent's folder `scratch` for a run of `files.plugin` in `files.workspace` from the
     * member's folder for it: what was copied, by path, with its hash.
     */
    async prepare(files, scratch) {
      const folder = await folderOf(files);
      const sent = new Map();
      try {
        for (const relative of (await walk(folder).catch(error => (error.code === 'ENOENT' ? new Map() : Promise.reject(error)))).keys()) {
          const body = await readLocal(folder, relative);
          if (body === undefined) continue;
          await call('PUT', inScratch(scratch, `/files/${encodedPath(relative)}?create=1`), body);
          sent.set(relative, hashOf(body));
        }
      } catch (error) {
        await call('DELETE', inScratch(scratch)).catch(() => {});
        throw error;
      }
      return {folder, sent};
    },

    /** Write what the run of `plugin` did in `scratch` back into the folder it was filled from, then remove `scratch`. */
    async finish(plugin, scratch, {folder, sent}) {
      // The first thing that fails is what the run reports; the folder goes either way.
      let failure = null;
      await writeBack(plugin, scratch, folder, sent).catch(error => { failure = error; });
      await call('DELETE', inScratch(scratch)).catch(error => { failure ??= error; });
      sync();
      if (failure) throw failure;
    },
  });
}
