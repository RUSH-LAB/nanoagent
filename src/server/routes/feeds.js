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
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

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


  // ── XML Sitemap ──
  if (req.method === 'GET' && pathname === '/api/sitemap.xml') {
    try {
      // Cache the content-tree walk on a 60s window, mirroring the sibling cached
      // scans in this file (content-status, backlink-ranking, knowledge-gaps, ...).
      // The thunk builds and returns the url list; the XML is rendered from the
      // cached list below, so the emitted document is byte identical to before and
      // only the redundant per-request walk is removed.
      const urls = cached('sitemap-xml', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const collected = [];
        function scanSitemap(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanSitemap(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const stat = fs.statSync(fp);
            let urlPath = '/' + path.relative(path.join(PROJECT_ROOT, 'content'), fp)
              .replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
            if (urlPath.endsWith('/index')) urlPath = urlPath.slice(0, -6);
            collected.push({loc: urlPath, lastmod: stat.mtime.toISOString().slice(0, 10)});
          }
        }
        scanSitemap(contentDir);
        return collected;
      });
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `<url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>`;
      res.writeHead(200, {'Content-Type': 'application/xml; charset=utf-8', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(xml);
    } catch {
      return json(res, 500, {error: 'Sitemap generation failed'});
    }
  }
};

module.exports.numericParam = numericParam;
module.exports.escapeFeedXml = escapeFeedXml;
