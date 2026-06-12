'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Parse a numeric query parameter, clamping to `max` and falling back to `def`
// when the value is absent or non-numeric. Without the fallback a stray
// `?limit=abc` parses to NaN and `all.slice(offset, offset + NaN)` collapses the
// page to empty. Absent and valid numeric values keep their previous behavior.
function numericParam(raw, def, max) {
  const n = parseInt(raw, 10);
  return Math.min(Number.isNaN(n) ? def : n, max);
}

module.exports = async function discussions_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Discussions: list channels ──
  if (req.method === 'GET' && pathname === '/api/discussions') {
    const data = loadJSON(DISCUSSIONS_FILE);
    const channels = data.channels || {};
    const messages = data.messages || {};
    const list = Object.entries(channels).map(([id, ch]) => ({
      id,
      ...ch,
      messageCount: (messages[id] || []).length,
    }));
    return json(res, 200, {channels: list});
  }

  // ── Discussions: create channel ──
  if (req.method === 'POST' && pathname === '/api/discussions') {
    if (!rateLimit(`disc-create:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name, topic, linkedPage} = body;
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Missing or invalid channel name'});
      if (name.length > 100) return json(res, 400, {error: 'Channel name too long (max 100 characters)'});
      if (topic !== undefined && typeof topic !== 'string') return json(res, 400, {error: 'topic must be a string'});
      if (topic && topic.length > 500) return json(res, 400, {error: 'Topic must be 500 characters or fewer'});
      if (linkedPage !== undefined && typeof linkedPage !== 'string') return json(res, 400, {error: 'linkedPage must be a string'});
      if (linkedPage && linkedPage.length > 500) return json(res, 400, {error: 'linkedPage must be 500 characters or fewer'});
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels) data.channels = {};
      if (!data.messages) data.messages = {};
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!id) return json(res, 400, {error: 'Channel name must contain at least one alphanumeric character'});
      if (data.channels[id]) return json(res, 409, {error: 'Channel already exists'});
      data.channels[id] = {
        name: sanitizeText(name),
        topic: sanitizeText(topic) || '',
        linkedPage: linkedPage ? sanitizeText(linkedPage) : null,
        createdAt: new Date().toISOString(),
      };
      data.messages[id] = [];
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 201, {channel: {id, ...data.channels[id], messageCount: 0}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: get messages for a channel ──
  if (req.method === 'GET' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    const parts = pathname.split('/');
    let channelId;
    try { channelId = decodeURIComponent(parts[3]); }
    catch { return json(res, 400, {error: 'Invalid channel id'}); }
    const data = loadJSON(DISCUSSIONS_FILE);
    if (!data.channels || !data.channels[channelId]) {
      return json(res, 404, {error: 'Channel not found'});
    }
    const all = (data.messages || {})[channelId] || [];
    const limit = numericParam(url.searchParams.get('limit'), 200, 1000);
    // offset has no upper cap: guard NaN to 0, then floor at 0 (no Math.min).
    const offsetRaw = parseInt(url.searchParams.get('offset'), 10);
    const offset = Math.max(Number.isNaN(offsetRaw) ? 0 : offsetRaw, 0);
    const paginated = all.slice(offset, offset + limit);
    return json(res, 200, {messages: paginated, total: all.length});
  }

  // ── Discussions: search messages in a channel ──
  if (req.method === 'GET' && pathname.match(/^\/api\/discussions\/[^/]+\/messages\/search$/)) {
    const parts = pathname.split('/');
    let channelId;
    try { channelId = decodeURIComponent(parts[3]); }
    catch { return json(res, 400, {error: 'Invalid channel id'}); }
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    const data = loadJSON(DISCUSSIONS_FILE);
    if (!data.channels || !data.channels[channelId]) {
      return json(res, 404, {error: 'Channel not found'});
    }
    const all = (data.messages || {})[channelId] || [];
    const results = all.filter(m =>
      (m.text || '').toLowerCase().includes(query) || (m.author || '').toLowerCase().includes(query)
    );
    return json(res, 200, {results, total: results.length});
  }

  // ── Discussions: post message to a channel ──
  if (req.method === 'POST' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    if (!rateLimit(`disc-msg:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      let channelId;
      try { channelId = decodeURIComponent(parts[3]); }
      catch { return json(res, 400, {error: 'Invalid channel id'}); }
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {author, text} = body;
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid message text'});
      if (text.length > 5000) return json(res, 400, {error: 'Message text must be 5000 characters or fewer'});
      if (author !== undefined && typeof author !== 'string') return json(res, 400, {error: 'author must be a string'});
      if (author && author.length > 100) return json(res, 400, {error: 'Author must be 100 characters or fewer'});
      if (!data.messages) data.messages = {};
      if (!data.messages[channelId]) data.messages[channelId] = [];
      const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: sanitizeText(author) || 'Anonymous',
        text: sanitizeText(text),
        createdAt: new Date().toISOString(),
      };
      data.messages[channelId].push(message);
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 201, {message});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: edit a message in a channel ──
  if (req.method === 'PATCH' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    if (!rateLimit(`disc-edit:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      let channelId;
      try { channelId = decodeURIComponent(parts[3]); }
      catch { return json(res, 400, {error: 'Invalid channel id'}); }
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {messageId, text} = body;
      if (!messageId || typeof messageId !== 'string') return json(res, 400, {error: 'Missing or invalid messageId'});
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid text'});
      if (text.length > 5000) return json(res, 400, {error: 'Message text must be 5000 characters or fewer'});
      if (!data.messages || !data.messages[channelId]) {
        return json(res, 404, {error: 'No messages in channel'});
      }
      const msg = data.messages[channelId].find(m => m.id === messageId);
      if (!msg) return json(res, 404, {error: 'Message not found'});
      msg.text = sanitizeText(text);
      msg.editedAt = new Date().toISOString();
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true, message: msg});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: delete message from a channel ──
  if (req.method === 'DELETE' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    if (!rateLimit(`disc-delete:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      let channelId;
      try { channelId = decodeURIComponent(parts[3]); }
      catch { return json(res, 400, {error: 'Invalid channel id'}); }
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {messageId} = body;
      if (!messageId) return json(res, 400, {error: 'Missing messageId'});
      if (!data.messages || !data.messages[channelId]) {
        return json(res, 404, {error: 'No messages in channel'});
      }
      const idx = data.messages[channelId].findIndex(m => m.id === messageId);
      if (idx === -1) return json(res, 404, {error: 'Message not found'});
      data.messages[channelId].splice(idx, 1);
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: delete channel ──
  if (req.method === 'DELETE' && pathname.match(/^\/api\/discussions\/[^/]+$/)) {
    if (!rateLimit(`disc-del-ch:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      let channelId;
      try { channelId = decodeURIComponent(parts[3]); }
      catch { return json(res, 400, {error: 'Invalid channel id'}); }
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      delete data.channels[channelId];
      if (data.messages) delete data.messages[channelId];
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

};

module.exports.numericParam = numericParam;
