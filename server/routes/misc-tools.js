'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Parse a numeric query parameter, clamping to `max` and falling back to `def`
// when the value is absent or non-numeric. Without the fallback a stray
// `?limit=abc` parses to NaN, `Math.min(NaN, 200)` stays NaN, and the
// changelog/annotations feed collapses to `slice(0, NaN)` === empty even when
// events or annotations exist. Absent and valid numeric values keep their
// previous behavior.
function numericParam(raw, def, max) {
  const n = parseInt(raw, 10);
  return Math.min(Number.isNaN(n) ? def : n, max);
}

// Object keys that must never be used as property names (prototype-pollution guard).
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// Stop words stripped from the keyword list in GET /api/suggest, built once at
// module load instead of rebuilt on every request. The set holds only constant
// string literals and is read only (`.has` membership tests), so hoisting it
// leaves the suggestion output identical. Mirrors the RECOMMEND_STOP_WORDS and
// SIMILAR_STOP_WORDS sets in server/routes/content-analysis-b.js.
const SUGGEST_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'and','but','or','nor','not','so','yet','for','of','in','on','at','to','by','with',
  'from','as','into','about','between','through','after','before','during','without',
  'this','that','these','those','it','its','he','she','they','we','you','i','me','my',
  'his','her','our','their','your','which','what','who','whom','how','when','where','why']);

module.exports = async function misc_tools_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Reading progress tracking ──
  if (req.method === 'POST' && pathname === '/api/reading-progress') {
    if (!rateLimit(`reading-progress:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, pagePath, progress} = body;
      if (!userId || typeof userId !== 'string') return json(res, 400, {error: 'Missing or invalid userId'});
      if (userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing or invalid pagePath'});
      if (pagePath.length > 500) return json(res, 400, {error: 'pagePath must be 500 characters or fewer'});
      if (PROTO_KEYS.includes(userId) || PROTO_KEYS.includes(pagePath)) return json(res, 400, {error: 'Invalid key'});
      const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');
      const data = loadJSON(PROGRESS_FILE);
      const safeUserId = sanitizeText(userId);
      const safePagePath = sanitizeText(pagePath);
      if (!data[safeUserId]) data[safeUserId] = {};
      data[safeUserId][safePagePath] = {
        progress: Math.min(100, Math.max(0, typeof progress === 'number' ? progress : 0)),
        lastRead: new Date().toISOString(),
      };
      saveJSON(PROGRESS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/reading-progress') {
    const userId = url.searchParams.get('userId');
    if (!userId) return json(res, 400, {error: 'Missing userId'});
    const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');
    const data = loadJSON(PROGRESS_FILE);
    const userProgress = data[userId] || {};
    const pages = Object.entries(userProgress).map(([pagePath, info]) => ({
      pagePath, ...info,
    })).sort((a, b) => (b.lastRead || '').localeCompare(a.lastRead || ''));
    // Single pass over pages: progress >= 100 counts as read, and any remaining
    // page with progress > 0 is in progress (progress < 100 is implied by the
    // preceding branch). Equivalent to the two prior filter passes, one loop.
    let totalRead = 0;
    let inProgress = 0;
    for (const p of pages) {
      if (p.progress >= 100) totalRead++;
      else if (p.progress > 0) inProgress++;
    }
    return json(res, 200, {pages, totalRead, inProgress, totalTracked: pages.length});
  }

  // ── Content changelog ──
  if (req.method === 'GET' && pathname === '/api/changelog') {
    try {
      const limit = numericParam(url.searchParams.get('limit'), 50, 200);
      const events = [];
      const comments = loadJSON(COMMENTS_FILE);
      for (const [page, pageComments] of Object.entries(comments)) {
        if (Array.isArray(pageComments)) {
          for (const c of pageComments) {
            events.push({type: 'comment', page, author: c.author, text: c.text?.slice(0, 100), timestamp: c.createdAt});
          }
        }
      }
      const discData = loadJSON(DISCUSSIONS_FILE);
      for (const [channelId, msgs] of Object.entries(discData.messages || {})) {
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            events.push({type: 'message', channel: channelId, author: m.author, text: m.text?.slice(0, 100), timestamp: m.createdAt});
          }
        }
      }
      events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      return json(res, 200, {events: events.slice(0, limit), total: events.length});
    } catch {
      return json(res, 500, {error: 'Changelog failed'});
    }
  }

  // ── Reference impact scoring ──
  if (req.method === 'GET' && pathname === '/api/references/impact') {
    try {
      const impact = cached('ref-impact', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
        const citeCounts = {};
        function scanCites(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanCites(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              let m;
              while ((m = CITE_RE.exec(content)) !== null) {
                const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
                for (const key of keys) {
                  citeCounts[key] = (citeCounts[key] || 0) + 1;
                }
              }
            } catch {}
          }
        }
        scanCites(contentDir);
        const TOP_VENUES = new Set(['NeurIPS','ICML','ICLR','CVPR','ACL','EMNLP','AAAI','Nature','Science']);
        const scores = [];
        for (const [key, entry] of Object.entries(refs)) {
          const citations = citeCounts[key] || 0;
          const venueBonus = TOP_VENUES.has(entry.venue) ? 2 : 0;
          const recencyBonus = entry.year >= 2022 ? 1 : entry.year >= 2020 ? 0.5 : 0;
          const score = Math.round((citations * 3 + venueBonus + recencyBonus) * 10) / 10;
          scores.push({key, title: entry.title, year: entry.year, venue: entry.venue, citations, score});
        }
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, 50);
      });
      return json(res, 200, {references: impact, total: impact.length});
    } catch {
      return json(res, 500, {error: 'Impact scoring failed'});
    }
  }

  // ── Shared annotations feed ──
  if (req.method === 'GET' && pathname === '/api/annotations/shared') {
    try {
      const limit = numericParam(url.searchParams.get('limit'), 50, 200);
      const annotations = loadJSON(ANNOTATIONS_FILE);
      const all = [];
      for (const [page, pageAnnotations] of Object.entries(annotations)) {
        if (Array.isArray(pageAnnotations)) {
          for (const ann of pageAnnotations) {
            all.push({...ann, page});
          }
        }
      }
      all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return json(res, 200, {annotations: all.slice(0, limit), total: all.length});
    } catch {
      return json(res, 500, {error: 'Failed to load shared annotations'});
    }
  }

  // ── Co-author network ──
  if (req.method === 'GET' && pathname === '/api/references/co-authors') {
    try {
      const network = cached('co-author-network', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const coauthorCounts = {};
        for (const entry of Object.values(refs)) {
          const authors = entry.author || [];
          for (let i = 0; i < authors.length; i++) {
            for (let j = i + 1; j < authors.length; j++) {
              const pair = [authors[i], authors[j]].sort().join('::');
              coauthorCounts[pair] = (coauthorCounts[pair] || 0) + 1;
            }
          }
        }
        const edges = Object.entries(coauthorCounts)
          .filter(([, count]) => count >= 2)
          .map(([pair, count]) => {
            const [a, b] = pair.split('::');
            return {author1: a, author2: b, papers: count};
          })
          .sort((a, b) => b.papers - a.papers)
          .slice(0, 50);
        const authorSet = new Set();
        for (const edge of edges) { authorSet.add(edge.author1); authorSet.add(edge.author2); }
        return {edges, authors: [...authorSet], totalPairs: Object.keys(coauthorCounts).length};
      });
      return json(res, 200, network);
    } catch {
      return json(res, 500, {error: 'Co-author network failed'});
    }
  }

  // ── Content freshness scoring ──
  if (req.method === 'GET' && pathname === '/api/content-freshness') {
    try {
      const freshness = cached('content-freshness', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const now = Date.now();
        const files = [];
        function scanFreshness(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanFreshness(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const stat = fs.statSync(fp);
              const ageMs = now - stat.mtimeMs;
              const ageDays = Math.floor(ageMs / 86400000);
              const content = fs.readFileSync(fp, 'utf-8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fmMatch) {
                const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
              }
              const wordCount = content.split(/\s+/).filter(Boolean).length;
              files.push({
                path: path.relative(PROJECT_ROOT, fp),
                title, ageDays, wordCount,
                lastModified: stat.mtime.toISOString(),
                freshness: ageDays <= 7 ? 'fresh' : ageDays <= 30 ? 'recent' : ageDays <= 90 ? 'aging' : 'stale',
              });
            } catch {}
          }
        }
        scanFreshness(contentDir);
        files.sort((a, b) => b.ageDays - a.ageDays);
        const counts = {fresh: 0, recent: 0, aging: 0, stale: 0};
        for (const f of files) counts[f.freshness]++;
        return {files: files.slice(0, 50), counts, totalFiles: files.length};
      });
      return json(res, 200, freshness);
    } catch {
      return json(res, 500, {error: 'Freshness scoring failed'});
    }
  }

  // ── Content duplicate detection ──
  if (req.method === 'GET' && pathname === '/api/content-duplicates') {
    try {
      const duplicates = cached('content-duplicates', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
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
                  path: path.relative(PROJECT_ROOT, fullPath),
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
  if (req.method === 'GET' && pathname === '/api/stats/timeline') {
    try {
      const timeline = cached('stats:timeline', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byMonth = {};
        function scanTimeline(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanTimeline(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                let date = null;
                if (fmMatch) {
                  const dateMatch = fmMatch[1].match(/^date:\s*["']?(\d{4}-\d{2}(?:-\d{2})?)/m);
                  if (dateMatch) date = dateMatch[1].slice(0, 7);
                }
                if (!date) {
                  const stat = fs.statSync(fullPath);
                  date = stat.mtime.toISOString().slice(0, 7);
                }
                byMonth[date] = (byMonth[date] || 0) + 1;
              } catch {}
            }
          }
        }
        scanTimeline(contentDir);
        return Object.entries(byMonth)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([month, count]) => ({month, count}));
      });
      return json(res, 200, {timeline});
    } catch {
      return json(res, 500, {error: 'Timeline stats failed'});
    }
  }

  // ── Content health check ──
  if (req.method === 'GET' && pathname === '/api/content-health') {
    try {
      const health = cached('content-health', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
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
              const relPath = path.relative(path.join(PROJECT_ROOT, 'content'), fullPath);
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
        const brokenLinks = [];
        const incomingLinks = new Map();
        for (const link of allLinks) {
          const target = link.target;
          const found = pageIds.has(target) || [...pageIds].some(id => id.endsWith(target) || id.endsWith('/' + target));
          if (!found) {
            brokenLinks.push({source: link.source, target, type: link.type || 'wiki'});
          } else {
            const resolvedTarget = pageIds.has(target) ? target : [...pageIds].find(id => id.endsWith(target) || id.endsWith('/' + target));
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

  // ── Scheduled publishing ──
  if (pathname === '/api/schedule') {
    if (req.method === 'POST') {
      if (!rateLimit(`schedule:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {path: filePath, publishAt} = body;
        if (!filePath || !publishAt) return json(res, 400, {error: 'Missing path or publishAt'});
        if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
        const fullPath = path.join(PROJECT_ROOT, filePath);
        if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
        const publishDate = new Date(publishAt);
        if (isNaN(publishDate.getTime())) return json(res, 400, {error: 'Invalid publishAt date'});
        const raw = loadJSON(SCHEDULES_FILE);
        const schedules = Array.isArray(raw) ? raw : [];
        const existing = schedules.findIndex(s => s.path === filePath);
        if (existing !== -1) schedules.splice(existing, 1);
        schedules.push({path: filePath, publishAt: publishDate.toISOString(), createdAt: new Date().toISOString()});
        saveJSON(SCHEDULES_FILE, schedules);
        return json(res, 200, {success: true, schedule: schedules[schedules.length - 1]});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'GET') {
      const raw = loadJSON(SCHEDULES_FILE);
      const schedules = Array.isArray(raw) ? raw : [];
      return json(res, 200, {schedules});
    }
    if (req.method === 'DELETE') {
      try {
        const body = await readBody(req);
        const {path: filePath} = body;
        if (!filePath) return json(res, 400, {error: 'Missing path'});
        const raw = loadJSON(SCHEDULES_FILE);
        const schedules = Array.isArray(raw) ? raw : [];
        const idx = schedules.findIndex(s => s.path === filePath);
        if (idx === -1) return json(res, 404, {error: 'Schedule not found'});
        schedules.splice(idx, 1);
        saveJSON(SCHEDULES_FILE, schedules);
        return json(res, 200, {success: true});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
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
      const fullPath = path.join(PROJECT_ROOT, filePath);
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
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      const fileSnapshots = snapshots[filePath] || [];
      const snapshot = fileSnapshots.find(s => s.id === snapshotId);
      if (!snapshot) return json(res, 404, {error: 'Snapshot not found'});
      fs.writeFileSync(fullPath, snapshot.content, 'utf-8');
      invalidateCache('search');
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
        const wb = whiteboards[id];
        if (!wb) return json(res, 404, {error: 'Whiteboard not found'});
        return json(res, 200, {whiteboard: wb});
      }
      return json(res, 400, {error: 'Missing id parameter. Use GET /api/whiteboards to list all.'});
    }
    if (req.method === 'DELETE') {
      if (!rateLimit(`whiteboard-del:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, {error: 'Missing id parameter'});
      const whiteboards = loadJSON(WHITEBOARDS_FILE);
      if (!whiteboards[id]) return json(res, 404, {error: 'Whiteboard not found'});
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
    const userId = url.searchParams.get('userId') || 'default';
    const today = new Date().toISOString().slice(0, 10);
    const data = loadJSON(FLASHCARDS_FILE);
    const cards = (data[userId] || []).filter(c => c.nextReview <= today);
    cards.sort((a, b) => (a.nextReview || '').localeCompare(b.nextReview || ''));
    return json(res, 200, {cards, count: cards.length});
  }

  // ── Mindmap from headings ──
  if (req.method === 'GET' && pathname === '/api/file/mindmap') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    let md;
    try {
      md = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
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
    return json(res, 200, {root});
  }

  // ── Tasks (Kanban) ──
  if (pathname === '/api/tasks') {
    if (req.method === 'POST') {
      if (!rateLimit(`tasks:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {title, description, status, priority} = body;
        if (!title || typeof title !== 'string' || !title.trim()) return json(res, 400, {error: 'Missing title'});
        const validStatuses = ['todo', 'doing', 'done'];
        const safeStatus = validStatuses.includes(status) ? status : 'todo';
        const validPriorities = ['low', 'medium', 'high'];
        const safePriority = validPriorities.includes(priority) ? priority : 'medium';
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
        const validStatuses = ['todo', 'doing', 'done'];
        const validPriorities = ['low', 'medium', 'high'];
        if (status !== undefined && validStatuses.includes(status)) task.status = status;
        if (title !== undefined && typeof title === 'string' && title.trim()) task.title = sanitizeText(title.trim()).slice(0, 200);
        if (description !== undefined) task.description = sanitizeText(String(description).trim()).slice(0, 2000);
        if (priority !== undefined && validPriorities.includes(priority)) task.priority = priority;
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

  // ── Writing goals ──
  if (req.method === 'POST' && pathname === '/api/goals') {
    if (!rateLimit(`goals:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {type, target, userId} = body;
      if (!type || !['daily', 'weekly'].includes(type)) return json(res, 400, {error: 'type must be "daily" or "weekly"'});
      if (typeof target !== 'number' || target <= 0) return json(res, 400, {error: 'target must be a positive number'});
      if (userId !== undefined && typeof userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      if (userId && userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      const uid = userId ? sanitizeText(userId) : 'default';
      // Compute baseline words from content stats
      const contentDir = path.join(PROJECT_ROOT, 'content');
      let baselineWords = 0;
      function countWordsForGoal(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) countWordsForGoal(path.join(dir, entry.name));
          else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            baselineWords += fs.readFileSync(path.join(dir, entry.name), 'utf-8').split(/\s+/).filter(Boolean).length;
          }
        }
      }
      try { countWordsForGoal(contentDir); } catch {}
      const now = new Date().toISOString();
      const goal = {
        id: 'goal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type, target, userId: uid,
        startDate: now.slice(0, 10),
        baselineWords,
        createdAt: now,
      };
      const data = loadJSON(GOALS_FILE);
      if (!Array.isArray(data.goals)) data.goals = [];
      // Replace existing goal of same type+userId
      data.goals = data.goals.filter(g => !(g.type === type && g.userId === uid));
      data.goals.push(goal);
      saveJSON(GOALS_FILE, data);
      return json(res, 201, goal);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/goals') {
    const uid = url.searchParams.get('userId') || 'default';
    const data = loadJSON(GOALS_FILE);
    const goals = Array.isArray(data.goals) ? data.goals.filter(g => g.userId === uid) : [];
    // Compute current total words
    const contentDir = path.join(PROJECT_ROOT, 'content');
    let currentWords = 0;
    function countWordsForGoalGet(dir) {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) countWordsForGoalGet(path.join(dir, entry.name));
        else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
          currentWords += fs.readFileSync(path.join(dir, entry.name), 'utf-8').split(/\s+/).filter(Boolean).length;
        }
      }
    }
    try { countWordsForGoalGet(contentDir); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const result = goals.map(g => {
      const wordsWritten = Math.max(0, currentWords - g.baselineWords);
      const isExpired = g.type === 'daily' ? g.startDate < today : g.startDate < weekStartStr;
      const progress = Math.min(1, wordsWritten / g.target);
      return {...g, currentWords, wordsWritten, progress: Math.round(progress * 100) / 100, isExpired};
    });
    return json(res, 200, {goals: result});
  }

  if (req.method === 'PUT' && pathname === '/api/goals') {
    if (!rateLimit(`goals-update:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {id, target} = body;
      if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing or invalid id'});
      const data = loadJSON(GOALS_FILE);
      if (!Array.isArray(data.goals)) return json(res, 404, {error: 'No goals found'});
      const goal = data.goals.find(g => g.id === id);
      if (!goal) return json(res, 404, {error: 'Goal not found'});
      if (typeof target === 'number' && target > 0) goal.target = target;
      saveJSON(GOALS_FILE, data);
      return json(res, 200, goal);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Citation graph (nodes + edges for visualization) ──
  if (req.method === 'GET' && pathname === '/api/references/citation-graph') {
    try {
      const graph = cached('citation-graph-viz', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;

        // Track which refs appear on each page
        const pageCiteSets = [];
        const citedKeys = new Set();

        function scanDir(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanDir(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              const pageCites = new Set();
              let m;
              while ((m = CITE_RE.exec(content)) !== null) {
                for (const k of m[1].split(/\s*;\s*/).map(s => s.replace(/^@/, ''))) {
                  if (refs[k]) { pageCites.add(k); citedKeys.add(k); }
                }
              }
              if (pageCites.size > 1) pageCiteSets.push(pageCites);
            } catch {}
          }
        }
        scanDir(contentDir);

        // Build nodes from cited references only
        const nodes = [...citedKeys].map(key => ({
          id: key,
          title: refs[key]?.title || key,
          year: refs[key]?.year || null,
          authors: Array.isArray(refs[key]?.author)
            ? refs[key].author.slice(0, 3).join(', ')
            : (refs[key]?.author || ''),
        }));

        // Build edges from co-citations (papers cited on the same page)
        const edgeMap = {};
        for (const cites of pageCiteSets) {
          const arr = [...cites].sort();
          for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
              const eid = arr[i] + '::' + arr[j];
              edgeMap[eid] = (edgeMap[eid] || 0) + 1;
            }
          }
        }
        const edges = Object.entries(edgeMap).map(([eid, weight]) => {
          const [source, target] = eid.split('::');
          return {source, target, type: 'cites', weight};
        }).sort((a, b) => b.weight - a.weight);

        return {nodes, edges, totalReferences: Object.keys(refs).length};
      });
      return json(res, 200, graph);
    } catch {
      return json(res, 500, {error: 'Citation graph build failed'});
    }
  }

  // ── Backup: export all user data ──
  if (req.method === 'GET' && pathname === '/api/backup') {
    try {
      const bundle = {
        comments: loadJSON(COMMENTS_FILE),
        notes: loadJSON(NOTES_FILE),
        discussions: loadJSON(DISCUSSIONS_FILE),
        bookmarks: loadJSON(BOOKMARKS_FILE),
        readingLists: loadJSON(READING_LISTS_FILE),
        glossary: loadJSON(GLOSSARY_FILE),
        flashcards: loadJSON(FLASHCARDS_FILE),
        tasks: loadJSON(TASKS_FILE),
        analytics: loadJSON(ANALYTICS_FILE),
        goals: loadJSON(GOALS_FILE),
        streaks: loadJSON(STREAKS_FILE),
        annotations: loadJSON(ANNOTATIONS_FILE),
        exportedAt: new Date().toISOString(),
      };
      return json(res, 200, bundle);
    } catch (err) {
      return json(res, 500, {error: 'Backup export failed', detail: err.message});
    }
  }

  // ── Backup: restore all user data from bundle ──
  if (req.method === 'POST' && pathname === '/api/backup/restore') {
    if (!rateLimit(`backup-restore:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') {
        return json(res, 400, {error: 'Invalid backup bundle'});
      }
      const mapping = {
        comments: COMMENTS_FILE,
        notes: NOTES_FILE,
        discussions: DISCUSSIONS_FILE,
        bookmarks: BOOKMARKS_FILE,
        readingLists: READING_LISTS_FILE,
        glossary: GLOSSARY_FILE,
        flashcards: FLASHCARDS_FILE,
        tasks: TASKS_FILE,
        analytics: ANALYTICS_FILE,
        goals: GOALS_FILE,
        streaks: STREAKS_FILE,
        annotations: ANNOTATIONS_FILE,
      };
      const restored = [];
      for (const [key, filePath] of Object.entries(mapping)) {
        if (body[key] !== undefined) {
          saveJSON(filePath, body[key]);
          restored.push(key);
        }
      }
      if (restored.length === 0) {
        return json(res, 400, {error: 'No recognizable data keys in bundle'});
      }
      return json(res, 200, {success: true, restored, restoredAt: new Date().toISOString()});
    } catch (err) {
      return json(res, 500, {error: 'Backup restore failed', detail: err.message});
    }
  }

  // ── Batch export: export an entire directory as a single HTML document ──
  if (req.method === 'GET' && pathname === '/api/export/batch') {
    const dir = url.searchParams.get('dir');
    const format = url.searchParams.get('format') || 'html';
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory. Must start with content/'});
    if (format !== 'html') return json(res, 400, {error: 'Only html format is currently supported'});

    const fullDir = path.join(PROJECT_ROOT, dir);
    try {
      if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) {
        return json(res, 404, {error: 'Directory not found'});
      }

      // Recursively find all .md files in the directory
      const mdFiles = [];
      function walkDirBatch(d) {
        const entries = fs.readdirSync(d, {withFileTypes: true});
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walkDirBatch(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            mdFiles.push(fullPath);
          }
        }
      }
      walkDirBatch(fullDir);

      if (mdFiles.length === 0) return json(res, 404, {error: 'No markdown files found in directory'});

      // Sort by relative path for consistent ordering
      mdFiles.sort((a, b) => a.localeCompare(b));

      // Limit to 100 files to avoid overload
      const filesToExport = mdFiles.slice(0, 100);

      // Parse each file
      const sections = [];
      for (const fp of filesToExport) {
        try {
          let content = fs.readFileSync(fp, 'utf-8');
          const relPath = path.relative(PROJECT_ROOT, fp);
          let title = path.basename(fp, '.md');

          // Strip frontmatter and extract title
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const tm = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (tm) title = tm[1];
            content = content.slice(fmMatch[0].length);
          }

          // Convert markdown to HTML
          let html = content;
          html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`;
          });
          html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
          html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
          html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
          html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
          html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
          html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
          html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
          html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
          html = html.replace(/(^- .+$(\n- .+$)*)/gm, (match) => {
            const items = match.split('\n').map(line => `<li>${line.slice(2)}</li>`).join('\n');
            return `<ul>\n${items}\n</ul>`;
          });
          html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
          html = html.replace(/^(?!<[a-z/])((?!\s*$).+)$/gm, '<p>$1</p>');
          html = html.replace(/\n{3,}/g, '\n\n');

          sections.push({title, html: html.trim(), relPath});
        } catch {}
      }

      if (sections.length === 0) return json(res, 500, {error: 'Failed to parse any files'});

      const dirName = path.basename(dir);
      const safeDirName = dirName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // Build table of contents
      const tocItems = sections.map((s, i) => {
        const safeTitle = s.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<li><a href="#section-${i}">${safeTitle}</a> <span class="toc-path">${s.relPath.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span></li>`;
      }).join('\n');

      // Build section HTML with page breaks
      const sectionsHtml = sections.map((s, i) => {
        const safeTitle = s.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<section id="section-${i}" class="file-section">
<h1 class="section-title">${safeTitle}</h1>
<p class="section-path">${s.relPath.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
${s.html}
</section>`;
      }).join('\n');

      const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Batch Export: ${safeDirName}</title>
<style>
@page { size: A4; margin: 2cm; }
@media print {
  body { max-width: none; padding: 0; }
  .file-section { page-break-before: always; }
  .file-section:first-of-type { page-break-before: avoid; }
  #toc { page-break-after: always; }
  a { color: inherit; text-decoration: none; }
  .toc-path { display: inline; }
  pre { border: 1px solid #ccc; }
}
body {
  max-width: 750px;
  margin: 0 auto;
  padding: 2rem 1rem;
  font-family: "Times New Roman", Georgia, serif;
  font-size: 12pt;
  line-height: 1.8;
  color: #111;
}
h1 { font-size: 20pt; margin-top: 0; }
h2 { font-size: 16pt; margin-top: 1.5em; color: #222; }
h3 { font-size: 13pt; margin-top: 1.2em; color: #333; }
h4 { font-size: 11pt; margin-top: 1em; color: #444; }
.cover-title {
  font-size: 28pt;
  text-align: center;
  border-bottom: 3px solid #333;
  padding-bottom: 12px;
  margin-bottom: 0.5em;
}
.cover-meta {
  text-align: center;
  color: #666;
  font-size: 11pt;
  margin-bottom: 2em;
}
#toc { margin: 1em 0; }
#toc h2 { font-size: 18pt; border-bottom: 1px solid #ccc; padding-bottom: 6px; }
#toc ol {
  list-style: decimal;
  padding-left: 1.5em;
  line-height: 2;
}
#toc li { margin: 4px 0; }
#toc a { color: #1a0dab; text-decoration: none; }
#toc a:hover { text-decoration: underline; }
.toc-path { color: #999; font-size: 9pt; margin-left: 0.5em; }
.section-title {
  font-size: 20pt;
  border-bottom: 2px solid #333;
  padding-bottom: 8px;
  margin-bottom: 0.2em;
}
.section-path {
  font-size: 9pt;
  color: #999;
  margin-top: 0;
  margin-bottom: 1.5em;
}
pre { background: #f5f5f5; padding: 12px; overflow-x: auto; border: 1px solid #ddd; font-size: 10pt; border-radius: 3px; }
code { background: #f0f0f0; padding: 1px 4px; border-radius: 2px; font-size: 10pt; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1rem; color: #555; font-style: italic; }
a { color: #1a0dab; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
th { background: #f5f5f5; font-weight: bold; }
ul, ol { margin: 0.5em 0 0.5em 1.5em; }
li { margin: 3px 0; }
strong { color: #111; }
</style>
</head>
<body>
<h1 class="cover-title">${safeDirName}</h1>
<p class="cover-meta">${sections.length} files &mdash; Exported from Mochi Lab on ${new Date().toLocaleDateString()}</p>

<nav id="toc">
<h2>Table of Contents</h2>
<ol>
${tocItems}
</ol>
</nav>

${sectionsHtml}

<footer style="margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ccc; font-size: 9pt; color: #888; text-align: center;">
Generated from Mochi Lab &mdash; ${new Date().toLocaleDateString()}
</footer>
</body>
</html>`;

      const exportName = dirName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'batch';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportName}-batch.html"`,
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });
      return res.end(fullHtml);
    } catch (err) {
      return json(res, 500, {error: 'Batch export failed', detail: err.message});
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
      const blogDir = path.join(PROJECT_ROOT, 'content', 'posts', 'blog');
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
      const relativePath = path.relative(PROJECT_ROOT, finalPath);
      return json(res, 200, {success: true, path: relativePath, filename: finalFilename});
    } catch (err) {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/quicknote') {
    try {
      const blogDir = path.join(PROJECT_ROOT, 'content', 'posts', 'blog');
      if (!fs.existsSync(blogDir)) {
        return json(res, 200, {notes: [], total: 0});
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
            path: `content/posts/blog/${file}`,
          });
        } catch {}
      }
      return json(res, 200, {notes, total: notes.length});
    } catch {
      return json(res, 200, {notes: [], total: 0});
    }
  }

  // ── Content quality scoring ──
  if (req.method === 'GET' && pathname === '/api/file/quality') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
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

      return json(res, 200, {
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
      });
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
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
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
        const contentDir = path.join(PROJECT_ROOT, 'content');
        if (fs.existsSync(contentDir)) {
          const mdFiles = flatFiles(contentDir).filter(f => f.name.endsWith('.md') || f.name.endsWith('.mdx'));
          for (const file of mdFiles) {
            try {
              const content = fs.readFileSync(path.join(PROJECT_ROOT, file.path), 'utf-8');
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
    const dataDir = path.join(PROJECT_ROOT, 'data');

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
      const refPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
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
        const fullPath = path.join(PROJECT_ROOT, filePath);
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

    // 4. Check for comments on non-existent pages
    try {
      const comments = loadJSON(COMMENTS_FILE);
      const orphanedComments = [];
      for (const page of Object.keys(comments)) {
        if (page.startsWith('__')) continue; // skip internal/test keys
        const fullPath = path.join(PROJECT_ROOT, page);
        if (!fs.existsSync(fullPath) && comments[page].length > 0) {
          orphanedComments.push({page, count: comments[page].length});
        }
      }
      checks.push({
        name: 'orphaned_comments',
        passed: orphanedComments.length === 0,
        details: orphanedComments.length === 0
          ? 'No comments on non-existent pages'
          : `${orphanedComments.length} page(s) with orphaned comments: ${orphanedComments.map(o => `${o.page} (${o.count})`).join(', ')}`,
      });
    } catch (e) {
      checks.push({name: 'orphaned_comments', passed: false, details: `Cannot check comments: ${e.message}`});
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
        const sum = sorted.reduce((s, v) => s + v, 0);
        const avgMs = Math.round((sum / sorted.length) * 100) / 100;
        const maxMs = sorted[sorted.length - 1];
        const p95Idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
        const p95Ms = sorted[p95Idx];
        return {path: ep, avgMs, maxMs, count: sorted.length, p95Ms};
      })
      .sort((a, b) => b.avgMs - a.avgMs);
    return json(res, 200, {endpoints});
  }

  // ── Word count target per file ──
  if (req.method === 'POST' && pathname === '/api/file/target') {
    if (!rateLimit(`file-target:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, targetWords} = body;
      if (!filePath || typeof filePath !== 'string') return json(res, 400, {error: 'Missing or invalid path'});
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid file path'});
      if (typeof targetWords !== 'number' || targetWords <= 0) return json(res, 400, {error: 'targetWords must be a positive number'});
      const data = loadJSON(TARGETS_FILE);
      data[filePath] = targetWords;
      saveJSON(TARGETS_FILE, data);
      return json(res, 200, {success: true, path: filePath, targetWords});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/file/target') {
    const filePath = url.searchParams.get('path');
    if (!filePath) return json(res, 400, {error: 'Missing path query parameter'});
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid file path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
    const data = loadJSON(TARGETS_FILE);
    const target = data[filePath];
    if (!target) return json(res, 404, {error: 'No target set for this file'});
    const content = fs.readFileSync(fullPath, 'utf-8');
    const current = content.split(/\s+/).filter(Boolean).length;
    const progress = Math.min(1, current / target);
    return json(res, 200, {target, current, progress: Math.round(progress * 1000) / 1000});
  }

  // ── Content calendar (publishing planner) ──
  if (req.method === 'GET' && pathname === '/api/calendar') {
    try {
      const calendar = cached('calendar', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
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
                path: path.relative(PROJECT_ROOT, fp),
                title,
                date,
                wordCount,
                draft,
              });
            } catch {}
          }
        }
        scan(contentDir);

        // Include scheduled publications from data/schedules.json
        const schedulesPath = path.join(PROJECT_ROOT, 'data', 'schedules.json');
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
