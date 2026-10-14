'use strict';

/**
 * A plugin run as a client of the workspace file system.
 *
 * NanoAgent runs a plugin in a scratch folder made for that one run: before it,
 * the folder is filled from the member's `home/<user>/agent/` folder; after it,
 * what the run created, changed, or deleted is written back there, as that
 * member, and the folder is removed. The file system is where the files live;
 * NanoAgent keeps nothing between runs.
 *
 * Writing back is measured against the revisions the run started from, so an
 * edit the member made while the run went on is never overwritten: a file both
 * changed is kept twice, the run's version as a conflicted copy beside it.
 */
const crypto = require('crypto');
const {FsError} = require('./store');

const sha256 = body => crypto.createHash('sha256').update(body).digest('hex');
const agentFolder = scope => `home/${scope.userId}/agent`;
const collided = error => error instanceof FsError && error.status === 409;

function unwrap(result, doing) {
  if (result.error) throw Object.assign(new Error(`NanoAgent could not ${doing}: ${result.error}`), {status: result.status});
  return result.value;
}

/** Where the run's version of `path` goes when the member changed it too. */
function conflictPath(path, workspace) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const split = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0, split)} (agent run ${workspace.slice(0, 8)})${path.slice(split)}`;
}

/** A member's home is private to them before the first file lands in it. */
async function prepareHome(fs, scope) {
  const home = `home/${scope.userId}`;
  await fs.transaction(scope, async tree => {
    if (await tree.nodeAt(home)) return;
    await tree.mkdir(home);
    await tree.setAccess(home, 'private');
  });
}

function createAgentSync({fs}) {
  /** Copy the member's agent folder into the run's folder: what was sent, by path, with its revision. */
  async function push(scope, ai, workspace) {
    const folder = agentFolder(scope);
    const sent = new Map();
    for (const file of await fs.readMany(scope, {prefix: folder})) {
      const relative = file.path.slice(folder.length + 1);
      unwrap(await ai.saveWorkspaceFile(workspace, relative, file.body, {create: true}), `receive ${relative}`);
      sent.set(relative, {rev: file.rev, contentHash: file.contentHash});
    }
    return sent;
  }

  /** Keep the run's `body` at `target`, unless the member changed it since `baseRev`. */
  async function keep(scope, target, body, baseRev, workspace) {
    try {
      await fs.write(scope, target, body, {baseRev});
    } catch (error) {
      if (!collided(error)) throw error;
      await fs.write(scope, conflictPath(target, workspace), body, {baseRev: 0});
    }
  }

  /** Write what the run changed in its folder back into the member's agent folder. */
  async function pull(scope, ai, workspace, sent) {
    const folder = agentFolder(scope);
    const listing = unwrap(await ai.workspaceFiles(workspace), 'list its workspace');
    if (listing.truncated) {
      throw new Error(`NanoAgent listed only part of the run's folder (${listing.files.length} files); nothing was written back`);
    }
    const left = new Set();
    for (const file of listing.files) {
      left.add(file.path);
      const body = unwrap(await ai.workspaceFile(workspace, file.path), `send ${file.path}`);
      const base = sent.get(file.path);
      if (base?.contentHash === sha256(body)) continue;
      await keep(scope, `${folder}/${file.path}`, body, base?.rev ?? 0, workspace);
    }
    for (const [relative, base] of sent) {
      if (left.has(relative)) continue;
      try {
        await fs.remove(scope, `${folder}/${relative}`, {baseRev: base.rev});
      } catch (error) {
        // The member edited it during the run; their edit stays.
        if (!collided(error)) throw error;
      }
    }
  }

  return Object.freeze({
    /**
     * A folder for one run on the NanoAgent `ai`, filled from the member's agent
     * folder: `{workspace, sent}`, where `sent` (the revisions copied, by path)
     * is JSON, so a run may end in another process (app-runs.js).
     */
    async prepare(scope, ai) {
      await prepareHome(fs, scope);
      const workspace = crypto.randomBytes(16).toString('hex');
      try {
        return {workspace, sent: Object.fromEntries(await push(scope, ai, workspace))};
      } catch (error) {
        unwrap(await ai.deleteWorkspace(workspace), 'remove its workspace');
        throw error;
      }
    },
    /**
     * Write what the run did in `folder` back into the member's agent folder,
     * answered, failed or cancelled part way, and remove it either way.
     */
    async finish(scope, ai, {workspace, sent}) {
      try {
        await pull(scope, ai, workspace, new Map(Object.entries(sent)));
      } finally {
        unwrap(await ai.deleteWorkspace(workspace), 'remove its workspace');
      }
    },
  });
}

module.exports = {agentFolder, conflictPath, createAgentSync, prepareHome};
