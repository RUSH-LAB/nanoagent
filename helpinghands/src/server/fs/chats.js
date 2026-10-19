'use strict';

/**
 * A plugin session's chat, kept as files in its member's home
 * (docs/plans/filesystem-layout.md):
 *
 *   home/<user>/plugins/<plugin>/chats/<yyyy_mm_dd>_<title>/chat.json                 the turns, as the plugin's page shows them
 *   home/<user>/plugins/<plugin>/chats/<yyyy_mm_dd>_<title>/turns/<n>/graph.json      a turn's provenance graph
 *   home/<user>/plugins/<plugin>/chats/<yyyy_mm_dd>_<title>/turns/<n>/messages.json   what its model saw and did, as an ATIF trajectory
 *
 * beside the plugin's files/, which its runs are given (fs/agent-sync.js), so a run never sees its chats.
 *
 * The folder is made with the session's first turn, and plugin_session.chat_file
 * names its chat.json by node id, so the member may rename or move the folder
 * and the session follows it. A chat whose file the member deleted is gone:
 * the session shows no turns, and its next turn starts a new folder.
 */
const NAME_MAX = 80;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const folderOf = path => path.slice(0, path.lastIndexOf('/'));
const turnFolder = (folder, index) => `${folder}/turns/${String(index).padStart(3, '0')}`;

/** A folder name for a chat started on `at` and titled `title`, in lowercase words joined by _: 2026_10_19_find_the_paper. */
function chatName(at, title) {
  const words = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, NAME_MAX).replace(/^_+|_+$/g, '');
  return `${new Date(at).toISOString().slice(0, 10).replaceAll('-', '_')}_${words || 'chat'}`;
}

/** The chat file `chatFile` in the transaction `tree`, `{node, chat}`, or null when it is gone. */
async function open(tree, chatFile) {
  const node = chatFile ? await tree.byId(chatFile) : null;
  if (!node || node.deletedAt) return null;
  return {node, chat: JSON.parse((await tree.bodyOf(node.contentHash)).toString('utf8'))};
}

/** A free folder for a new chat of `pluginId` in `userId`'s home. */
async function newFolder(tree, {userId, pluginId, at, title}) {
  const base = `home/${userId}/plugins/${pluginId}/chats/${chatName(at, title)}`;
  for (let count = 1; ; count += 1) {
    const folder = count === 1 ? base : `${base}_${count}`;
    if (!await tree.nodeAt(folder)) return folder;
  }
}

/**
 * Add `turn` (as the page shows it) to the chat in `chatFile`, or to a new
 * chat titled `title` when there is none, with its `graph` and ATIF
 * `trajectory` when the run left them, in the transaction `tree`. The chat
 * file's node id.
 */
async function appendTurn(tree, {chatFile, userId, pluginId, sessionId, title, at}, turn, {graph = null, trajectory = null} = {}) {
  const opened = await open(tree, chatFile);
  const path = opened?.node.path ?? `${await newFolder(tree, {userId, pluginId, at, title})}/chat.json`;
  const chat = opened?.chat ?? {session: sessionId, plugin: pluginId, turns: []};
  chat.turns.push(turn);
  const node = await tree.write(path, json(chat), {baseRev: opened ? opened.node.rev : 0});
  const folder = turnFolder(folderOf(path), chat.turns.length);
  if (graph) await tree.write(`${folder}/graph.json`, json(graph));
  if (trajectory) await tree.write(`${folder}/messages.json`, json(trajectory));
  return node.id;
}

/** The latest `limit` turns of the chat in `chatFile`, each with its graph, or none when it is gone. */
async function latestTurns(tree, chatFile, limit) {
  const opened = await open(tree, chatFile);
  if (!opened) return [];
  const first = Math.max(0, opened.chat.turns.length - limit);
  const folder = folderOf(opened.node.path);
  const graphs = new Map((await tree.readMany({paths: opened.chat.turns.slice(first)
    .map((_turn, offset) => `${turnFolder(folder, first + offset + 1)}/graph.json`)}))
    .map(file => [file.path, JSON.parse(file.body.toString('utf8'))]));
  return opened.chat.turns.slice(first).map((turn, offset) => ({
    ...turn, graph: graphs.get(`${turnFolder(folder, first + offset + 1)}/graph.json`) ?? null,
  }));
}

module.exports = {appendTurn, chatName, latestTurns};
