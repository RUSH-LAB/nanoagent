'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

const { numericParam } = require('../server-utils');
const {dataFileSegs} = require('../paths');

// Walk content/ once into the {title, date, path, mtime} list the RSS and Atom
// feeds share, sorted by mtime descending. Each feed handler wraps this in
// cached('feed-items'), so the tree is scanned once per cache window instead of
// once per RSS request plus once per Atom request. The produced item shape and
// sort order match the two walks this replaces, so each feed's XML is unchanged.
function scanFeedItems(fs, path, PROJECT_ROOT, ALLOWED_EXTS) {
  const contentDir = path.join(PROJECT_ROOT, 'content');
  const items = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(fp); continue; }
      if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
      try {
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let title = entry.name.replace(/\.(mdx?|md)$/, '');
        let date = stat.mtime.toISOString();
        if (fmMatch) {
          const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (tm) title = tm[1];
          const dm = fmMatch[1].match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})/m);
          if (dm) date = dm[1] + 'T00:00:00Z';
        }
        items.push({title, date, path: path.relative(PROJECT_ROOT, fp), mtime: stat.mtimeMs});
      } catch {}
    }
  }
  scan(contentDir);
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

// Escape the three XML metacharacters (&, <, >) shared by the RSS and Atom feed
// bodies. Hoisted to module scope so the function and its three regex literals
// are built once at module load, rather than rebuilt per Atom request and per
// item inside the RSS `.map`. The replace chain and its order are unchanged, so
// every emitted feed byte stays identical. The ampersand is escaped first; if it
// ran last it would re-escape the `&` in `&lt;`/`&gt;` into `&amp;lt;`.
const escapeFeedXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = async function feeds_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── References: search (for citation autocomplete) ──
  if (req.method === 'GET' && pathname === '/api/references') {
    try {
      // Reuse the references module's mtime+size memo so this autocomplete GET
      // shares one parse of the 251 KB references.yaml with the read-only
      // references handlers, instead of re-reading and re-parsing the file on
      // every request. The loader re-stats each call and re-parses on any
      // mtime or size change, so there is no staleness. Non circular:
      // references.js does not require this module. Any stat, read, or parse
      // failure yields {}, matching the catch below, so a missing or corrupt
      // file still serves {references: {}}.
      const {loadReferencesCached} = require('./references');
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      return json(res, 200, {references: refs});
    } catch {
      return json(res, 200, {references: {}});
    }
  }

  // ── Writing sessions tracking ──
  if (req.method === 'POST' && pathname === '/api/sessions') {
    try {
      const body = await readBody(req);
      const {startTime, endTime, wordsWritten, filesEdited} = body;
      // The session belongs to whoever is signed in; `body.userId` used to let
      // a caller file writing time under someone else's name.
      const {userId} = req.auth;
      if (!startTime || typeof startTime !== 'string') return json(res, 400, {error: 'Missing or invalid startTime'});
      if (endTime !== undefined && typeof endTime !== 'string') return json(res, 400, {error: 'endTime must be a string'});
      if (wordsWritten !== undefined && typeof wordsWritten !== 'number') return json(res, 400, {error: 'wordsWritten must be a number'});
      if (filesEdited !== undefined && !Array.isArray(filesEdited)) return json(res, 400, {error: 'filesEdited must be an array'});
      if (Array.isArray(filesEdited) && filesEdited.length > 100) return json(res, 400, {error: 'filesEdited exceeds maximum length of 100'});
      const SESSIONS_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('sessions'));
      const sessions = loadJSON(SESSIONS_FILE);
      if (!Object.hasOwn(sessions, userId)) sessions[userId] = [];
      const session = {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        startTime: sanitizeText(startTime),
        endTime: endTime ? sanitizeText(endTime) : new Date().toISOString(),
        wordsWritten: wordsWritten || 0,
        filesEdited: (filesEdited || []).slice(0, 100).map(f => typeof f === 'string' ? sanitizeText(f).slice(0, 500) : ''),
        duration: endTime ? Math.round((new Date(endTime) - new Date(startTime)) / 60000) : 0,
      };
      sessions[userId].push(session);
      if (sessions[userId].length > 1000) sessions[userId] = sessions[userId].slice(-1000);
      saveJSON(SESSIONS_FILE, sessions);
      return json(res, 200, {success: true, session});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const {userId} = req.auth;
    // Lower-clamp to 1: numericParam only upper-bounds, so a negative limit would
    // flip slice(-limit) into slice(limit), skipping the first |limit| sessions and
    // over-returning instead of taking the most-recent tail. Non-negative limits
    // keep their previous behavior.
    const limit = Math.max(numericParam(url.searchParams.get('limit'), 20, 100), 1);
    const SESSIONS_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('sessions'));
    const sessions = loadJSON(SESSIONS_FILE);
    // Only treat an OWN key as a real user. A request-controlled id such as
    // `constructor` or `toString` resolves to a truthy inherited value, so the
    // `|| []` fallback would be skipped and `.slice` would throw an unhandled
    // TypeError that hangs the request until the socket timeout. The guard returns
    // the empty default for any non-own key; real own-key users stay unchanged.
    // Mirrors the users-me guard.
    const userSessions = (Object.hasOwn(sessions, userId) ? sessions[userId] : []).slice(-limit).reverse();
    // Accumulate both totals in a single walk over userSessions rather than two
    // separate passes. Same `|| 0` fallbacks, same response shape as before.
    let totalMinutes = 0;
    let totalWords = 0;
    for (const sess of userSessions) {
      totalMinutes += sess.duration || 0;
      totalWords += sess.wordsWritten || 0;
    }
    return json(res, 200, {
      sessions: userSessions,
      summary: {totalSessions: userSessions.length, totalMinutes, totalWords},
    });
  }

  // ── Content table of contents (hierarchical site map) ──
  if (req.method === 'GET' && pathname === '/api/content-toc') {
    try {
      const toc = cached('content-toc', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        function buildTOC(dir) {
          const entries = [];
          for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const children = buildTOC(fp);
              let title = entry.name;
              const catFile = path.join(fp, '_category_.json');
              if (fs.existsSync(catFile)) {
                try {
                  const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
                  if (cat.label) title = cat.label;
                } catch {}
              }
              entries.push({type: 'directory', name: entry.name, title, children, path: path.relative(PROJECT_ROOT, fp)});
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              try {
                const content = fs.readFileSync(fp, 'utf-8');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (fmMatch) {
                  const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                  if (tm) title = tm[1];
                }
              } catch {}
              entries.push({type: 'file', name: entry.name, title, path: path.relative(PROJECT_ROOT, fp)});
            }
          }
          return entries;
        }
        return buildTOC(contentDir);
      });
      return json(res, 200, {toc});
    } catch {
      return json(res, 500, {error: 'TOC generation failed'});
    }
  }

  // ── RSS feed of recent content updates ──
  if (req.method === 'GET' && pathname === '/api/feed/rss') {
    try {
      const items = cached('feed-items', 60000, () => scanFeedItems(fs, path, PROJECT_ROOT, ALLOWED_EXTS));
      const recent = items.slice(0, 20);
      const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Mochi Lab</title>
<description>Recent content updates from Mochi Lab</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${recent.map(item => `<item>
<title>${escapeFeedXml(item.title)}</title>
<link>/${escapeFeedXml(item.path.replace(/^content\//, '').replace(/\.(md|mdx)$/, ''))}</link>
<pubDate>${new Date(item.date).toUTCString()}</pubDate>
</item>`).join('\n')}
</channel>
</rss>`;
      res.writeHead(200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(rss);
    } catch {
      return json(res, 500, {error: 'RSS feed generation failed'});
    }
  }

  // ── Import content from URL ──
  if (req.method === 'POST' && pathname === '/api/import-url') {
    if (!rateLimit(`import-url:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {url: sourceUrl, targetPath, title: customTitle} = body;
      if (!sourceUrl || typeof sourceUrl !== 'string') return json(res, 400, {error: 'Missing or invalid url'});
      if (!targetPath || typeof targetPath !== 'string') return json(res, 400, {error: 'Missing or invalid targetPath'});
      if (customTitle !== undefined && typeof customTitle !== 'string') return json(res, 400, {error: 'title must be a string'});
      if (!isValidFilePath(targetPath)) return json(res, 400, {error: 'Invalid targetPath'});
      if (!/^https?:\/\//i.test(sourceUrl)) return json(res, 400, {error: 'URL must start with http:// or https://'});
      const fullTarget = path.join(PROJECT_ROOT, targetPath);
      if (fs.existsSync(fullTarget)) return json(res, 409, {error: 'Target file already exists'});
      const https = sourceUrl.startsWith('https') ? require('https') : require('http');
      const fetchedText = await new Promise((resolve, reject) => {
        const req = https.get(sourceUrl, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
          if (r.statusCode !== 200) { r.resume(); return resolve(null); }
          const chunks = [];
          r.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 1024 * 1024) { r.destroy(); resolve(null); } });
          r.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (!fetchedText) return json(res, 502, {error: 'Failed to fetch URL content'});
      let text = fetchedText.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const title = sanitizeText(customTitle) || 'Imported from ' + new URL(sourceUrl).hostname;
      const content = `---\ntitle: "${title}"\ndate: ${new Date().toISOString().slice(0, 10)}\nsource: "${sourceUrl}"\n---\n\n# ${title}\n\n${text.slice(0, 50000)}\n`;
      const dir = path.dirname(fullTarget);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(fullTarget, content, 'utf-8');
      invalidateCache('search');
      return json(res, 200, {success: true, path: targetPath, wordCount: text.split(/\s+/).length});
    } catch {
      return json(res, 400, {error: 'Import failed'});
    }
  }

  // ── Content scheduling ──
  if (req.method === 'POST' && pathname === '/api/schedule') {
    try {
      const body = await readBody(req);
      const {path: filePath, publishAt, note} = body;
      if (!filePath || typeof filePath !== 'string') return json(res, 400, {error: 'Missing or invalid path'});
      if (!publishAt || typeof publishAt !== 'string') return json(res, 400, {error: 'Missing or invalid publishAt'});
      if (note !== undefined && typeof note !== 'string') return json(res, 400, {error: 'note must be a string'});
      const SCHEDULE_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('schedule'));
      const schedule = loadJSON(SCHEDULE_FILE);
      if (!schedule.items) schedule.items = [];
      const item = {
        id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        path: sanitizeText(filePath),
        publishAt: sanitizeText(publishAt),
        note: note ? sanitizeText(note) : '',
        createdAt: new Date().toISOString(),
        status: 'scheduled',
      };
      schedule.items.push(item);
      saveJSON(SCHEDULE_FILE, schedule);
      return json(res, 200, {success: true, item});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/schedule') {
    const SCHEDULE_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('schedule'));
    const schedule = loadJSON(SCHEDULE_FILE);
    const items = (schedule.items || []).sort((a, b) => a.publishAt.localeCompare(b.publishAt));
    const now = new Date().toISOString();
    for (const item of items) {
      if (item.status === 'scheduled' && item.publishAt <= now) {
        item.status = 'due';
      }
    }
    // Tally both status buckets in a single pass over items rather than two
    // separate filter passes. The counts run after the promotion above, so the
    // totals stay identical to the prior post-loop filters; response unchanged.
    let upcoming = 0;
    let due = 0;
    for (const item of items) {
      if (item.status === 'scheduled') upcoming++;
      else if (item.status === 'due') due++;
    }
    return json(res, 200, {items, upcoming, due});
  }

  if (req.method === 'DELETE' && pathname === '/api/schedule') {
    try {
      const body = await readBody(req);
      const {id} = body;
      if (!id) return json(res, 400, {error: 'Missing id'});
      const SCHEDULE_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('schedule'));
      const schedule = loadJSON(SCHEDULE_FILE);
      if (!schedule.items) return json(res, 404, {error: 'Not found'});
      const idx = schedule.items.findIndex(i => i.id === id);
      if (idx === -1) return json(res, 404, {error: 'Scheduled item not found'});
      schedule.items.splice(idx, 1);
      saveJSON(SCHEDULE_FILE, schedule);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── File slides: convert markdown to slide presentation ──
  if (req.method === 'GET' && pathname === '/api/file/slides') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Snapshot this file's slide breakdown per path, mirroring the sibling
      // cached('feed-items', ...) above and the per-path caches elsewhere in the
      // codebase. The payload is a pure function of the file's on-disk bytes, so a
      // short TTL snapshot stays byte identical while skipping the repeat read on
      // the hot path. The isValidFilePath 400 guard and this try/catch stay OUTSIDE
      // the closure: an invalid path never reaches the cache, and a missing file
      // still returns 404 uncached (cached() stores nothing when fn throws).
      const result = cached('slides:' + filePath, 30000, () => {
        let content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        let title = path.basename(filePath, path.extname(filePath));
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
          const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (tm) title = tm[1];
          content = content.slice(fmMatch[0].length);
        }
        const slides = content.split(/\n---\n|(?=\n## )/).map(s => s.trim()).filter(s => s);
        return {
          title,
          slides: slides.map((text, i) => ({
            index: i,
            content: text,
          })),
          totalSlides: slides.length,
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Atom feed of recent content updates ──
  if (req.method === 'GET' && pathname === '/api/feed/atom') {
    try {
      const items = cached('feed-items', 60000, () => scanFeedItems(fs, path, PROJECT_ROOT, ALLOWED_EXTS));
      const recent = items.slice(0, 20);
      const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Mochi Lab</title>
<updated>${new Date().toISOString()}</updated>
<id>urn:mochi-lab:feed</id>
${recent.map(item => `<entry>
<title>${escapeFeedXml(item.title)}</title>
<link href="/${item.path.replace(/^content\//, '').replace(/\.(md|mdx)$/, '')}"/>
<updated>${item.date}</updated>
<id>urn:mochi-lab:${escapeFeedXml(item.path)}</id>
</entry>`).join('\n')}
</feed>`;
      res.writeHead(200, {
        'Content-Type': 'application/atom+xml; charset=utf-8',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(atom);
    } catch {
      return json(res, 500, {error: 'Atom feed generation failed'});
    }
  }

  // ── Activity heatmap: daily activity for last N days ──
  if (req.method === 'GET' && pathname === '/api/activity-heatmap') {
    try {
      const days = numericParam(url.searchParams.get('days'), 365, 365);
      const heatmap = cached('activity-heatmap', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const activity = {};
        function scanActivity(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanActivity(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const stat = fs.statSync(fp);
                const date = stat.mtime.toISOString().slice(0, 10);
                activity[date] = (activity[date] || 0) + 1;
              } catch {}
            }
          }
        }
        scanActivity(contentDir);
        return activity;
      });
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const filtered = {};
      for (const [date, count] of Object.entries(heatmap)) {
        if (date >= cutoff) filtered[date] = count;
      }
      return json(res, 200, {days: filtered, totalDays: Object.keys(filtered).length});
    } catch {
      return json(res, 500, {error: 'Heatmap failed'});
    }
  }

  // ── Daily activity summary ──
  if (req.method === 'GET' && pathname === '/api/summary/daily') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const todayISO = today + 'T00:00:00.000Z';
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const modifiedToday = [];
      function findModified(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { findModified(fp); continue; }
          if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            const stat = fs.statSync(fp);
            if (stat.mtime.toISOString().slice(0, 10) === today) {
              modifiedToday.push(path.relative(PROJECT_ROOT, fp));
            }
          }
        }
      }
      findModified(contentDir);
      const streakData = loadJSON(STREAKS_FILE);
      const defaultLog = (streakData['default'] && streakData['default'].dailyLog) || [];
      const todayEntry = defaultLog.find(e => e.date === today);
      return json(res, 200, {
        date: today,
        filesModifiedToday: modifiedToday.length,
        modifiedFiles: modifiedToday.slice(0, 20),
        wordsWrittenToday: todayEntry ? todayEntry.words : 0,
      });
    } catch {
      return json(res, 500, {error: 'Summary failed'});
    }
  }

};

module.exports.numericParam = numericParam;
module.exports.escapeFeedXml = escapeFeedXml;
