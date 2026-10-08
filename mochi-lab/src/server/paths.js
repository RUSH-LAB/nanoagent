/**
 * Where the server keeps things, defined once.
 *
 * Two kinds of location:
 *
 *   var/       mutable runtime state the server writes: the JSON stores
 *              (var/data), the access log (var/logs) and soft-deleted files
 *              (var/trash). Ignored by git as a single directory rather than
 *              as three unrelated root entries.
 *   var/document-fs/   a logical root used only by the temporary filesystem
 *                      compatibility adapter; document bytes stay in SQL.
 *
 * Consumers come in two shapes, so the layout is published in two forms.
 *
 * server/index.js knows the real repo root and uses node's own path, so it
 * takes the absolute constants and the helpers below.
 *
 * Workspace content itself deliberately has no repository path. PostgreSQL and
 * object storage are its only live sources.
 */
const nodePath = require('path');

/** The repo root: this file lives two levels down, in src/server/. */
const PROJECT_ROOT = nodePath.dirname(nodePath.dirname(__dirname));

// ── The layout, as root-relative segments ───────────────────────────────────
const VAR_SEGS = ['var'];
const DATA_SEGS = [...VAR_SEGS, 'data'];
const LOGS_SEGS = [...VAR_SEGS, 'logs'];
const TRASH_SEGS = [...VAR_SEGS, 'trash'];

const ACCESS_LOG_SEGS = [...LOGS_SEGS, 'access.log'];

/** The JSON store for `name`, as segments: dataFileSegs('comments'). */
const dataFileSegs = name => [...DATA_SEGS, `${name}.json`];

// ── Absolute paths, for the entry point ─────────────────────────────────────
const VAR_DIR = nodePath.join(PROJECT_ROOT, ...VAR_SEGS);
const DATA_DIR = nodePath.join(PROJECT_ROOT, ...DATA_SEGS);
const LOGS_DIR = nodePath.join(PROJECT_ROOT, ...LOGS_SEGS);
const TRASH_DIR = nodePath.join(PROJECT_ROOT, ...TRASH_SEGS);
const ACCESS_LOG = nodePath.join(PROJECT_ROOT, ...ACCESS_LOG_SEGS);

/** The absolute path of the JSON store for `name`. */
const dataFile = name => nodePath.join(PROJECT_ROOT, ...dataFileSegs(name));

/**
 * The organization whose content is published at the site's bare routes.
 *
 * One workspace's tree has to be, or every existing URL would move: `/math`
 * would become `/mochi/math` and the 181 files that link to each other would
 * all be wrong at once. The rest are served under their own slug. Read from the
 * same environment variable the server provisions root's workspace with, so the
 * build and the API cannot disagree about which one is primary.
 */
const PRIMARY_ORG_SLUG = process.env.ROOT_ORG_SLUG || 'mochi';

module.exports = {
  PROJECT_ROOT, PRIMARY_ORG_SLUG,
  VAR_SEGS, DATA_SEGS, LOGS_SEGS, TRASH_SEGS,
  ACCESS_LOG_SEGS, dataFileSegs,
  VAR_DIR, DATA_DIR, LOGS_DIR, TRASH_DIR, ACCESS_LOG,
  dataFile,
};
