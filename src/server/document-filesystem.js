const path = require('path');

function missing(target) {
  const error = new Error(`ENOENT: no such file or directory, open '${target}'`);
  error.code = 'ENOENT';
  return error;
}

function normalizeRelative(root, target) {
  const relative = path.relative(root, path.resolve(target)).replace(/\\/g, '/');
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative.replace(/\/+$/, '').replace(/^content\//, '');
}

/**
 * A synchronous, read-only filesystem view backed by the document repository.
 * Legacy analysis code can keep its traversal algorithms while the production
 * request never reads workspace content from disk.
 */
function createDocumentFilesystem({files, documents, context, root, snapshot = null}) {
  const scope = context;
  const snapshotRows = Array.isArray(snapshot) ? snapshot : null;
  const byPath = snapshotRows ? new Map(snapshotRows.map(document => [document.path, document])) : null;
  const rows = () => snapshotRows ?? documents.list(scope);
  const documentAt = relative => byPath ? byPath.get(relative) : documents.get(scope, relative);

  function entries(relative) {
    const prefix = relative ? `${relative}/` : '';
    const found = new Map();
    for (const document of rows()) {
      if (!document.path.startsWith(prefix)) continue;
      const remainder = document.path.slice(prefix.length);
      if (!remainder) continue;
      const slash = remainder.indexOf('/');
      const name = slash < 0 ? remainder : remainder.slice(0, slash);
      if (!found.has(name)) found.set(name, slash >= 0);
    }
    return [...found].sort(([a], [b]) => a.localeCompare(b));
  }

  const overlay = Object.create(files);
  overlay.existsSync = target => {
    const relative = normalizeRelative(root, target);
    if (relative === null) return files.existsSync(target);
    if (relative === '') return true;
    return Boolean(documentAt(relative) || rows().some(document => document.path.startsWith(`${relative}/`)));
  };
  overlay.readFileSync = (target, encoding) => {
    const relative = normalizeRelative(root, target);
    if (relative === null) return files.readFileSync(target, encoding);
    const document = documentAt(relative);
    if (!document) throw missing(target);
    return encoding ? document.markdown : Buffer.from(document.markdown);
  };
  overlay.readdirSync = (target, options) => {
    const relative = normalizeRelative(root, target);
    if (relative === null) return files.readdirSync(target, options);
    const children = entries(relative);
    if (!options?.withFileTypes) return children.map(([name]) => name);
    return children.map(([name, directory]) => ({
      name,
      isDirectory: () => directory,
      isFile: () => !directory,
      isSymbolicLink: () => false,
    }));
  };
  overlay.statSync = target => {
    const relative = normalizeRelative(root, target);
    if (relative === null) return files.statSync(target);
    const document = relative && documentAt(relative);
    if (document) {
      const bytes = Buffer.byteLength(document.markdown);
      const mtimeMs = Date.parse(document.updatedAt) || 0;
      return {size: bytes, mtimeMs, mtime: new Date(mtimeMs), isFile: () => true, isDirectory: () => false};
    }
    if (relative === '' || rows().some(row => row.path.startsWith(`${relative}/`))) {
      return {size: 0, mtimeMs: 0, mtime: new Date(0), isFile: () => false, isDirectory: () => true};
    }
    throw missing(target);
  };

  // Any accidental attempt to mutate a workspace content path fails loudly.
  for (const method of ['writeFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync']) {
    overlay[method] = (...args) => {
      const target = normalizeRelative(root, args[0]);
      if (target !== null) throw new Error('Workspace content is read-only through the filesystem facade');
      return files[method](...args);
    };
  }
  overlay.mkdirSync = (...args) => {
    const target = normalizeRelative(root, args[0]);
    if (target !== null) throw new Error('Workspace content directories are virtual');
    return files.mkdirSync(...args);
  };

  return overlay;
}

module.exports = {createDocumentFilesystem, normalizeRelative};
