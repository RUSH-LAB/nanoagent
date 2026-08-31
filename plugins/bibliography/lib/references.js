/**
 * The bibliography's own model of itself: how references.yaml is read, and how
 * one entry becomes a citation.
 *
 * A library, not routes. It used to live inside a route module that also
 * answered for the AI assistant, and seven other route modules reached across
 * to `require` it, which is how a file named references.js quietly became the
 * place the whole server went for bibliography data. It is what it always was
 * now, and the plugin that owns the bibliography owns it.
 *
 * Nothing here reads a file. Callers pass a reader, so the same parse and the
 * same memo serve a plugin holding a content capability and a core handler
 * holding fs, and neither this file nor the plugin needs the filesystem.
 */
const yaml = require('js-yaml');
const {cleanBibtexValue} = require('./protocol');

/** Where the bibliography lives, relative to content/. */
const BIB_FILE = 'bibliography/references.yaml';

let referencesCache = null; // {mtimeMs, size, data} or null when uncached

/**
 * The bibliography, parsed once per change.
 *
 * `reader` is anything with `read(relative)` and `stat(relative)`: a plugin
 * hands in its content capability, and the server adapts fs into the same two
 * calls for the core handlers that ask through ctx. Neither this file nor the
 * plugin around it touches the filesystem, which is what makes the capability
 * a boundary rather than a suggestion.
 *
 * Memoized on mtime and size together, because a same-millisecond rewrite moves
 * the size when it does not move the clock. A reader with no `stat` (a test
 * double, usually) simply never caches.
 *
 * Every failure answers {}: a missing file, unreadable bytes, broken YAML. The
 * read-only endpoints then serve empty results, or a 404 for a key lookup,
 * rather than turning a bad file into a 500 on every request.
 */
function loadReferences(reader) {
  const stat = reader.stat ? reader.stat(BIB_FILE) : null;
  if (stat && referencesCache
      && referencesCache.mtimeMs === stat.mtimeMs
      && referencesCache.size === stat.size) {
    return referencesCache.data;
  }
  try {
    const text = reader.read(BIB_FILE);
    const data = text == null ? {} : (yaml.load(text) || {});
    referencesCache = stat ? {mtimeMs: stat.mtimeMs, size: stat.size, data} : null;
    return data;
  } catch {
    referencesCache = null;
    return {};
  }
}

// Build a citation string for one reference in the requested style. Shared by
// GET /api/references/format-all (mapped over every entry) and GET
// /api/references/format (called once for the looked-up entry) so the APA, MLA,
// and Chicago author-string and template logic lives in exactly one place. The
// caller passes already-normalized parts: `authors` an array, `year` a value or
// 'n.d.', and `title`/`venue` strings. `style` is matched case-sensitively —
// 'apa' and 'mla' have dedicated formats and every other value (including
// 'chicago') falls through to the Chicago-style default, preserving the original
// else branch. Output is byte-identical to the previous inline expressions for
// every style and for the 0-, 1-, and many-author branches.
function buildCitation(style, {authors, year, title, venue}) {
  if (style === 'apa') {
    const authorStr = authors.length === 0 ? 'Unknown' :
      authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ') :
      authors.slice(0, -1).map(a => a.split(' ').pop() + ', ' + a.split(' ').slice(0, -1).map(n => n[0] + '.').join(' ')).join(', ') + ', & ' + authors[authors.length - 1].split(' ').pop() + ', ' + authors[authors.length - 1].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ');
    return `${authorStr} (${year}). ${title}. ${venue ? venue + '.' : ''}`;
  }
  if (style === 'mla') {
    const authorStr = authors.length === 0 ? 'Unknown' :
      authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') :
      authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') + ', et al.';
    return `${authorStr}. "${title}." ${venue ? venue + ', ' : ''}${year}.`;
  }
  const authorStr = authors.join(', ') || 'Unknown';
  return `${authorStr}. "${title}." ${venue || ''} (${year}).`;
}

/**
 * The bibliography as text, or a throw when the file is not there.
 *
 * A plugin's content capability answers a missing file with null rather than an
 * exception, which is the kinder contract and the wrong one here: a handler
 * asked for the bibliography and there isn't one, which is a 500 and not an
 * empty bibliography. Handlers that must tell those apart read through this.
 */
function readReferencesText(reader) {
  const raw = reader.read(BIB_FILE);
  if (raw == null) throw new Error(`ENOENT: no such file, open '${BIB_FILE}'`);
  return raw;
}

/** Drop the memo, so the next read re-parses. A test hook, and only that. */
function _resetReferencesCache() {
  referencesCache = null;
}

module.exports = {BIB_FILE, loadReferences, readReferencesText, _resetReferencesCache, buildCitation, cleanBibtexValue};
