/**
 * The workspace listing as an explorer tree, and the path arithmetic the
 * explorer's actions need. Paths are workspace-relative and '/'-separated;
 * the root folder is ''.
 */

export const basename = path => path.split('/').at(-1);
export const dirname = path => path.split('/').slice(0, -1).join('/');
export const join = (folder, name) => (folder ? `${folder}/${name}` : name);

/** Whether `path` is `folder` or lies inside it. */
export const within = (path, folder) => path === folder || path.startsWith(`${folder}/`);

/**
 * The tab comparing `file` with `against` (a revision, or the file a
 * conflicted copy was made from). It lies below the file, where no other
 * entry can, so it follows the file's renames and closes with its deletion.
 */
export const comparePath = (file, against) => `${file}/@${against}`;

/**
 * `{files, folders}` from the API as nested nodes, folders before files and
 * each sorted by name, as VS Code shows them. A folder is a path or an object
 * with one, whose other fields (such as `access`) the node keeps. A folder
 * implied by a file's path but absent from `folders` is still shown.
 */
export function buildTree(files, folders) {
  const root = {type: 'folder', path: '', name: '', children: new Map()};
  const folderNode = path => {
    let node = root;
    for (const part of path ? path.split('/') : []) {
      const childPath = join(node.path, part);
      if (!node.children.has(part)) {
        node.children.set(part, {type: 'folder', path: childPath, name: part, children: new Map()});
      }
      node = node.children.get(part);
    }
    return node;
  };
  for (const folder of folders) {
    if (typeof folder === 'string') folderNode(folder);
    else Object.assign(folderNode(folder.path), folder, {type: 'folder'});
  }
  for (const file of files) {
    folderNode(dirname(file.path)).children.set(basename(file.path), {type: 'file', name: basename(file.path), ...file});
  }
  const order = node => {
    if (node.type === 'file') return node;
    const children = [...node.children.values()]
      .map(order)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
    return {...node, children};
  };
  return order(root);
}

/** The visible rows of the tree, depth-first, given which folders are open. */
export function visibleRows(tree, expanded, depth = 0) {
  const rows = [];
  for (const node of tree.children) {
    rows.push({node, depth});
    if (node.type === 'folder' && expanded.has(node.path)) rows.push(...visibleRows(node, expanded, depth + 1));
  }
  return rows;
}

/** Why `name` cannot be an entry's name, or null when it can. */
export function invalidName(name) {
  if (!name.trim()) return 'A name is required';
  if (name.includes('/') || name.includes('\\')) return 'A name cannot contain / or \\';
  if (name === '.' || name === '..') return 'That name is reserved';
  return null;
}

/** `path` after `from` moved to `to`, for a file or anything inside a moved folder. */
export function movedPath(path, from, to) {
  return within(path, from) ? to + path.slice(from.length) : path;
}

/**
 * What changes made elsewhere (utils/fsEvents.js), in feed order, mean for
 * open files: `moves` as `[from, to]` pairs to follow in order, then the paths
 * they lead to that were `deleted` (a folder stands for everything in it), and
 * the newest revision `written` at each path.
 */
export function tabChanges(changes) {
  const moves = [];
  let deleted = new Set();
  let written = new Map();
  for (const change of changes) {
    if (change.op === 'move') {
      const {fromPath: from, path: to} = change;
      moves.push([from, to]);
      deleted = new Set([...deleted].filter(path => !within(path, to)));
      written = new Map([...written].map(([path, rev]) => [movedPath(path, from, to), rev]));
    } else if (change.op === 'delete') {
      deleted.add(change.path);
      written = new Map([...written].filter(([path]) => !within(path, change.path)));
    } else if (change.op === 'write' || change.op === 'create' || change.op === 'restore') {
      deleted.delete(change.path);
      written.set(change.path, change.seq);
    }
  }
  return {moves, deleted, written};
}
