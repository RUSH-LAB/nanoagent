'use strict';

/**
 * Mergeable Markdown files: the Yjs document behind each one (fs_crdt).
 *
 * The document holds the file's text as the Y.Text "markdown". Editors send
 * Yjs updates; the server applies them under the file's row lock, writes the
 * merged text as an ordinary revision, and returns what changed so it can be
 * streamed to every other open editor. A file last written some other way (a
 * plain save, the CLI, an import) is folded into its document by replacing the
 * text that differs, so both views always agree.
 *
 * The server is the only place a document is created from a file's text: two
 * editors that each did so would hold unrelated histories that cannot merge.
 */
const Y = require('yjs');
const {FsError, cleanPath, isMarkdown} = require('./store');

const TEXT = 'markdown';
// Above Yjs's random 32-bit client ids, so the server's never collide with an editor's.
const SERVER_CLIENT_BASE = 2 ** 32;
const asBuffer = value => (Buffer.isBuffer(value) ? value : Buffer.from(value));

/** Edit `text` into `target` by replacing only the part between their common prefix and suffix. */
function replaceText(text, target) {
  const current = text.toString();
  if (current === target) return;
  let start = 0;
  while (start < current.length && start < target.length && current[start] === target[start]) start += 1;
  let end = 0;
  while (end < current.length - start && end < target.length - start
    && current[current.length - 1 - end] === target[target.length - 1 - end]) end += 1;
  text.doc.transact(() => {
    if (current.length - start - end > 0) text.delete(start, current.length - start - end);
    if (target.length - start - end > 0) text.insert(start, target.slice(start, target.length - end));
  });
}

function createCrdt({fs}) {
  /**
   * The document for `nodePath` inside an open transaction, reconciled with
   * the file. Writers lock the node; a viewer may not, because row-level
   * security applies the update policy to a locking read.
   */
  async function open(tree, nodePath, {lock}) {
    const clean = cleanPath(nodePath);
    const node = await tree.nodeAt(clean, {lock});
    if (!node) throw new FsError(404, 'not-found', `Nothing at ${clean}`);
    if (node.kind !== 'file' || !isMarkdown(clean)) throw new FsError(400, 'not-mergeable', `${clean} is not a Markdown file`);
    const row = (await tree.query('select state, rev::float8 as rev from fs_crdt where node_id = $1', [node.id])).rows[0];
    const doc = new Y.Doc();
    if (row) Y.applyUpdate(doc, asBuffer(row.state));
    const stored = Y.encodeStateVector(doc);
    const fileText = (await tree.bodyOf(node.contentHash)).toString('utf8');
    if (!row || row.rev !== node.rev) {
      // The server's own edits use a client id fixed by the file revision, so
      // whoever opens the file first, every copy built from it is identical.
      doc.clientID = SERVER_CLIENT_BASE + node.rev;
      replaceText(doc.getText(TEXT), fileText);
    }
    return {node, doc, stored, fileText, known: Boolean(row)};
  }

  async function persist(tree, scope, node, doc) {
    await tree.query(
      `insert into fs_crdt(node_id, workspace_id, state, rev, updated_at) values ($1, $2, $3, $4, now())
       on conflict (node_id) do update set state = excluded.state, rev = excluded.rev, updated_at = now()`,
      [node.id, scope.workspaceId, Buffer.from(Y.encodeStateAsUpdate(doc)), node.rev],
    );
  }

  return Object.freeze({
    /**
     * The whole document as one update, and the revision it matches. Folding
     * in a plain write is itself a change, returned as `changes` for anyone
     * already editing.
     */
    async state(scope, nodePath) {
      const writer = ['owner', 'editor'].includes(scope.role);
      return fs.transaction(scope, async tree => {
        const {node, doc, stored, known} = await open(tree, nodePath, {lock: writer});
        const changes = Y.encodeStateAsUpdate(doc, stored);
        const reconciled = !known || changes.length > 2;
        // A viewer reads the document without storing one.
        if (reconciled && writer) await persist(tree, scope, node, doc);
        return {update: Y.encodeStateAsUpdate(doc), rev: node.rev, nodeId: node.id, changes: known ? changes : null};
      });
    },

    /**
     * Apply an editor's update. Returns the file's node after the merged text
     * is written, and `changes`: everything new to the stored document,
     * including any plain write folded in first, for the other editors.
     */
    async merge(scope, nodePath, update) {
      return fs.transaction(scope, async tree => {
        let {node, doc, stored, fileText} = await open(tree, nodePath, {lock: true});
        Y.applyUpdate(doc, update instanceof Uint8Array ? update : new Uint8Array(update));
        const merged = doc.getText(TEXT).toString();
        if (merged !== fileText) node = await tree.write(node.path, merged, {baseRev: node.rev});
        await persist(tree, scope, node, doc);
        return {node, changes: Y.encodeStateAsUpdate(doc, stored)};
      });
    },
  });
}

/**
 * Editors listening for a file's changes, by node id, as server-sent event
 * streams. One process holds them; a deployment with several would relay
 * through PostgreSQL LISTEN/NOTIFY instead.
 */
function createCrdtHub() {
  const listeners = new Map();
  return Object.freeze({
    listen(nodeId, send) {
      if (!listeners.has(nodeId)) listeners.set(nodeId, new Set());
      listeners.get(nodeId).add(send);
      return () => {
        listeners.get(nodeId)?.delete(send);
        if (!listeners.get(nodeId)?.size) listeners.delete(nodeId);
      };
    },
    has: nodeId => Boolean(listeners.get(nodeId)?.size),
    /** Send `update` to every editor of the node, its sender included: applying one twice changes nothing. */
    broadcast(nodeId, update) {
      if (!update || update.length <= 2) return;
      const encoded = Buffer.from(update).toString('base64');
      for (const send of listeners.get(nodeId) ?? []) send(encoded);
    },
  });
}

module.exports = {TEXT, createCrdt, createCrdtHub, replaceText};
