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
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Comments: list ──
  if (req.method === 'GET' && pathname === '/api/comments') {
    const page = url.searchParams.get('page');
    if (!page) return json(res, 400, {error: 'Missing page param'});
    // `parseInt` yields NaN for a present-but-non-numeric value (e.g. `?limit=abc`),
    // which would otherwise collapse the slice below to an empty page. Fall back to
    // the default in that case, then apply the existing clamps.
    const intParam = (name, fallback) => {
      const n = parseInt(url.searchParams.get(name), 10);
      return Number.isNaN(n) ? fallback : n;
    };
    const limit = Math.min(Math.max(intParam('limit', 100), 0), 500);
    const offset = Math.max(intParam('offset', 0), 0);
    const comments = loadJSON(COMMENTS_FILE);
    // Only treat an OWN key as a real page. A request-controlled `page` such as
    // `constructor` or `toString` resolves to a truthy inherited value, so the
    // `|| []` fallback would be skipped and `all.slice` would throw, hanging the
    // request until the socket timeout. Mirror the users-me read-path guard.
    const all = Object.hasOwn(comments, page) ? comments[page] : [];
    const paginated = all.slice(offset, offset + limit);
    return json(res, 200, {comments: paginated, total: all.length});
  }

  // ── Comments: create ──
  if (req.method === 'POST' && pathname === '/api/comments') {
    if (!rateLimit(`comments:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {page, author, text, parentId, userId} = body;
      if (!page || typeof page !== 'string') return json(res, 400, {error: 'Missing or invalid page'});
      if (page.length > 500) return json(res, 400, {error: 'Page must be 500 characters or fewer'});
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid text'});
      if (text.length > 5000) return json(res, 400, {error: 'Text must be 5000 characters or fewer'});
      if (PROTO_KEYS.includes(page)) return json(res, 400, {error: 'Invalid page'});
      if (author !== undefined && typeof author !== 'string') return json(res, 400, {error: 'author must be a string'});
      if (author && author.length > 100) return json(res, 400, {error: 'Author must be 100 characters or fewer'});
      if (parentId !== undefined && typeof parentId !== 'string') return json(res, 400, {error: 'parentId must be a string'});
      if (parentId && parentId.length > 200) return json(res, 400, {error: 'parentId must be 200 characters or fewer'});
      if (userId !== undefined && typeof userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      if (userId && userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      const comments = loadJSON(COMMENTS_FILE);
      if (!Object.hasOwn(comments, page)) comments[page] = [];
      const comment = {
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: sanitizeText(author) || 'Anonymous',
        text: sanitizeText(text),
        parentId: parentId ? sanitizeText(parentId) : null,
        userId: userId ? sanitizeText(userId) : null,
        createdAt: new Date().toISOString(),
      };
      comments[page].push(comment);
      saveJSON(COMMENTS_FILE, comments);
      return json(res, 200, {comment});
    } catch {
      return json(res, 400, {error: 'Failed to create comment: request body must be JSON with "page" (string) and "text" (string) fields'});
    }
  }

  // ── Comments: delete ──
  if (req.method === 'DELETE' && pathname === '/api/comments') {
    try {
      const body = await readBody(req);
      const {page, commentId, userId} = body;
      if (!page || !commentId) return json(res, 400, {error: 'Missing page or commentId'});
      const comments = loadJSON(COMMENTS_FILE);
      if (!Object.hasOwn(comments, page)) return json(res, 404, {error: 'Page not found'});
      const pageComments = comments[page];
      const idx = pageComments.findIndex(c => c.id === commentId);
      if (idx === -1) return json(res, 404, {error: 'Comment not found'});
      const comment = pageComments[idx];
      if (comment.userId && comment.userId !== userId) {
        const users = loadJSON(USERS_FILE);
        const requester = users[userId];
        if (!requester || requester.role !== 'owner') {
          return json(res, 403, {error: 'Only the comment author or an admin can delete this comment'});
        }
      }
      pageComments.splice(idx, 1);
      saveJSON(COMMENTS_FILE, comments);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

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
