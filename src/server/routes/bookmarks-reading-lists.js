'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

// ── Route-match regexes (module scope, reused per request) ──
// Each pattern is stateless (no /g, no /y flag) and used only as a boolean route
// guard via RE.test(pathname), so one shared instance per pattern is behavior-preserving
// across requests and is rebuilt 0 times per request. READING_LIST_ITEMS_RE is
// referenced at multiple call sites; sharing also deduplicates the repeated
// literals.
const READING_LIST_RE = /^\/api\/reading-lists\/[^/]+$/;
const READING_LIST_ITEMS_RE = /^\/api\/reading-lists\/[^/]+\/items$/;
const READING_LIST_EXPORT_RE = /^\/api\/reading-lists\/[^/]+\/export$/;


module.exports = async function bookmarks_reading_lists_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULE_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Bookmarks: list all ──
  if (req.method === 'GET' && pathname === '/api/bookmarks') {
    const data = loadJSON(BOOKMARKS_FILE);
    return json(res, 200, {bookmarks: data.bookmarks || []});
  }

  // ── Bookmarks: add ──
  if (req.method === 'POST' && pathname === '/api/bookmarks') {
    if (!rateLimit(`bookmarks:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: pagePath, title} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing path'});
      if (pagePath.length > 500) return json(res, 400, {error: 'Path must be 500 characters or fewer'});
      if (title !== undefined && typeof title === 'string' && title.length > 500) return json(res, 400, {error: 'Title must be 500 characters or fewer'});
      const data = loadJSON(BOOKMARKS_FILE);
      if (!data.bookmarks) data.bookmarks = [];
      if (data.bookmarks.some(b => b.path === pagePath)) {
        return json(res, 200, {success: true, bookmarks: data.bookmarks});
      }
      const bookmark = {
        path: sanitizeText(pagePath),
        title: sanitizeText(title) || pagePath,
        addedAt: new Date().toISOString(),
      };
      data.bookmarks.push(bookmark);
      saveJSON(BOOKMARKS_FILE, data);
      return json(res, 200, {success: true, bookmark});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Bookmarks: remove ──
  if (req.method === 'DELETE' && pathname === '/api/bookmarks') {
    try {
      const body = await readBody(req);
      const {path: pagePath} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing path'});
      const data = loadJSON(BOOKMARKS_FILE);
      if (!data.bookmarks) data.bookmarks = [];
      const idx = data.bookmarks.findIndex(b => b.path === pagePath);
      if (idx === -1) return json(res, 404, {error: 'Bookmark not found'});
      data.bookmarks.splice(idx, 1);
      saveJSON(BOOKMARKS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Analytics: content topics/keywords ──
  if (req.method === 'GET' && pathname === '/api/analytics/topics') {
    const topics = cached(cacheKey(req.auth?.orgId, 'analytics:topics'), 60000, () => {
      const STOP_WORDS = new Set([
        'the','a','an','is','are','was','were','be','been','being','have','has','had',
        'do','does','did','will','would','could','should','may','might','shall','can',
        'and','but','or','nor','for','yet','so','in','on','at','to','by','of','with',
        'from','up','about','into','through','during','before','after','above','below',
        'between','out','off','over','under','again','further','then','once','here',
        'there','when','where','why','how','all','each','every','both','few','more',
        'most','other','some','such','no','not','only','own','same','than','too','very',
        'just','because','as','until','while','this','that','these','those','it','its',
        'he','she','they','them','their','we','our','you','your','i','me','my','what',
        'which','who','whom','if',
      ]);

      const contentDir = contentRootFor(req.auth?.orgId);
      const freq = {};

      function scanMarkdown(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanMarkdown(full);
          } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            try {
              let text = fs.readFileSync(full, 'utf8');
              // Strip frontmatter
              text = text.replace(/^---[\s\S]*?---/, '');
              // Strip markdown syntax (links, images, code blocks, inline code, headings, bold/italic, html tags)
              text = text.replace(/```[\s\S]*?```/g, '');
              text = text.replace(/`[^`]*`/g, '');
              text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
              text = text.replace(/#{1,6}\s*/g, '');
              text = text.replace(/[*_~`>|\\[\]()-]/g, ' ');
              text = text.replace(/<[^>]+>/g, '');
              // Split into words, lowercase, filter
              const words = text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
              for (const w of words) {
                freq[w] = (freq[w] || 0) + 1;
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      scanMarkdown(contentDir);

      return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([word, count]) => ({word, count}));
    });

    return json(res, 200, {topics});
  }

  // ── Reading Lists: list all ──
  if (req.method === 'GET' && pathname === '/api/reading-lists') {
    const data = loadJSON(READING_LISTS_FILE);
    return json(res, 200, {lists: data.lists || []});
  }

  // ── Reading Lists: create ──
  if (req.method === 'POST' && pathname === '/api/reading-lists') {
    if (!rateLimit(`reading-lists:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name, description} = body;
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Missing name'});
      const trimmedName = name.trim();
      if (!trimmedName) return json(res, 400, {error: 'Missing name'});
      if (name.length > 200) return json(res, 400, {error: 'Name must be 200 characters or fewer'});
      if (description !== undefined && typeof description === 'string' && description.length > 5000) return json(res, 400, {error: 'Description must be 5000 characters or fewer'});
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = {
        id: crypto.randomUUID(),
        name: sanitizeText(trimmedName),
        description: sanitizeText((description || '').trim()),
        items: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.lists.push(list);
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: delete a list ──
  if (req.method === 'DELETE' && READING_LIST_RE.test(pathname) && !pathname.includes('/items')) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const idx = data.lists.findIndex(l => l.id === listId);
      if (idx === -1) return json(res, 404, {error: 'Reading list not found'});
      data.lists.splice(idx, 1);
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: add item ──
  if (req.method === 'POST' && READING_LIST_ITEMS_RE.test(pathname)) {
    if (!rateLimit(`rl-items:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const body = await readBody(req);
      const {path: itemPath, title, type} = body;
      if (!itemPath || typeof itemPath !== 'string') return json(res, 400, {error: 'Missing path'});
      if (itemPath.length > 500) return json(res, 400, {error: 'Path must be 500 characters or fewer'});
      if (title !== undefined && typeof title === 'string' && title.length > 500) return json(res, 400, {error: 'Title must be 500 characters or fewer'});
      const itemType = (type === 'reference' || type === 'doc') ? type : 'doc';
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      if (list.items.some(item => item.path === itemPath)) {
        return json(res, 200, {success: true, message: 'Item already in list'});
      }
      list.items.push({
        path: itemPath,
        title: sanitizeText(title) || itemPath,
        type: itemType,
        addedAt: new Date().toISOString(),
      });
      list.updatedAt = new Date().toISOString();
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: remove item ──
  if (req.method === 'DELETE' && READING_LIST_ITEMS_RE.test(pathname)) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const body = await readBody(req);
      const {path: itemPath} = body;
      if (!itemPath || typeof itemPath !== 'string') return json(res, 400, {error: 'Missing path'});
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      const idx = list.items.findIndex(item => item.path === itemPath);
      if (idx === -1) return json(res, 404, {error: 'Item not found in list'});
      list.items.splice(idx, 1);
      list.updatedAt = new Date().toISOString();
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: reorder items ──
  if (req.method === 'PATCH' && READING_LIST_ITEMS_RE.test(pathname)) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const body = await readBody(req);
      const {path: itemPath, direction} = body;
      if (!itemPath || typeof itemPath !== 'string') return json(res, 400, {error: 'Missing path'});
      if (direction !== 'up' && direction !== 'down') return json(res, 400, {error: 'direction must be "up" or "down"'});
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      const idx = list.items.findIndex(item => item.path === itemPath);
      if (idx === -1) return json(res, 404, {error: 'Item not found in list'});
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= list.items.length) {
        return json(res, 200, {success: true, list}); // already at boundary
      }
      [list.items[idx], list.items[swapIdx]] = [list.items[swapIdx], list.items[idx]];
      list.updatedAt = new Date().toISOString();
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: export as markdown ──
  if (req.method === 'GET' && READING_LIST_EXPORT_RE.test(pathname)) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      const format = url.searchParams.get('format') || 'md';
      const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');

      if (format === 'bibtex') {
        // Reuse the canonical exporter's escaper so reading-list BibTeX compiles
        // even when a value carries a LaTeX special (& % _ $ # { } ~ ^ or a
        // backslash). Non circular: research-tools does not require this module.
        // Share the mtime and size aware references.yaml memo used by every other
        // references handler instead of re-reading and re-parsing the bibliography
        // on each export. It returns {} on a missing or broken file, preserving
        // the prior `let refs = {}; try { ... } catch {}` empty-export fallback.
        const refs = ctx.references.load(fs, path, contentRootFor(req.auth?.orgId));
        const lines = [];
        for (const item of (list.items || [])) {
          if (item.type !== 'reference') continue;
          const key = item.path;
          const entry = refs[key];
          if (!entry) continue;
          const authors = (entry.author || []).join(' and ');
          const bibtexType = entry.type || 'misc';
          const fields = [];
          fields.push(`  title = {${ctx.references.cleanBibtexValue(entry.title || '')}}`);
          if (authors) fields.push(`  author = {${ctx.references.cleanBibtexValue(authors)}}`);
          if (entry.year) fields.push(`  year = {${ctx.references.cleanBibtexValue(entry.year)}}`);
          if (entry.venue) {
            if (bibtexType === 'inproceedings') fields.push(`  booktitle = {${ctx.references.cleanBibtexValue(entry.venue)}}`);
            else if (bibtexType === 'article') fields.push(`  journal = {${ctx.references.cleanBibtexValue(entry.venue)}}`);
            else fields.push(`  howpublished = {${ctx.references.cleanBibtexValue(entry.venue)}}`);
          }
          if (entry.url) fields.push(`  url = {${ctx.references.cleanBibtexValue(entry.url)}}`);
          if (entry.doi) fields.push(`  doi = {${ctx.references.cleanBibtexValue(entry.doi)}}`);
          lines.push(`@${bibtexType}{${key},\n${fields.join(',\n')}\n}`);
        }
        const bibtex = lines.join('\n\n') + '\n';
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${safeName}.bib"`,
          'Access-Control-Allow-Origin': CORS_ORIGIN,
        });
        return res.end(bibtex);
      }

      let md = `# ${list.name}\n\n`;
      if (list.description) md += `${list.description}\n\n`;
      if (list.items && list.items.length > 0) {
        list.items.forEach((item, i) => {
          const prefix = item.type === 'reference' ? '[Paper]' : '[Doc]';
          md += `${i + 1}. ${prefix} ${item.title || item.path}\n`;
        });
      } else {
        md += '_No items in this list._\n';
      }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}.md"`,
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });
      return res.end(md);
    } catch {
      return json(res, 500, {error: 'Export failed'});
    }
  }

};

// Exported so tests can assert the hoisted route-match regexes are stateless,
// referentially stable, and match the intended paths while rejecting near misses.
module.exports.routeRegexes = { READING_LIST_RE, READING_LIST_ITEMS_RE, READING_LIST_EXPORT_RE };
