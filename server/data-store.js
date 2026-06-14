/**
 * Atomic, cached JSON persistence for the API server's flat-file data stores.
 *
 * Drop-in replacement for the inline loadJSON/saveJSON that used to live in
 * server.js. The externally observable behaviour is identical to the originals:
 *
 *   - loadJSON(filePath): parse the file as JSON. A missing or corrupt file
 *     reads back as {}. Every call returns a fresh, mutable value.
 *   - saveJSON(filePath, data): serialize with JSON.stringify(data, null, 2)
 *     and create any missing parent directories recursively.
 *
 * On top of that it adds two hardening / performance improvements:
 *
 *   1. Atomic writes. saveJSON writes to a sibling temp file in the SAME
 *      directory, then fs.renameSync's it onto the target. rename is atomic on
 *      a single filesystem, so a crash or a concurrent write can never leave a
 *      half-written (truncated) store behind.
 *
 *   2. An in-process read cache keyed on (mtimeMs, size). loadJSON serves
 *      parsed data straight from memory when the file is unchanged on disk, and
 *      ALWAYS returns a deep copy, so a route that mutates the returned object
 *      before calling saveJSON cannot poison the cache. saveJSON writes through
 *      (it installs the freshly written value), so the next read is a hit. The
 *      cache is bounded to MAX_CACHE_ENTRIES with LRU eviction.
 *
 * Cache validity keys on both mtime AND size: if either changes on disk the
 * entry is stale and the file is re-read. Tracking size as well as mtime
 * catches same-millisecond rewrites that mtime alone would miss. The only blind
 * spot is a rewrite that keeps BOTH mtime and size identical, which a whole-file
 * JSON rewrite does not do in practice.
 */
const fs = require('fs');
const path = require('path');

// Bounded LRU cache: resolved absolute path -> {mtimeMs, size, data}.
const MAX_CACHE_ENTRIES = 200;
const cache = new Map();

// Monotonic counter for collision-free temp file names within this process.
let tmpCounter = 0;

// Structural deep copy via the native structuredClone global. Every value that
// reaches deepCopy is JSON-shaped: it is always the cached `data`, itself the
// output of a JSON parse (a fresh disk read on a miss, or the reparsed
// serialized value on the write-through path). Such values hold only JSON types
// (null, booleans, finite numbers, strings, arrays, plain objects), so
// structuredClone yields a copy deep-equal to, and structurally identical to,
// the former serialize-and-reparse round-trip, in one native traversal with no
// intermediate string. The `undefined` guard is kept exactly as before so an
// `undefined` input still yields `undefined`.
function deepCopy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// Read an entry and refresh its LRU recency (move to most-recently-used).
function cacheGet(key) {
  const entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

// Install an entry, refresh recency, and evict the oldest beyond the bound.
function cacheSet(key, mtimeMs, size, data) {
  cache.delete(key);
  cache.set(key, {mtimeMs, size, data});
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

/**
 * Load and parse a JSON file. Returns {} when the file is missing or corrupt.
 * Served from the in-process cache when the file is unchanged on disk; the
 * returned value is always a fresh deep copy the caller may safely mutate.
 */
function loadJSON(filePath) {
  const key = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(key);
  } catch {
    cache.delete(key); // file gone: drop any stale entry, never cache {}
    return {};
  }
  const entry = cacheGet(key);
  if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    return deepCopy(entry.data);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(key, 'utf-8'));
    cacheSet(key, stat.mtimeMs, stat.size, parsed); // cache owns `parsed`
    return deepCopy(parsed);                         // caller gets an isolated copy
  } catch {
    cache.delete(key); // corrupt: never cache the {} fallback
    return {};
  }
}

/**
 * Serialize data to a JSON file (2-space indent) atomically, creating any
 * missing parent directories. Updates the read cache write-through so the next
 * loadJSON is a hit returning this exact data.
 */
function saveJSON(filePath, data) {
  const key = path.resolve(filePath);
  const dir = path.dirname(key);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});

  const serialized = JSON.stringify(data, null, 2);
  const tmp = path.join(dir, `.${path.basename(key)}.${process.pid}.${tmpCounter++}.tmp`);
  fs.writeFileSync(tmp, serialized, 'utf-8');
  try {
    fs.renameSync(tmp, key); // atomic replace on the same filesystem
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
    throw err;
  }

  // Write through: cache exactly what a subsequent read would parse back.
  try {
    const stat = fs.statSync(key);
    cacheSet(key, stat.mtimeMs, stat.size, JSON.parse(serialized));
  } catch {
    cache.delete(key); // could not refresh: force a disk read next time
  }
}

// Diagnostics / test hooks. Not used by routes.
function _cacheSize() {
  return cache.size;
}

function _clearCache() {
  cache.clear();
}

// `deepCopy` is exported alongside the diagnostic hooks so the suite can
// exercise the `undefined` guard directly; that branch is unreachable through
// loadJSON/saveJSON, whose data is always JSON-shaped. Routes never import it.
module.exports = {loadJSON, saveJSON, deepCopy, MAX_CACHE_ENTRIES, _cacheSize, _clearCache};
