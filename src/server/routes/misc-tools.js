'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

const { numericParam } = require('../server-utils');
const {DATA_SEGS, dataFileSegs} = require('../paths');

// Object keys that must never be used as property names (prototype-pollution guard).
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// Stop words stripped from the keyword list in GET /api/suggest, built once at
// module load instead of rebuilt on every request. The set holds only constant
// string literals and is read only (`.has` membership tests), so hoisting it
// leaves the suggestion output identical. Mirrors the RECOMMEND_STOP_WORDS and
// SIMILAR_STOP_WORDS sets that used to live in the content-analysis modules.
const SUGGEST_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'and','but','or','nor','not','so','yet','for','of','in','on','at','to','by','with',
  'from','as','into','about','between','through','after','before','during','without',
  'this','that','these','those','it','its','he','she','they','we','you','i','me','my',
  'his','her','our','their','your','which','what','who','whom','how','when','where','why']);

// ── Batch-export markdown render regexes (GET /api/export/batch) ──
// The batch-export handler renders up to ~100 markdown files per request, each
// through this fixed chain of String.prototype.replace calls. Every pattern is
// used ONLY through replace, which resets lastIndex to 0 on entry and exit, so a
// single shared module-scope instance yields byte-identical output to the former
// per-file inline literals while saving one RegExp allocation per pattern per
// file. Patterns are copied verbatim from the former inline sites; the three tiny
// escape regexes (for &, <, >) stay inline in the code-fence callback.
const BATCH_CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;
const BATCH_H4_RE = /^#### (.+)$/gm;
const BATCH_H3_RE = /^### (.+)$/gm;
const BATCH_H2_RE = /^## (.+)$/gm;
const BATCH_H1_RE = /^# (.+)$/gm;
const BATCH_BOLD_RE = /\*\*(.+?)\*\*/g;
const BATCH_ITALIC_RE = /\*(.+?)\*/g;
const BATCH_INLINE_CODE_RE = /`([^`]+)`/g;
const BATCH_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const BATCH_LIST_RE = /(^- .+$(\n- .+$)*)/gm;
const BATCH_BLOCKQUOTE_RE = /^> (.+)$/gm;
const BATCH_PARA_RE = /^(?!<[a-z/])((?!\s*$).+)$/gm;
const BATCH_BLANK_LINES_RE = /\n{3,}/g;

// ── Task (Kanban) validation arrays (POST/PUT /api/tasks) ──
// The allowed task status and priority values are invariant and read only via
// `.includes(...)` membership checks. Built once at module load and frozen so a
// handler can never mutate the shared array, instead of reallocating both arrays
// on every POST and PUT request. Mirrors the frozen-array convention of
// PROTO_KEYS above and the researchtools-templates-hoist stream.
const TASK_STATUSES = Object.freeze(['todo', 'doing', 'done']);
const TASK_PRIORITIES = Object.freeze(['low', 'medium', 'high']);

module.exports = async function misc_tools_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Content duplicate detection ──
  if (req.method === 'GET' && pathname === '/api/content-duplicates') {
    try {
      const duplicates = cached(cacheKey(req.auth?.orgId, 'content-duplicates'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
        const files = [];
        function collectFiles(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              collectFiles(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                let title = entry.name.replace(/\.(mdx?|md)$/, '');
                if (fmMatch) {
                  const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                  if (titleMatch) title = titleMatch[1];
                }
                files.push({
                  path: path.relative(contentRootFor(req.auth?.orgId), fullPath),
                  title,
                  titleLower: title.toLowerCase().trim(),
                });
              } catch {}
            }
          }
        }
        collectFiles(contentDir);
        const groups = {};
        for (const f of files) {
          if (!groups[f.titleLower]) groups[f.titleLower] = [];
          groups[f.titleLower].push(f);
        }
        return Object.values(groups)
          .filter(g => g.length > 1)
          .map(g => ({title: g[0].title, files: g.map(f => f.path)}));
      });
      return json(res, 200, {duplicates, count: duplicates.length});
    } catch {
      return json(res, 500, {error: 'Duplicate detection failed'});
    }
  }

  // ── Content stats timeline ──

  // ── Content health check ──
  if (req.method === 'GET' && pathname === '/api/content-health') {
    try {
      const health = cached(cacheKey(req.auth?.orgId, 'content-health'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
        const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        const pages = new Map();
        const allLinks = [];
        let draftCount = 0;

        function scanHealth(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanHealth(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              const relPath = path.relative(contentRootFor(req.auth?.orgId), fullPath);
              let id = relPath.replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
              if (id.endsWith('/index')) id = id.slice(0, -6);
              const content = fs.readFileSync(fullPath, 'utf-8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fmMatch) {
                const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (titleMatch) title = titleMatch[1];
                if (/^draft:\s*true/m.test(fmMatch[1])) draftCount++;
              }
              pages.set(id, {title, path: relPath});
              WIKI_LINK_RE.lastIndex = 0;
              let m;
              while ((m = WIKI_LINK_RE.exec(content)) !== null) {
                allLinks.push({source: id, target: m[1].trim(), type: 'wiki'});
              }
              const MD_LINK_RE = /\[([^\]]*)\]\(\/([^)#?]+)\)/g;
              while ((m = MD_LINK_RE.exec(content)) !== null) {
                allLinks.push({source: id, target: m[2].trim(), type: 'markdown'});
              }
            }
          }
        }
        scanHealth(contentDir);

        const pageIds = new Set(pages.keys());
        // The suffix-match fallbacks below scan the page id list, which is
        // loop-invariant: pageIds is never mutated inside the link loop. Spread it
        // once here instead of rebuilding [...pageIds] per link (twice on the
        // matched branch). Set insertion order is preserved, so .some() returns
        // the same boolean and .find() the same first match for every target.
        const pageIdList = [...pageIds];
        const brokenLinks = [];
        const incomingLinks = new Map();
        for (const link of allLinks) {
          const target = link.target;
          // `target` is fixed for this link, so the `'/' + target` suffix probe is
          // loop-invariant across the pageIdList scan. Build it once here instead of
          // re-concatenating per id inside both the .some and .find callbacks.
          const slashTarget = '/' + target;
          const found = pageIds.has(target) || pageIdList.some(id => id.endsWith(target) || id.endsWith(slashTarget));
          if (!found) {
            brokenLinks.push({source: link.source, target, type: link.type || 'wiki'});
          } else {
            const resolvedTarget = pageIds.has(target) ? target : pageIdList.find(id => id.endsWith(target) || id.endsWith(slashTarget));
            if (resolvedTarget) {
              incomingLinks.set(resolvedTarget, (incomingLinks.get(resolvedTarget) || 0) + 1);
            }
          }
        }

        const orphanPages = [];
        for (const [id, info] of pages) {
          if (!incomingLinks.has(id) && !id.includes('index')) {
            orphanPages.push({id, title: info.title});
          }
        }

        return {
          totalPages: pages.size,
          draftCount,
          brokenLinks: brokenLinks.slice(0, 50),
          brokenLinkCount: brokenLinks.length,
          orphanPages: orphanPages.slice(0, 30),
          orphanPageCount: orphanPages.length,
          totalLinks: allLinks.length,
        };
      });
      return json(res, 200, health);
    } catch {
      return json(res, 500, {error: 'Content health check failed'});
    }
  }

  // ── Create snapshot ──
  if (req.method === 'POST' && pathname === '/api/snapshots') {
    if (!rateLimit(`snapshots:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, name} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Name is required'});
      const fullPath = path.join(contentRootFor(req.auth?.orgId), filePath);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      const content = fs.readFileSync(fullPath, 'utf-8');
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      if (!snapshots[filePath]) snapshots[filePath] = [];
      const snapshot = {
        id: crypto.randomUUID(),
        name: sanitizeText(name).slice(0, 200),
        content,
        createdAt: new Date().toISOString(),
      };
      snapshots[filePath].push(snapshot);
      if (snapshots[filePath].length > 10) {
        snapshots[filePath] = snapshots[filePath].slice(-10);
      }
      saveJSON(SNAPSHOTS_FILE, snapshots);
      return json(res, 200, {success: true, snapshot: {id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── List snapshots for a file ──
  if (req.method === 'GET' && pathname === '/api/snapshots') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const snapshots = loadJSON(SNAPSHOTS_FILE);
    const fileSnapshots = (snapshots[filePath] || []).map(s => ({id: s.id, name: s.name, createdAt: s.createdAt}));
    return json(res, 200, {snapshots: fileSnapshots});
  }

  // ── Restore file from snapshot ──
  if (req.method === 'POST' && pathname === '/api/snapshots/restore') {
    if (!rateLimit(`snapshots-restore:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, snapshotId} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (!snapshotId || typeof snapshotId !== 'string') return json(res, 400, {error: 'snapshotId is required'});
      const fullPath = path.join(contentRootFor(req.auth?.orgId), filePath);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      const fileSnapshots = snapshots[filePath] || [];
      const snapshot = fileSnapshots.find(s => s.id === snapshotId);
      if (!snapshot) return json(res, 404, {error: 'Snapshot not found'});
      fs.writeFileSync(fullPath, snapshot.content, 'utf-8');
      invalidateCache(cacheKey(req.auth?.orgId, 'search'));
      return json(res, 200, {success: true, restored: {id: snapshot.id, name: snapshot.name}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Delete snapshot ──
  if (req.method === 'DELETE' && pathname === '/api/snapshots') {
    if (!rateLimit(`snapshots-delete:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, snapshotId} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (!snapshotId || typeof snapshotId !== 'string') return json(res, 400, {error: 'snapshotId is required'});
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      if (!snapshots[filePath]) return json(res, 404, {error: 'No snapshots for this file'});
      const idx = snapshots[filePath].findIndex(s => s.id === snapshotId);
      if (idx === -1) return json(res, 404, {error: 'Snapshot not found'});
      snapshots[filePath].splice(idx, 1);
      if (snapshots[filePath].length === 0) delete snapshots[filePath];
      saveJSON(SNAPSHOTS_FILE, snapshots);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Whiteboard ──
  if (pathname === '/api/whiteboard') {
    if (req.method === 'POST') {
      if (!rateLimit(`whiteboard:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {id, elements} = body;
        if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing id'});
        if (!Array.isArray(elements)) return json(res, 400, {error: 'elements must be an array'});
        const safeId = sanitizeText(id).slice(0, 200);
        const safeElements = elements.slice(0, 500).map(el => ({
          type: sanitizeText(String(el.type || 'note')).slice(0, 50),
          x: typeof el.x === 'number' ? el.x : 0,
          y: typeof el.y === 'number' ? el.y : 0,
          w: typeof el.w === 'number' ? el.w : 160,
          h: typeof el.h === 'number' ? el.h : 100,
          text: sanitizeText(String(el.text || '')).slice(0, 1000),
          color: /^#[0-9a-fA-F]{3,8}$/.test(el.color) ? el.color : '#fef3c7',
        }));
        const whiteboards = loadJSON(WHITEBOARDS_FILE);
        whiteboards[safeId] = {id: safeId, elements: safeElements, updatedAt: new Date().toISOString()};
        saveJSON(WHITEBOARDS_FILE, whiteboards);
        return json(res, 200, {success: true, whiteboard: whiteboards[safeId]});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      const whiteboards = loadJSON(WHITEBOARDS_FILE);
      if (id) {
        if (!Object.hasOwn(whiteboards, id)) return json(res, 404, {error: 'Whiteboard not found'});
        return json(res, 200, {whiteboard: whiteboards[id]});
      }
      return json(res, 400, {error: 'Missing id parameter. Use GET /api/whiteboards to list all.'});
    }
    if (req.method === 'DELETE') {
      if (!rateLimit(`whiteboard-del:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, {error: 'Missing id parameter'});
      const whiteboards = loadJSON(WHITEBOARDS_FILE);
      if (!Object.hasOwn(whiteboards, id)) return json(res, 404, {error: 'Whiteboard not found'});
      delete whiteboards[id];
      saveJSON(WHITEBOARDS_FILE, whiteboards);
      return json(res, 200, {success: true});
    }
  }

  if (req.method === 'GET' && pathname === '/api/whiteboards') {
    const whiteboards = loadJSON(WHITEBOARDS_FILE);
    const list = Object.values(whiteboards).map(wb => ({id: wb.id, elementCount: (wb.elements || []).length, updatedAt: wb.updatedAt}));
    return json(res, 200, {whiteboards: list});
  }

  // ── Flashcards: get cards due for review (SM-2) ──
  // Uses per-user keyed structure consistent with other flashcard endpoints
  if (req.method === 'GET' && pathname === '/api/flashcards/review') {
    const {userId} = req.auth;
    const today = new Date().toISOString().slice(0, 10);
    const data = loadJSON(FLASHCARDS_FILE);
    const cards = (Object.hasOwn(data, userId) ? data[userId] : []).filter(c => c.nextReview <= today);
    cards.sort((a, b) => (a.nextReview || '').localeCompare(b.nextReview || ''));
    return json(res, 200, {cards, count: cards.length});
  }

  // ── Mindmap from headings ──
  if (req.method === 'GET' && pathname === '/api/file/mindmap') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // The mindmap tree is a pure function of this one file's content, so memoize
      // the whole payload keyed by path for the TTL while the json() write below
      // still runs on every request. Mirrors cached(cacheKey(req.auth?.orgId, 'filequality:'+path),30000)
      // in this file. The readFileSync stays INSIDE the closure, so a missing file still
      // throws into the outer catch and the 404 is never cached (cached stores
      // nothing when fn throws).
      const result = cached(cacheKey(req.auth?.orgId, 'filemindmap:' + filePath), 30000, () => {
        let md = fs.readFileSync(path.join(contentRootFor(req.auth?.orgId), filePath), 'utf-8');
        // Strip frontmatter
        md = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
        // Parse headings
        const headings = [];
        for (const line of md.split('\n')) {
          const m = line.match(/^(#{1,4})\s+(.+)/);
          if (m) headings.push({level: m[1].length, text: m[2].replace(/[*_`\[\]]/g, '').trim()});
        }
        // Build tree
        const title = filePath.replace(/^.*\//, '').replace(/\.(md|mdx)$/, '');
        const root = {text: title, children: []};
        const stack = [{node: root, level: 0}];
        for (const h of headings) {
          const child = {text: h.text, children: []};
          while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
          stack[stack.length - 1].node.children.push(child);
          stack.push({node: child, level: h.level});
        }
        return {root};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Tasks (Kanban) ──
  if (pathname === '/api/tasks') {
    if (req.method === 'POST') {
      if (!rateLimit(`tasks:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {title, description, status, priority} = body;
        if (!title || typeof title !== 'string' || !title.trim()) return json(res, 400, {error: 'Missing title'});
        const safeStatus = TASK_STATUSES.includes(status) ? status : 'todo';
        const safePriority = TASK_PRIORITIES.includes(priority) ? priority : 'medium';
        const data = loadJSON(TASKS_FILE);
        if (!data.tasks) data.tasks = [];
        const task = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          title: sanitizeText(title.trim()).slice(0, 200),
          description: description ? sanitizeText(String(description).trim()).slice(0, 2000) : '',
          status: safeStatus,
          priority: safePriority,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        data.tasks.push(task);
        saveJSON(TASKS_FILE, data);
        return json(res, 201, {success: true, task});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'GET') {
      const data = loadJSON(TASKS_FILE);
      const tasks = data.tasks || [];
      // Single pass: bucket each task by status in source order. A status other
      // than todo/doing/done lands in no bucket; counts derive from bucket lengths.
      const grouped = {todo: [], doing: [], done: []};
      for (const t of tasks) {
        if (t.status === 'todo') grouped.todo.push(t);
        else if (t.status === 'doing') grouped.doing.push(t);
        else if (t.status === 'done') grouped.done.push(t);
      }
      return json(res, 200, {tasks, grouped, counts: {todo: grouped.todo.length, doing: grouped.doing.length, done: grouped.done.length}});
    }
    if (req.method === 'PUT') {
      if (!rateLimit(`tasks:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {id, status, title, description, priority} = body;
        if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing id'});
        const data = loadJSON(TASKS_FILE);
        if (!data.tasks) data.tasks = [];
        const task = data.tasks.find(t => t.id === id);
        if (!task) return json(res, 404, {error: 'Task not found'});
        if (status !== undefined && TASK_STATUSES.includes(status)) task.status = status;
        if (title !== undefined && typeof title === 'string' && title.trim()) task.title = sanitizeText(title.trim()).slice(0, 200);
        if (description !== undefined) task.description = sanitizeText(String(description).trim()).slice(0, 2000);
        if (priority !== undefined && TASK_PRIORITIES.includes(priority)) task.priority = priority;
        task.updatedAt = new Date().toISOString();
        saveJSON(TASKS_FILE, data);
        return json(res, 200, {success: true, task});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'DELETE') {
      if (!rateLimit(`tasks-del:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {id} = body;
        if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing id'});
        const data = loadJSON(TASKS_FILE);
        if (!data.tasks) data.tasks = [];
        const idx = data.tasks.findIndex(t => t.id === id);
        if (idx === -1) return json(res, 404, {error: 'Task not found'});
        data.tasks.splice(idx, 1);
        saveJSON(TASKS_FILE, data);
        return json(res, 200, {success: true});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
  }

  // ── Debug: list all registered route patterns ──
  if (req.method === 'GET' && pathname === '/api/debug/routes') {
    return json(res, 200, {
      totalHandlers: _routeDiagnostics.totalHandlers,
      uniqueRoutes: _routeDiagnostics.uniqueRoutes,
      duplicateCount: _routeDiagnostics.duplicateCount,
      deadCodeLines: _routeDiagnostics.deadCodeLines,
      startupMs: _routeDiagnostics.startupMs,
      memoryAtStartupMB: _routeDiagnostics.memoryAtStartupMB,
      routes: _routeDiagnostics.routes,
      duplicates: _routeDiagnostics.duplicates,
    });
  }

  // ── Quick Note: fast capture to markdown file ──
  if (req.method === 'POST' && pathname === '/api/quicknote') {
    if (!rateLimit(`quicknote:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {text, title} = body;
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return json(res, 400, {error: 'Missing or empty text'});
      }
      if (text.length > MAX_TEXT_LENGTH) {
        return json(res, 400, {error: 'Text too long'});
      }

      const now = new Date();
      const datePrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
      if (title !== undefined && typeof title === 'string' && title.length > 500) {
        return json(res, 400, {error: 'Title must be 500 characters or fewer'});
      }
      const cleanTitle = title && typeof title === 'string' && title.trim().length > 0
        ? sanitizeText(title.trim()).slice(0, 500)
        : null;

      // Build slug from title or timestamp
      let slug;
      if (cleanTitle) {
        slug = cleanTitle
          .toLowerCase()
          .replace(/[^a-z0-9一-鿿]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || `note-${Date.now()}`;
      } else {
        slug = `note-${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
      }

      const filename = `${datePrefix}-${slug}.md`;
      const blogDir = path.join(contentRootFor(req.auth?.orgId), 'posts', 'blog');
      const filePath = path.join(blogDir, filename);

      // Ensure blog directory exists
      if (!fs.existsSync(blogDir)) {
        fs.mkdirSync(blogDir, {recursive: true});
      }

      // Avoid overwriting existing files
      let finalPath = filePath;
      let finalFilename = filename;
      if (fs.existsSync(filePath)) {
        const suffix = `_${Date.now().toString(36)}`;
        finalFilename = `${datePrefix}-${slug}${suffix}.md`;
        finalPath = path.join(blogDir, finalFilename);
      }

      const frontmatterTitle = cleanTitle || `Quick Note ${datePrefix}`;
      const content = [
        '---',
        `slug: ${slug}`,
        `title: "${frontmatterTitle.replace(/"/g, '\\"')}"`,
        `authors: [zeyu]`,
        `tags: [quick-note]`,
        `draft: true`,
        '---',
        '',
        sanitizeText(text.trim()),
        '',
      ].join('\n');

      fs.writeFileSync(finalPath, content, 'utf-8');
      const relativePath = path.relative(contentRootFor(req.auth?.orgId), finalPath);
      return json(res, 200, {success: true, path: relativePath, filename: finalFilename});
    } catch (err) {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/quicknote') {
    try {
      // Param-free deterministic scan: memoize on a 60s window so repeated
      // requests do not re-walk content/posts/blog. A thrown scan propagates out
      // of cached() before anything is stored, so the outer catch below still
      // returns the empty 200 and that failure is never cached.
      const result = cached(cacheKey(req.auth?.orgId, 'quicknote-list'), 60000, () => {
        const blogDir = path.join(contentRootFor(req.auth?.orgId), 'posts', 'blog');
        if (!fs.existsSync(blogDir)) {
          return {notes: [], total: 0};
        }
        const files = fs.readdirSync(blogDir)
          .filter(f => f.endsWith('.md'))
          .sort((a, b) => b.localeCompare(a)); // newest first by filename (date-prefixed)

        const notes = [];
        for (const file of files) {
          if (notes.length >= 10) break;
          try {
            const raw = fs.readFileSync(path.join(blogDir, file), 'utf-8');
            // Check if it's a quick note (has quick-note tag)
            if (!raw.includes('quick-note')) continue;
            // Extract title from frontmatter
            const titleMatch = raw.match(/^title:\s*"?(.+?)"?\s*$/m);
            const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
            // Extract body (after frontmatter)
            const bodyMatch = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)/);
            notes.push({
              filename: file,
              title: titleMatch ? titleMatch[1] : file,
              date: dateMatch ? dateMatch[1] : null,
              preview: bodyMatch ? bodyMatch[1].trim().slice(0, 200) : '',
              path: `posts/blog/${file}`,
            });
          } catch {}
        }
        return {notes, total: notes.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 200, {notes: [], total: 0});
    }
  }

  // ── Content quality scoring ──
  if (req.method === 'GET' && pathname === '/api/file/quality') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // The quality score is a pure function of this one file's content, so
      // memoize the whole payload keyed by path for the TTL while the json() write
      // below still runs on every request. Mirrors cached(cacheKey(req.auth?.orgId, 'filestyle:'+path),30000)
      // in content-analysis-b.js and cached(cacheKey(req.auth?.orgId, 'fileinfo:'+path),30000) in
      // graph-trash-files.js. The readFileSync stays INSIDE the closure, so a
      // missing file still throws into the outer catch and the 404 is never cached
      // (cached stores nothing when fn throws).
      const result = cached(cacheKey(req.auth?.orgId, 'filequality:' + filePath), 30000, () => {
        const content = fs.readFileSync(path.join(contentRootFor(req.auth?.orgId), filePath), 'utf-8');
        const suggestions = [];

        // 1. Word count score (max 25)
        const bodyText = content.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/```[\s\S]*?```/g, '').replace(/!?\[.*?\]\(.*?\)/g, '');
        const words = bodyText.split(/\s+/).filter(Boolean).length;
        let wordsScore = 0;
        if (words >= 1000) wordsScore = 25;
        else if (words >= 500) wordsScore = 20;
        else if (words >= 200) wordsScore = 15;
        else if (words >= 100) wordsScore = 10;
        else wordsScore = 5;
        if (words < 500) suggestions.push('Add more content — aim for at least 500 words for a substantive document');

        // 2. Frontmatter structure (max 15)
        const fm = content.match(/^---\n([\s\S]*?)\n---/);
        let structureFmScore = 0;
        if (fm) {
          structureFmScore += 5;
          if (/^title:/m.test(fm[1])) structureFmScore += 5;
          else suggestions.push('Add a title field to frontmatter');
          if (/^date:/m.test(fm[1])) structureFmScore += 5;
          else suggestions.push('Add a date field to frontmatter');
        } else {
          suggestions.push('Add YAML frontmatter with title and date fields');
        }

        // 3. Heading structure (max 20)
        const h1s = (content.match(/^# .+$/gm) || []).length;
        const h2s = (content.match(/^## .+$/gm) || []).length;
        const h3s = (content.match(/^### .+$/gm) || []).length;
        const totalHeadings = h1s + h2s + h3s;
        let structureHdScore = 0;
        if (totalHeadings >= 5) structureHdScore = 20;
        else if (totalHeadings >= 3) structureHdScore = 15;
        else if (totalHeadings >= 1) structureHdScore = 10;
        else structureHdScore = 0;
        if (totalHeadings === 0) suggestions.push('Add headings (##, ###) to organize content');
        else if (h2s === 0 && h3s === 0) suggestions.push('Add sub-headings (##, ###) for better structure');

        const structureScore = structureFmScore + structureHdScore;

        // 4. Citations (max 10)
        const citationMatches = content.match(/\[@[^\]]+\]/g) || [];
        const citationsCount = citationMatches.length;
        let citationsScore = Math.min(10, citationsCount * 2);
        if (citationsCount === 0) suggestions.push('Add citations [@key] to reference sources');

        // 5. Media — images (max 10)
        const imageMatches = content.match(/!\[[^\]]*\]\([^)]+\)/g) || [];
        const imageCount = imageMatches.length;
        let mediaScore = Math.min(10, imageCount * 3);
        if (imageCount === 0) suggestions.push('Add images to enhance visual engagement');

        // 6. Code blocks (max 10)
        const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
        const codeCount = codeBlocks.length;
        mediaScore = Math.min(10, mediaScore + Math.min(5, codeCount * 2));
        if (codeCount === 0 && /technical|code|programming|algorithm/i.test(content)) {
          suggestions.push('Add code blocks to illustrate technical concepts');
        }

        // 7. Readability — average sentence length (max 10)
        const sentences = bodyText.replace(/\n/g, ' ').split(/[.!?]+/).filter(s => s.trim().length > 5);
        const avgSentenceLen = sentences.length > 0 ? sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length : 0;
        let readabilityScore = 0;
        if (sentences.length === 0) {
          readabilityScore = 0;
        } else if (avgSentenceLen <= 15) {
          readabilityScore = 10;
        } else if (avgSentenceLen <= 20) {
          readabilityScore = 8;
        } else if (avgSentenceLen <= 25) {
          readabilityScore = 5;
        } else {
          readabilityScore = 2;
          suggestions.push('Shorten sentences for better readability — aim for 15-20 words per sentence');
        }

        // 8. Total
        const totalScore = Math.max(0, Math.min(100, wordsScore + structureScore + citationsScore + mediaScore + readabilityScore));
        const level = totalScore >= 80 ? 'excellent' : totalScore >= 60 ? 'good' : totalScore >= 40 ? 'adequate' : totalScore >= 20 ? 'needs-improvement' : 'minimal';

        return {
          path: filePath,
          score: totalScore,
          level,
          breakdown: {
            words: {score: wordsScore, max: 25, wordCount: words},
            structure: {score: structureScore, max: 35, frontmatter: structureFmScore, headings: structureHdScore, headingCounts: {h1: h1s, h2: h2s, h3: h3s}},
            citations: {score: citationsScore, max: 10, count: citationsCount},
            media: {score: mediaScore, max: 10, images: imageCount, codeBlocks: codeCount},
            readability: {score: readabilityScore, max: 10, avgSentenceLength: Math.round(avgSentenceLen * 10) / 10, sentenceCount: sentences.length},
          },
          suggestions,
        };
      });
      return json(res, 200, result);
    } catch { return json(res, 404, {error: 'File not found'}); }
  }

  // ── Content suggestions: references & wiki links while typing ──
  if (req.method === 'GET' && pathname === '/api/suggest') {
    try {
      const text = (url.searchParams.get('text') || '').trim();
      const limit = Math.max(numericParam(url.searchParams.get('limit'), 5, 20), 1);
      if (!text) return json(res, 200, {references: [], pages: []});

      // Extract keywords from last 50 words
      const words = text.split(/\s+/).slice(-50);
      const keywords = words
        .map(w => w.toLowerCase().replace(/[^a-z0-9一-鿿]/g, ''))
        .filter(w => w.length > 2 && !SUGGEST_STOP_WORDS.has(w));
      if (keywords.length === 0) return json(res, 200, {references: [], pages: []});

      // 1. Search references.yaml for matching titles/authors
      const matchedRefs = [];
      try {
        const refs = ctx.references.load(fs, path, contentRootFor(req.auth?.orgId));
        for (const [key, entry] of Object.entries(refs)) {
          const title = (entry.title || '').toLowerCase();
          const authors = (Array.isArray(entry.author) ? entry.author.join(' ') : (entry.author || '')).toLowerCase();
          const haystack = title + ' ' + authors + ' ' + key.toLowerCase();
          let relevance = 0;
          for (const kw of keywords) {
            if (haystack.includes(kw)) relevance++;
          }
          if (relevance > 0) {
            matchedRefs.push({key, title: entry.title || key, relevance});
          }
        }
      } catch { /* references.yaml missing or invalid */ }
      matchedRefs.sort((a, b) => b.relevance - a.relevance);

      // 2. Search content files for matching headings
      const matchedPages = [];
      try {
        const contentDir = contentRootFor(req.auth?.orgId);
        if (fs.existsSync(contentDir)) {
          const mdFiles = flatFiles(contentDir).filter(f => f.name.endsWith('.md') || f.name.endsWith('.mdx'));
          for (const file of mdFiles) {
            try {
              const content = fs.readFileSync(path.join(contentRootFor(req.auth?.orgId), file.path), 'utf-8');
              // Extract title from frontmatter or first heading
              let pageTitle = '';
              const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
              if (fmMatch) {
                const titleMatch = fmMatch[1].match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
                if (titleMatch) pageTitle = titleMatch[1];
              }
              if (!pageTitle) {
                const h1Match = content.match(/^#\s+(.+)/m);
                if (h1Match) pageTitle = h1Match[1];
              }
              if (!pageTitle) pageTitle = file.name.replace(/\.(md|mdx)$/, '');

              // Match against headings and title
              const headings = (content.match(/^#{1,3}\s+.+/gm) || []).map(h => h.replace(/^#+\s+/, ''));
              const haystack = (pageTitle + ' ' + headings.join(' ')).toLowerCase();
              let relevance = 0;
              for (const kw of keywords) {
                if (haystack.includes(kw)) relevance++;
              }
              if (relevance > 0) {
                matchedPages.push({path: file.path, title: pageTitle, relevance});
              }
            } catch { /* skip unreadable files */ }
          }
        }
      } catch { /* content dir missing */ }
      matchedPages.sort((a, b) => b.relevance - a.relevance);

      return json(res, 200, {
        references: matchedRefs.slice(0, limit),
        pages: matchedPages.slice(0, limit),
      });
    } catch {
      return json(res, 500, {error: 'Failed to generate suggestions'});
    }
  }

  // ── Data integrity validation ──
  if (req.method === 'GET' && pathname === '/api/integrity') {
    const checks = [];
    const dataDir = path.join(PROJECT_ROOT, ...DATA_SEGS);

    // 1. Verify all data/*.json files are valid JSON
    try {
      const jsonFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
      const invalid = [];
      for (const file of jsonFiles) {
        try {
          JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
        } catch (e) {
          invalid.push({file, error: e.message});
        }
      }
      checks.push({
        name: 'json_validity',
        passed: invalid.length === 0,
        details: invalid.length === 0
          ? `All ${jsonFiles.length} JSON files are valid`
          : `${invalid.length} invalid JSON file(s): ${invalid.map(i => i.file).join(', ')}`,
      });
    } catch (e) {
      checks.push({name: 'json_validity', passed: false, details: `Cannot read data directory: ${e.message}`});
    }

    // 2. Check references.yaml is valid YAML
    try {
      const yaml = require('js-yaml');
      const refPath = path.join(contentRootFor(req.auth?.orgId), 'bibliography', 'references.yaml');
      if (fs.existsSync(refPath)) {
        yaml.load(fs.readFileSync(refPath, 'utf-8'));
        checks.push({name: 'yaml_validity', passed: true, details: 'references.yaml is valid YAML'});
      } else {
        checks.push({name: 'yaml_validity', passed: true, details: 'references.yaml not found (optional)'});
      }
    } catch (e) {
      checks.push({name: 'yaml_validity', passed: false, details: `references.yaml is invalid: ${e.message}`});
    }

    // 3. Verify no orphaned snapshot entries (snapshots for deleted files)
    try {
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      const orphaned = [];
      for (const filePath of Object.keys(snapshots)) {
        const fullPath = path.join(contentRootFor(req.auth?.orgId), filePath);
        if (!fs.existsSync(fullPath)) {
          orphaned.push({file: filePath, count: snapshots[filePath].length});
        }
      }
      checks.push({
        name: 'orphaned_snapshots',
        passed: orphaned.length === 0,
        details: orphaned.length === 0
          ? 'No orphaned snapshots'
          : `${orphaned.length} orphaned snapshot(s): ${orphaned.map(o => `${o.file} (${o.count})`).join(', ')}`,
      });
    } catch (e) {
      checks.push({name: 'orphaned_snapshots', passed: false, details: `Cannot check snapshots: ${e.message}`});
    }

    const allPassed = checks.every(c => c.passed);
    return json(res, 200, {status: allPassed ? 'healthy' : 'issues', checks});
  }

  // ── Performance metrics endpoint ──
  if (req.method === 'GET' && pathname === '/api/perf') {
    const endpoints = Object.entries(perfMetrics)
      .filter(([, times]) => times.length > 0)
      .map(([ep, times]) => {
        const sorted = [...times].sort((a, b) => a - b);
        const len = sorted.length;
        const sum = sorted.reduce((s, v) => s + v, 0);
        const avgMs = Math.round((sum / len) * 100) / 100;
        const maxMs = sorted[len - 1];
        const p95Idx = Math.min(Math.ceil(len * 0.95) - 1, len - 1);
        const p95Ms = sorted[p95Idx];
        return {path: ep, avgMs, maxMs, count: len, p95Ms};
      })
      .sort((a, b) => b.avgMs - a.avgMs);
    return json(res, 200, {endpoints});
  }

  // ── Content calendar (publishing planner) ──
  if (req.method === 'GET' && pathname === '/api/calendar') {
    try {
      const calendar = cached(cacheKey(req.auth?.orgId, 'calendar'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
        const byMonth = {};

        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              let date = null;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              let draft = false;
              if (fm) {
                const dm = fm[1].match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m);
                if (dm) date = dm[1];
                const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
                const dfm = fm[1].match(/^draft:\s*(true|yes)\s*$/mi);
                if (dfm) draft = true;
              }
              if (!date) {
                const stat = fs.statSync(fp);
                date = stat.mtime.toISOString().slice(0, 10);
              }
              const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
              const wordCount = body.split(/\s+/).filter(Boolean).length;
              const month = date.slice(0, 7);
              if (!byMonth[month]) byMonth[month] = [];
              byMonth[month].push({
                path: path.relative(contentRootFor(req.auth?.orgId), fp),
                title,
                date,
                wordCount,
                draft,
              });
            } catch {}
          }
        }
        scan(contentDir);

        // Include scheduled publications. This named schedules.json, which has
        // never existed; the store the API writes is schedule.json, so the
        // calendar has always shown an empty schedule.
        const schedulesPath = path.join(PROJECT_ROOT, ...dataFileSegs('schedule'));
        if (fs.existsSync(schedulesPath)) {
          try {
            const schedData = JSON.parse(fs.readFileSync(schedulesPath, 'utf-8'));
            const items = Array.isArray(schedData) ? schedData : (schedData.items || []);
            for (const item of items) {
              if (!item.publishAt) continue;
              const pubDate = item.publishAt.slice(0, 10);
              const month = pubDate.slice(0, 7);
              if (!byMonth[month]) byMonth[month] = [];
              byMonth[month].push({
                path: item.path || '',
                title: item.note || item.path || 'Scheduled',
                date: pubDate,
                wordCount: 0,
                draft: false,
                scheduled: true,
                status: item.status || 'scheduled',
              });
            }
          } catch {}
        }

        // Sort months and files within each month
        return Object.entries(byMonth)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, files]) => ({
            month,
            files: files.sort((a, b) => a.date.localeCompare(b.date)),
          }));
      });
      return json(res, 200, {months: calendar});
    } catch {
      return json(res, 500, {error: 'Calendar generation failed'});
    }
  }
};

module.exports.numericParam = numericParam;
// Batch-export render regexes, exported so tests can assert their source/flags
// match the former inline literals byte-for-byte.
module.exports.BATCH_CODE_BLOCK_RE = BATCH_CODE_BLOCK_RE;
module.exports.BATCH_H4_RE = BATCH_H4_RE;
module.exports.BATCH_H3_RE = BATCH_H3_RE;
module.exports.BATCH_H2_RE = BATCH_H2_RE;
module.exports.BATCH_H1_RE = BATCH_H1_RE;
module.exports.BATCH_BOLD_RE = BATCH_BOLD_RE;
module.exports.BATCH_ITALIC_RE = BATCH_ITALIC_RE;
module.exports.BATCH_INLINE_CODE_RE = BATCH_INLINE_CODE_RE;
module.exports.BATCH_LINK_RE = BATCH_LINK_RE;
module.exports.BATCH_LIST_RE = BATCH_LIST_RE;
module.exports.BATCH_BLOCKQUOTE_RE = BATCH_BLOCKQUOTE_RE;
module.exports.BATCH_PARA_RE = BATCH_PARA_RE;
module.exports.BATCH_BLANK_LINES_RE = BATCH_BLANK_LINES_RE;
// Task validation arrays, exported so tests can assert their frozen contents and
// shared identity match the former inline arrays.
module.exports.TASK_STATUSES = TASK_STATUSES;
module.exports.TASK_PRIORITIES = TASK_PRIORITIES;
