/**
 * Where the server keeps things, defined once.
 *
 * Two kinds of location:
 *
 *   var/       mutable runtime state the server writes: the JSON stores
 *              (var/data), the access log (var/logs) and soft-deleted files
 *              (var/trash). Ignored by git as a single directory rather than
 *              as three unrelated root entries.
 *   content/   authored source the server reads, including the bibliography.
 *
 * Consumers come in two shapes, so the layout is published in two forms.
 *
 * server/index.js knows the real repo root and uses node's own path, so it
 * takes the absolute constants and the helpers below.
 *
 * Route modules get their root from `ctx.PROJECT_ROOT` and their path module
 * from `ctx.path`, both of which a test may replace. They must therefore build
 * paths with the injected module, not this one, so they take the *_SEGS arrays
 * and spread them:
 *
 *     const {REFERENCES_SEGS} = require('../paths');
 *     const bibPath = path.join(PROJECT_ROOT, ...REFERENCES_SEGS);
 *
 * That keeps every route on the ctx contract while still leaving this file the
 * only place that spells the directory names.
 */
const nodePath = require('path');

/** The repo root: this file lives one level down, in server/. */
const PROJECT_ROOT = nodePath.dirname(__dirname);

// ── The layout, as root-relative segments ───────────────────────────────────
const VAR_SEGS = ['var'];
const DATA_SEGS = [...VAR_SEGS, 'data'];
const LOGS_SEGS = [...VAR_SEGS, 'logs'];
const TRASH_SEGS = [...VAR_SEGS, 'trash'];
const CONTENT_SEGS = ['content'];
const REFERENCES_SEGS = [...CONTENT_SEGS, 'bibliography', 'references.yaml'];
const ACCESS_LOG_SEGS = [...LOGS_SEGS, 'access.log'];

/** The JSON store for `name`, as segments: dataFileSegs('comments'). */
const dataFileSegs = name => [...DATA_SEGS, `${name}.json`];

// ── Absolute paths, for the entry point ─────────────────────────────────────
const VAR_DIR = nodePath.join(PROJECT_ROOT, ...VAR_SEGS);
const DATA_DIR = nodePath.join(PROJECT_ROOT, ...DATA_SEGS);
const LOGS_DIR = nodePath.join(PROJECT_ROOT, ...LOGS_SEGS);
const TRASH_DIR = nodePath.join(PROJECT_ROOT, ...TRASH_SEGS);
const ACCESS_LOG = nodePath.join(PROJECT_ROOT, ...ACCESS_LOG_SEGS);
const CONTENT_DIR = nodePath.join(PROJECT_ROOT, ...CONTENT_SEGS);
const REFERENCES_FILE = nodePath.join(PROJECT_ROOT, ...REFERENCES_SEGS);

/** The absolute path of the JSON store for `name`. */
const dataFile = name => nodePath.join(PROJECT_ROOT, ...dataFileSegs(name));

module.exports = {
  PROJECT_ROOT,
  VAR_SEGS, DATA_SEGS, LOGS_SEGS, TRASH_SEGS, CONTENT_SEGS,
  REFERENCES_SEGS, ACCESS_LOG_SEGS, dataFileSegs,
  VAR_DIR, DATA_DIR, LOGS_DIR, TRASH_DIR, ACCESS_LOG, CONTENT_DIR,
  REFERENCES_FILE, dataFile,
};
