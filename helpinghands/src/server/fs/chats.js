'use strict';

/**
 * A plugin session's chat, kept as files in its member's home
 * (docs/plans/filesystem-layout.md):
 *
 *   home/<user>/plugins/<plugin>/chats/<yyyy_mm_dd>_<title>/chat.json                 the turns, as the plugin's page shows them
 *   home/<user>/plugins/<plugin>/chats/<yyyy_mm_dd>_<title>/turns/<n>/graph.json      a turn's provenance graph
 *   home/<user>/plugins/<plugin>/chats/<yyyy_mm_dd>_<title>/turns/<n>/messages.json   what its model saw and did, as an ATIF trajectory
 *
 * beside the plugin's files/, which its runs are given (runner/run-files.mjs), so a run never sees its chats.
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

/** The turns of the chat in `chatFile` from the `first`th (0 the first), each with its `file` (graph.json, messages.json) as `key`, or null when it has none. */
async function turnsWith(tree, chatFile, first, file, key) {
  const opened = await open(tree, chatFile);
  if (!opened) return [];
  const from = Math.max(0, first(opened.chat.turns.length));
  const folder = folderOf(opened.node.path);
  const pathOf = offset => `${turnFolder(folder, from + offset + 1)}/${file}`;
  const turns = opened.chat.turns.slice(from);
  const files = new Map((await tree.readMany({paths: turns.map((_turn, offset) => pathOf(offset))}))
    .map(one => [one.path, JSON.parse(one.body.toString('utf8'))]));
  return turns.map((turn, offset) => ({...turn, [key]: files.get(pathOf(offset)) ?? null}));
}

/** The latest `limit` turns of the chat in `chatFile`, each with its graph, or none when it is gone. */
const latestTurns = (tree, chatFile, limit) => turnsWith(tree, chatFile, count => count - limit, 'graph.json', 'graph');

/** Every turn of the chat in `chatFile`, each with what its model saw and did (`messages`, an ATIF trajectory), or none when it is gone. */
const allTurns = (tree, chatFile) => turnsWith(tree, chatFile, () => 0, 'messages.json', 'messages');

module.exports = {allTurns, appendTurn, chatName, latestTurns};
