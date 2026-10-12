import nodePath from 'node:path';

export const TEST_SCOPE = Object.freeze({
  workspaceId: 'test-org',
  userId: 'test-user',
  membershipId: 'test-member',
  role: 'owner',
});

function rowFor(fs, root, relativePath, path = nodePath) {
  const absolutePath = path.join(root, relativePath);
  try {
    const markdown = fs.readFileSync(absolutePath, 'utf8');
    let updatedAt = new Date(0).toISOString();
    try {
      const stat = fs.statSync?.(absolutePath);
      const value = stat?.mtime ?? (Number.isFinite(stat?.mtimeMs) ? new Date(stat.mtimeMs) : null);
      if (value && !Number.isNaN(new Date(value).valueOf())) updatedAt = new Date(value).toISOString();
    } catch {}
    return {path: relativePath, markdown, updatedAt};
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Exposes an old in-memory filesystem fixture through the document-repository
 * interface used by production. This adapter exists only in tests while their
 * compact tree fixtures are retained; application routes never fall back to fs.
 */
export function documentsFromFs({fs, root, path = nodePath}) {
  function snapshot() {
    const rows = [];
    const walk = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolutePath, relativePath);
        else {
          const row = rowFor(fs, root, relativePath, path);
          if (row) rows.push(row);
        }
      }
    };
    walk(root);
    return rows;
  }

  return {
    async get(_scope, relativePath) {
      return rowFor(fs, root, relativePath, path);
    },
    async list() {
      return snapshot().map(({markdown: _markdown, ...row}) => row);
    },
    async snapshot() {
      return snapshot();
    },
  };
}

export function repositoryContext({fs, root, path = nodePath}) {
  return {
    documents: documentsFromFs({fs, root, path}),
    scopeFor: () => TEST_SCOPE,
  };
}
