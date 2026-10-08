'use strict';

/**
 * A plugin run as a client of the workspace file system.
 *
 * NanoAgent runs a plugin task in a folder of its own (agent-workspace.js
 * names it). That folder is now scratch space: before a run it is filled from
 * the member's `home/<user>/agent/` folder, and after the run whatever the run
 * created, changed, or deleted is written back there, as that member. The
 * file system is where the files live; NanoAgent keeps nothing that matters.
 *
 * A member's runs take turns, because they share NanoAgent's folder.
 */
const crypto = require('crypto');

const sha256 = body => crypto.createHash('sha256').update(body).digest('hex');
const agentFolder = scope => `home/${scope.userId}/agent`;

function unwrap(result, doing) {
  if (result.error) throw Object.assign(new Error(`NanoAgent could not ${doing}: ${result.error}`), {status: result.status});
  return result.value;
}

function createAgentSync({ai, fs}) {
  const turns = new Map();

  /** Run `operation` after every earlier run of this member's has finished. */
  function inTurn(key, operation) {
    const previous = turns.get(key) ?? Promise.resolve();
    // An earlier run's failure is its own caller's to report; this one starts regardless.
    const next = previous.catch(() => {}).then(operation);
    turns.set(key, next);
    return next.finally(() => { if (turns.get(key) === next) turns.delete(key); });
  }

  /** Empty NanoAgent's folder, then copy the member's agent folder into it. */
  async function push(scope, workspace) {
    const listing = unwrap(await ai.workspaceFiles(workspace), 'list its workspace');
    for (const file of listing.files) unwrap(await ai.deleteWorkspaceFile(workspace, file.path), `clear ${file.path}`);
    for (const folder of [...listing.folders].sort((a, b) => b.length - a.length)) {
      unwrap(await ai.deleteWorkspaceFolder(workspace, folder), `clear ${folder}`);
    }
    const folder = agentFolder(scope);
    for (const file of await fs.readMany(scope, {prefix: folder})) {
      const relative = file.path.slice(folder.length + 1);
      unwrap(await ai.saveWorkspaceFile(workspace, relative, file.body, {create: true}), `receive ${relative}`);
    }
  }

  /** Write what the run left in NanoAgent's folder back into the member's agent folder. */
  async function pull(scope, workspace) {
    const folder = agentFolder(scope);
    const listing = unwrap(await ai.workspaceFiles(workspace), 'list its workspace');
    const before = new Map((await fs.readMany(scope, {prefix: folder})).map(file => [file.path, file]));
    const after = new Set();
    for (const file of listing.files) {
      const target = `${folder}/${file.path}`;
      after.add(target);
      const body = unwrap(await ai.workspaceFile(workspace, file.path), `send ${file.path}`);
      if (before.get(target)?.contentHash === sha256(body)) continue;
      await fs.write(scope, target, body);
    }
    for (const target of before.keys()) {
      if (!after.has(target)) await fs.remove(scope, target);
    }
  }

  return Object.freeze({
    /**
     * Prepare NanoAgent's folder, run `operation` (the task), and write the
     * results back, even when the run fails or is cancelled part way.
     */
    run(scope, workspace, operation) {
      return inTurn(workspace, async () => {
        await prepareHome(scope);
        await push(scope, workspace);
        try {
          return await operation();
        } finally {
          await pull(scope, workspace);
        }
      });
    },
  });

  /** A member's home is private to them before the first file lands in it. */
  async function prepareHome(scope) {
    const home = `home/${scope.userId}`;
    await fs.transaction(scope, async tree => {
      if (await tree.nodeAt(home)) return;
      await tree.mkdir(home);
      await tree.setAccess(home, 'private');
    });
  }
}

module.exports = {agentFolder, createAgentSync};
