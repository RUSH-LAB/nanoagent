'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

// Object keys that must never be used as map keys in the comment/note stores,
// since assigning them can pollute Object.prototype. Hoisted and frozen so the
// three write handlers below share one immutable, read-only guard list.
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

module.exports = async function comments_notes_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULE_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Notes: list all or get one ──
  if (req.method === 'GET' && pathname === '/api/notes') {
    const key = url.searchParams.get('key');
    const notes = loadJSON(NOTES_FILE);
    if (key) return json(res, 200, {note: Object.hasOwn(notes, key) ? notes[key] : null});
    return json(res, 200, {notes});
  }

  // ── Notes: save ──
  if (req.method === 'PUT' && pathname === '/api/notes') {
    try {
      const body = await readBody(req);
      const {key, content, title} = body;
      if (!key || typeof key !== 'string') return json(res, 400, {error: 'Missing or invalid key'});
      if (key.length > 200) return json(res, 400, {error: 'Key must be 200 characters or fewer'});
      if (typeof content !== 'string') return json(res, 400, {error: 'Content must be a string'});
      if (content.length > 50000) return json(res, 400, {error: 'Content must be 50000 characters or fewer'});
      if (PROTO_KEYS.includes(key)) return json(res, 400, {error: 'Invalid key'});
      if (title !== undefined && typeof title !== 'string') return json(res, 400, {error: 'title must be a string'});
      if (title && title.length > 500) return json(res, 400, {error: 'Title must be 500 characters or fewer'});
      const notes = loadJSON(NOTES_FILE);
      notes[key] = {content: sanitizeText(content), title: sanitizeText(title) || key, updatedAt: new Date().toISOString()};
      saveJSON(NOTES_FILE, notes);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Failed to save note: request body must be JSON with "key" (string) and "content" (string) fields'});
    }
  }

  // ── Notes: delete ──
  if (req.method === 'DELETE' && pathname === '/api/notes') {
    try {
      const body = await readBody(req);
      const {key} = body;
      if (!key || typeof key !== 'string') return json(res, 400, {error: 'Missing or invalid key'});
      if (PROTO_KEYS.includes(key)) return json(res, 400, {error: 'Invalid key'});
      const notes = loadJSON(NOTES_FILE);
      if (!Object.hasOwn(notes, key)) return json(res, 404, {error: 'Note not found'});
      delete notes[key];
      saveJSON(NOTES_FILE, notes);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Failed to delete note: request body must be JSON with "key" (string) identifying the note to delete'});
    }
  }

};
