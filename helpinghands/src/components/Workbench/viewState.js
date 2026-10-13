import * as Y from 'yjs';
import {historyField} from '@codemirror/commands';
import {EditorSelection} from '@codemirror/state';

/**
 * Where each open file's editor was left, so switching tabs or reloading the
 * page never loses it. A record is `{anchor, head, scrollTop}`; while its tab
 * is open a text file's record also holds its whole `state`, undo history
 * included, and a live file's `anchor` and `head` are Yjs relative positions,
 * so the cursor stays on its text through everyone else's edits. Records are
 * kept in this browser by user, workspace and path; a closed tab keeps its
 * selection and scroll there for the next time the file opens, but not its
 * history.
 */

const KEEP_DELAY_MS = 500;

const kept = ({state, ...record}) => (state
  ? {...record, anchor: state.selection.main.anchor, head: state.selection.main.head}
  : record);

/** `scope()` is `{userId, workspaceId}`, or null while not known; without one nothing is kept. */
export function editorViews(store, scope, {delay = KEEP_DELAY_MS} = {}) {
  const views = new Map();
  const timers = new Map();
  const prefix = current => `fsview|${current.userId}|${current.workspaceId}|`;

  const keep = path => {
    clearTimeout(timers.get(path));
    timers.delete(path);
    const current = scope();
    const record = views.get(path);
    if (!current || !record) return Promise.resolve();
    return store.set(prefix(current) + path, kept(record))
      .catch(error => console.error(`[workspace] Could not keep where ${path} was left:`, error));
  };

  return {
    /** Read the kept record of a file being opened, unless its tab already has one. */
    async load(path) {
      const current = scope();
      if (!current || views.has(path)) return;
      const record = await store.get(prefix(current) + path);
      if (record && !views.has(path)) views.set(path, record);
    },

    get: path => views.get(path),

    set(path, patch) {
      views.set(path, {...views.get(path), ...patch});
      if (!timers.has(path)) timers.set(path, setTimeout(() => keep(path), delay));
    },

    /** The tab closed: keep its record now and drop its history. */
    close(path) {
      const written = timers.has(path) ? keep(path) : Promise.resolve();
      views.delete(path);
      return written;
    },

    /** Records follow renames; `moved` maps a path to where it is now. */
    async move(moved) {
      const written = [...timers.keys()].map(keep);
      const records = [...views].map(([path, record]) => [moved(path), record]);
      views.clear();
      for (const [path, record] of records) views.set(path, record);
      await Promise.all(written);
      const current = scope();
      if (!current) return;
      for (const [key, record] of await store.entries(prefix(current))) {
        const path = key.slice(prefix(current).length);
        if (moved(path) === path) continue;
        await store.set(prefix(current) + moved(path), record);
        await store.delete(key);
      }
    },
  };
}

/**
 * The state a text editor starts from: its own, history included, when its tab
 * was open before, else `text` with the kept selection, cut to the text's end.
 */
export function textStateJSON(record, text) {
  if (record?.state) return record.state.toJSON({history: historyField});
  const position = value => Math.min(value ?? 0, text.length);
  return {doc: text, selection: EditorSelection.single(position(record?.anchor), position(record?.head)).toJSON()};
}

/** A live editor's selection as positions in `text` that follow its edits. */
export const relativeSelection = (text, {anchor, head}) => ({
  anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, anchor)),
  head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, head)),
});

/** Where a kept live selection is in `text` now, or undefined when its text is not in this document. */
export function liveSelection(text, record) {
  if (!record?.anchor || !record?.head) return undefined;
  const index = position => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), text.doc)?.index;
  const anchor = index(record.anchor);
  const head = index(record.head);
  return anchor === undefined || head === undefined ? undefined : EditorSelection.single(anchor, head);
}
