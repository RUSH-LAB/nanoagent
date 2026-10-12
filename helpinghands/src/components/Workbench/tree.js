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
 * `{files, folders}` from the API as nested nodes, folders before files and
 * each sorted by name with numbers in order (step2 before step10), as VS Code
 * shows them. A folder is a path or an object with one, whose other fields
 * (such as `access`) the node keeps. A folder implied by a file's path but
 * absent from `folders` is still shown.
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
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}) : a.type === 'folder' ? -1 : 1));
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
