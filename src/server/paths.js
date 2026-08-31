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

/** The repo root: this file lives two levels down, in src/server/. */
const PROJECT_ROOT = nodePath.dirname(nodePath.dirname(__dirname));

// ── The layout, as root-relative segments ───────────────────────────────────
const VAR_SEGS = ['var'];
const DATA_SEGS = [...VAR_SEGS, 'data'];
const LOGS_SEGS = [...VAR_SEGS, 'logs'];
const TRASH_SEGS = [...VAR_SEGS, 'trash'];
// Content is one tree per organization: content/<org slug>/{books,posts,...}.
// CONTENT_SEGS names only the level above those trees, which is why almost
// nothing uses it directly; a handler wants contentSegsFor(slug), because a
// handler always acts on behalf of somebody and that somebody is in exactly one
// workspace. The slug rather than the id, because this tree is read by people
// and tracked in git, and `content/Nbha3RwQIeWYd.../books/math` is not a path
// anybody can work with. Renaming an organization would therefore have to move
// its directory; nothing offers a rename yet.
const CONTENT_SEGS = ['content'];

/** The content root of one organization, as root-relative segments. */
const contentSegsFor = slug => [...CONTENT_SEGS, slug];

/** That organization's bibliography. */
const referencesSegsFor = slug => [...contentSegsFor(slug), 'bibliography', 'references.yaml'];

/** The directory /api/quicknote writes into, within one organization. */
const quicknoteSegsFor = slug => [...contentSegsFor(slug), 'posts', 'blog'];

const ACCESS_LOG_SEGS = [...LOGS_SEGS, 'access.log'];

/** The JSON store for `name`, as segments: dataFileSegs('comments'). */
const dataFileSegs = name => [...DATA_SEGS, `${name}.json`];

// ── Absolute paths, for the entry point ─────────────────────────────────────
const VAR_DIR = nodePath.join(PROJECT_ROOT, ...VAR_SEGS);
const DATA_DIR = nodePath.join(PROJECT_ROOT, ...DATA_SEGS);
const LOGS_DIR = nodePath.join(PROJECT_ROOT, ...LOGS_SEGS);
const TRASH_DIR = nodePath.join(PROJECT_ROOT, ...TRASH_SEGS);
const ACCESS_LOG = nodePath.join(PROJECT_ROOT, ...ACCESS_LOG_SEGS);
/**
 * The level holding every organization's tree, not any one organization's.
 *
 * Overridable, because provisioning a workspace now creates directories, and a
 * test that exercises that should not create them in the repository it is
 * testing. CONTENT_ROOT is what the org test sets alongside DATABASE_FILE; a
 * deployment that keeps content on another volume can set it too.
 */
const CONTENT_DIR = process.env.CONTENT_ROOT || nodePath.join(PROJECT_ROOT, ...CONTENT_SEGS);

/** One organization's content root, absolutely. */
const contentDirFor = slug => nodePath.join(CONTENT_DIR, slug);

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
  VAR_SEGS, DATA_SEGS, LOGS_SEGS, TRASH_SEGS, CONTENT_SEGS,
  contentSegsFor, referencesSegsFor, quicknoteSegsFor,
  ACCESS_LOG_SEGS, dataFileSegs,
  VAR_DIR, DATA_DIR, LOGS_DIR, TRASH_DIR, ACCESS_LOG, CONTENT_DIR,
  contentDirFor, dataFile,
};
