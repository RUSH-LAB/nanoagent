'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Parse a numeric query parameter, clamping to `max` and falling back to `def`
// when the value is absent or non-numeric. Without the fallback a stray
// `?limit=abc` parses to NaN, `Math.min(NaN, 20)` stays NaN, and the
// content-similar list collapses to `candidates.slice(0, NaN)` === empty even
// when matches exist. Absent and valid numeric values keep their previous behavior.
function numericParam(raw, def, max) {
  const n = parseInt(raw, 10);
  return Math.min(Number.isNaN(n) ? def : n, max);
}

// Stop-word sets for the keyword-overlap scoring in GET /api/content-recommend
// and GET /api/content-similar, built once at module load instead of rebuilt on
// every request. Each set is read only (`.has` membership tests), so hoisting
// leaves the recommendation and similarity outputs identical. The two lists
// intentionally differ (content-similar drops a few extra function words), so
// they stay as two distinct constants, mirroring RELATED_STOP_WORDS in
// server/routes/file-tools.js.
const RECOMMEND_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not']);
const SIMILAR_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other']);

module.exports = async function content_analysis_b_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Content publishing calendar ──
  if (req.method === 'GET' && pathname === '/api/content-calendar') {
    try {
      const calendar = cached('content-calendar', 60000, () => {
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
              if (fm) {
                const dm = fm[1].match(/^date:\s*["']?(\d{4}-\d{2})/m);
                if (dm) date = dm[1];
                const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
              }
              if (!date) {
                const stat = fs.statSync(fp);
                date = stat.mtime.toISOString().slice(0, 7);
              }
              if (!byMonth[date]) byMonth[date] = [];
              byMonth[date].push({path: path.relative(PROJECT_ROOT, fp), title});
            } catch {}
          }
        }
        scan(contentDir);
        return Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, pages]) => ({month, count: pages.length, pages: pages.slice(0, 5)}));
      });
      return json(res, 200, {calendar, totalMonths: calendar.length});
    } catch {
      return json(res, 500, {error: 'Calendar failed'});
    }
  }

  // ── Bibliography analytics ──
  if (req.method === 'GET' && pathname === '/api/references/analytics') {
    try {
      const analytics = cached('bib-analytics', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const entries = Object.values(refs);
        const years = entries.map(e => e.year).filter(Boolean);
        const avgYear = years.length > 0 ? Math.round(years.reduce((s, y) => s + y, 0) / years.length) : 0;
        const medianYear = years.length > 0 ? years.sort()[Math.floor(years.length / 2)] : 0;
        const avgAge = years.length > 0 ? Math.round(new Date().getFullYear() - avgYear) : 0;
        // Single pass over entries: the three accumulators are independent, so
        // tallying them together preserves each object's key-insertion order
        // (and therefore the downstream uniqueAuthors/uniqueVenues counts, the
        // sorted top-10 slices, and typeDistribution) versus three separate loops.
        const authorCounts = {};
        const venueCounts = {};
        const typeCounts = {};
        for (const e of entries) {
          for (const a of (e.author || [])) authorCounts[a] = (authorCounts[a] || 0) + 1;
          if (e.venue) venueCounts[e.venue] = (venueCounts[e.venue] || 0) + 1;
          const t = e.type || 'misc'; typeCounts[t] = (typeCounts[t] || 0) + 1;
        }
        return {
          totalReferences: entries.length,
          avgYear, medianYear, avgAge,
          uniqueAuthors: Object.keys(authorCounts).length,
          uniqueVenues: Object.keys(venueCounts).length,
          topAuthors: Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => ({name: n, count: c})),
          topVenues: Object.entries(venueCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => ({venue: v, count: c})),
          typeDistribution: typeCounts,
          yearRange: years.length > 0 ? {min: Math.min(...years), max: Math.max(...years)} : null,
        };
      });
      return json(res, 200, analytics);
    } catch {
      return json(res, 500, {error: 'Analytics failed'});
    }
  }

  // ── Graph export as DOT format ──
  if (req.method === 'GET' && pathname === '/api/graph/export') {
    const format = url.searchParams.get('format') || 'dot';
    if (format !== 'dot') return json(res, 400, {error: 'Only DOT format supported'});
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      const nodes = new Set();
      const edges = [];
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          let id = path.relative(path.join(PROJECT_ROOT, 'content'), fp).replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
          if (id.endsWith('/index')) id = id.slice(0, -6);
          nodes.add(id);
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            WIKI_RE.lastIndex = 0;
            let m;
            while ((m = WIKI_RE.exec(content)) !== null) {
              edges.push({from: id, to: m[1].trim()});
            }
          } catch {}
        }
      }
      scan(contentDir);
      const esc = s => s.replace(/"/g, '\\"');
      let dot = 'digraph KnowledgeGraph {\n  rankdir=LR;\n  node [shape=box, style=rounded];\n';
      for (const n of nodes) dot += `  "${esc(n)}";\n`;
      for (const e of edges) dot += `  "${esc(e.from)}" -> "${esc(e.to)}";\n`;
      dot += '}\n';
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="knowledge-graph.dot"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(dot);
    } catch {
      return json(res, 500, {error: 'DOT export failed'});
    }
  }

  // ── Reference reading order (topological sort by citation deps) ──
  if (req.method === 'GET' && pathname === '/api/references/reading-order') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
      const citesBefore = {};
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            CITE_RE.lastIndex = 0;
            const pageCites = [];
            let m;
            while ((m = CITE_RE.exec(content)) !== null) {
              const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
              pageCites.push(...keys);
            }
            for (let i = 0; i < pageCites.length; i++) {
              for (let j = i + 1; j < pageCites.length; j++) {
                const a = pageCites[i], b = pageCites[j];
                if (refs[a] && refs[b]) {
                  const yearA = refs[a].year || 9999;
                  const yearB = refs[b].year || 9999;
                  if (yearA < yearB) {
                    if (!citesBefore[b]) citesBefore[b] = new Set();
                    citesBefore[b].add(a);
                  } else if (yearB < yearA) {
                    if (!citesBefore[a]) citesBefore[a] = new Set();
                    citesBefore[a].add(b);
                  }
                }
              }
            }
          } catch {}
        }
      }
      scan(contentDir);
      const allKeys = Object.keys(refs);
      const visited = new Set();
      const order = [];
      function visit(key) {
        if (visited.has(key)) return;
        visited.add(key);
        for (const dep of (citesBefore[key] || [])) visit(dep);
        order.push(key);
      }
      allKeys.sort((a, b) => (refs[a].year || 9999) - (refs[b].year || 9999));
      for (const key of allKeys) visit(key);
      const readingOrder = order.slice(0, 30).map((key, i) => ({
        order: i + 1, key, title: refs[key].title, year: refs[key].year, venue: refs[key].venue,
        prerequisites: [...(citesBefore[key] || [])].slice(0, 5),
      }));
      return json(res, 200, {readingOrder, totalOrdered: order.length});
    } catch {
      return json(res, 500, {error: 'Reading order failed'});
    }
  }

  // ── Cross-reference matrix ──
  if (req.method === 'GET' && pathname === '/api/content-xref-matrix') {
    try {
      const matrix = cached('xref-matrix', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const WIKI_RE = /\[\[([^\]|]+)/g;
        const CITE_RE = /\[@([\w-]+)/g;
        const pages = {};
        const links = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            let id = path.relative(path.join(PROJECT_ROOT, 'content'), fp).replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
            if (id.endsWith('/index')) id = id.slice(0, -6);
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages[id] = title;
              WIKI_RE.lastIndex = 0;
              let m;
              while ((m = WIKI_RE.exec(content)) !== null) {
                links.push({from: id, to: m[1].trim(), type: 'wiki'});
              }
              CITE_RE.lastIndex = 0;
              while ((m = CITE_RE.exec(content)) !== null) {
                links.push({from: id, to: m[1], type: 'citation'});
              }
            } catch {}
          }
        }
        scan(contentDir);
        return {pages: Object.entries(pages).map(([id, title]) => ({id, title})).slice(0, 100), links: links.slice(0, 500), totalPages: Object.keys(pages).length, totalLinks: links.length};
      });
      return json(res, 200, matrix);
    } catch {
      return json(res, 500, {error: 'Matrix generation failed'});
    }
  }

  // ── Heading depth distribution ──
  if (req.method === 'GET' && pathname === '/api/stats/heading-depth') {
    try {
      const stats = cached('heading-depth', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const depthCounts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0};
        let totalHeadings = 0, filesWithHeadings = 0, filesWithoutHeadings = 0;
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const headings = content.match(/^(#{1,6})\s+/gm) || [];
              if (headings.length > 0) {
                filesWithHeadings++;
                for (const h of headings) {
                  const depth = h.trim().replace(/\s+$/, '').length;
                  if (depthCounts[depth] !== undefined) depthCounts[depth]++;
                  totalHeadings++;
                }
              } else {
                filesWithoutHeadings++;
              }
            } catch {}
          }
        }
        scan(contentDir);
        return {depthCounts, totalHeadings, filesWithHeadings, filesWithoutHeadings};
      });
      return json(res, 200, stats);
    } catch {
      return json(res, 500, {error: 'Heading analysis failed'});
    }
  }

  // ── Content update suggestions ──
  if (req.method === 'GET' && pathname === '/api/content-update-suggestions') {
    try {
      const suggestions = cached('update-suggestions', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const items = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const stat = fs.statSync(fp);
              const relPath = path.relative(PROJECT_ROOT, fp);
              const words = content.split(/\s+/).filter(Boolean).length;
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              const reasons = [];
              let priority = 0;
              if (words < 100) { reasons.push('Very short content (< 100 words)'); priority += 3; }
              if (!fm) { reasons.push('Missing frontmatter'); priority += 2; }
              else if (!/^title:/m.test(fm[1])) { reasons.push('Missing title in frontmatter'); priority += 2; }
              if (fm && !/^tags:/m.test(fm[1])) { reasons.push('No tags defined'); priority += 1; }
              const headings = (content.match(/^#{1,6}\s+/gm) || []).length;
              if (words > 500 && headings < 2) { reasons.push('Long content with few headings'); priority += 2; }
              const images = (content.match(/!\[/g) || []).length;
              if (words > 1000 && images === 0) { reasons.push('Long content with no images'); priority += 1; }
              if (reasons.length > 0) {
                items.push({path: relPath, title, reasons, priority, wordCount: words});
              }
            } catch {}
          }
        }
        scan(contentDir);
        return items.sort((a, b) => b.priority - a.priority).slice(0, 30);
      });
      return json(res, 200, {suggestions, total: suggestions.length});
    } catch {
      return json(res, 500, {error: 'Suggestions failed'});
    }
  }

  // ── Writing style analysis ──
  if (req.method === 'GET' && pathname === '/api/file/style') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
      const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 5);
      const words = text.split(/\s+/).filter(Boolean);
      const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 10);
      const sentenceLengths = sentences.map(s => s.split(/\s+/).length);
      const avgSentence = sentenceLengths.length > 0 ? Math.round(sentenceLengths.reduce((s, l) => s + l, 0) / sentenceLengths.length * 10) / 10 : 0;
      const sentenceVariance = sentenceLengths.length > 1 ? Math.round(Math.sqrt(sentenceLengths.reduce((s, l) => s + Math.pow(l - avgSentence, 2), 0) / sentenceLengths.length) * 10) / 10 : 0;
      const passivePatterns = /\b(is|are|was|were|been|being)\s+(being\s+)?\w+ed\b/gi;
      const passiveCount = (text.match(passivePatterns) || []).length;
      const passivePercentage = sentences.length > 0 ? Math.round((passiveCount / sentences.length) * 100) : 0;
      const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
      const vocabularyDiversity = words.length > 0 ? Math.round((uniqueWords / words.length) * 100) / 100 : 0;
      const paragraphLengths = paragraphs.map(p => p.split(/\s+/).length);
      const avgParagraph = paragraphLengths.length > 0 ? Math.round(paragraphLengths.reduce((s, l) => s + l, 0) / paragraphLengths.length) : 0;
      return json(res, 200, {
        path: filePath,
        style: {
          avgSentenceLength: avgSentence,
          sentenceLengthVariation: sentenceVariance,
          passiveVoicePercentage: passivePercentage,
          vocabularyDiversity,
          avgParagraphLength: avgParagraph,
          totalSentences: sentences.length,
          totalParagraphs: paragraphs.length,
          totalWords: words.length,
        },
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Content audience analysis ──
  if (req.method === 'GET' && pathname === '/api/content-audience') {
    try {
      const analysis = cached('content-audience', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byLevel = {beginner: [], intermediate: [], advanced: [], expert: []};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              let text = fs.readFileSync(fp, 'utf-8');
              text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
              const words = text.split(/\s+/).filter(w => w.length > 0);
              const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
              if (words.length < 20) return;
              const syllables = words.reduce((sum, w) => {
                const c = w.toLowerCase().replace(/[^a-z]/g, '');
                if (!c) return sum;
                let s = c.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
                return sum + Math.max(1, s ? s.length : 1);
              }, 0);
              const grade = 0.39 * (words.length / Math.max(sentences.length, 1)) + 11.8 * (syllables / words.length) - 15.59;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = text.match(/title:\s*["']?(.+?)["']?\s*$/m);
              if (fm) title = fm[1];
              const level = grade <= 8 ? 'beginner' : grade <= 12 ? 'intermediate' : grade <= 16 ? 'advanced' : 'expert';
              byLevel[level].push({path: path.relative(PROJECT_ROOT, fp), title, grade: Math.round(grade * 10) / 10});
            } catch {}
          }
        }
        scan(contentDir);
        return byLevel;
      });
      return json(res, 200, {
        counts: {beginner: analysis.beginner.length, intermediate: analysis.intermediate.length, advanced: analysis.advanced.length, expert: analysis.expert.length},
        beginner: analysis.beginner.slice(0, 10),
        intermediate: analysis.intermediate.slice(0, 10),
        advanced: analysis.advanced.slice(0, 10),
        expert: analysis.expert.slice(0, 10),
      });
    } catch {
      return json(res, 500, {error: 'Audience analysis failed'});
    }
  }

  // ── Word count leaderboard ──
  if (req.method === 'GET' && pathname === '/api/stats/word-leaderboard') {
    try {
      const leaderboard = cached('word-leaderboard', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const pages = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const wordCount = content.split(/\s+/).filter(Boolean).length;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, wordCount});
            } catch {}
          }
        }
        scan(contentDir);
        pages.sort((a, b) => b.wordCount - a.wordCount);
        return pages;
      });
      return json(res, 200, {
        longest: leaderboard.slice(0, 20),
        shortest: leaderboard.slice(-10).reverse(),
        total: leaderboard.length,
        avgWordCount: Math.round(leaderboard.reduce((s, p) => s + p.wordCount, 0) / Math.max(leaderboard.length, 1)),
      });
    } catch {
      return json(res, 500, {error: 'Leaderboard failed'});
    }
  }

  // ── Reference deduplication detection ──
  if (req.method === 'GET' && pathname === '/api/references/duplicates') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const titleMap = {};
      for (const [key, entry] of Object.entries(refs)) {
        const normTitle = (entry.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (normTitle.length < 5) continue;
        if (!titleMap[normTitle]) titleMap[normTitle] = [];
        titleMap[normTitle].push({key, title: entry.title, year: entry.year, venue: entry.venue});
      }
      const duplicates = Object.values(titleMap).filter(g => g.length > 1).map(g => ({
        title: g[0].title,
        entries: g,
        count: g.length,
      })).sort((a, b) => b.count - a.count);
      return json(res, 200, {duplicates, totalDuplicateGroups: duplicates.length, totalDuplicateEntries: duplicates.reduce((s, d) => s + d.count, 0)});
    } catch {
      return json(res, 500, {error: 'Deduplication failed'});
    }
  }

  // ── Content coverage map ──
  if (req.method === 'GET' && pathname === '/api/content-coverage') {
    try {
      const coverage = cached('content-coverage', 120000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const venueTopics = {};
        for (const entry of Object.values(refs)) {
          const venue = entry.venue || 'Unknown';
          if (!venueTopics[venue]) venueTopics[venue] = {refCount: 0, cited: 0};
          venueTopics[venue].refCount++;
        }
        const CITE_RE = /\[@([\w-]+)/g;
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const c = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              const cited = new Set();
              let m;
              while ((m = CITE_RE.exec(c)) !== null) cited.add(m[1]);
              for (const key of cited) {
                const ref = refs[key];
                if (ref) {
                  const venue = ref.venue || 'Unknown';
                  if (venueTopics[venue]) venueTopics[venue].cited++;
                }
              }
            } catch {}
          }
        }
        scan(contentDir);
        return Object.entries(venueTopics)
          .map(([venue, data]) => ({venue, references: data.refCount, cited: data.cited, coverage: data.refCount > 0 ? Math.round((data.cited / data.refCount) * 100) : 0}))
          .sort((a, b) => b.references - a.references)
          .slice(0, 30);
      });
      return json(res, 200, {coverage, total: coverage.length});
    } catch {
      return json(res, 500, {error: 'Coverage map failed'});
    }
  }

  // ── Total reading time estimation ──
  if (req.method === 'GET' && pathname === '/api/stats/reading-time') {
    try {
      const stats = cached('reading-time-stats', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byDir = {};
        let totalWords = 0;
        function scan(dir, dirName) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp, dirName || entry.name); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const words = fs.readFileSync(fp, 'utf-8').split(/\s+/).filter(Boolean).length;
              totalWords += words;
              const dn = dirName || 'root';
              if (!byDir[dn]) byDir[dn] = 0;
              byDir[dn] += words;
            } catch {}
          }
        }
        scan(contentDir, null);
        return {totalWords, byDir};
      });
      const totalMinutes = Math.ceil(stats.totalWords / 200);
      const totalHours = Math.round(totalMinutes / 60 * 10) / 10;
      const directories = Object.entries(stats.byDir).map(([name, words]) => ({
        name, words, readingTimeMinutes: Math.ceil(words / 200), readingTimeHours: Math.round(words / 200 / 60 * 10) / 10,
      })).sort((a, b) => b.words - a.words);
      return json(res, 200, {totalWords: stats.totalWords, totalReadingMinutes: totalMinutes, totalReadingHours: totalHours, directories});
    } catch {
      return json(res, 500, {error: 'Reading time calculation failed'});
    }
  }

  // ── Personalized content recommendations ──
  if (req.method === 'GET' && pathname === '/api/content-recommend') {
    const userId = url.searchParams.get('userId') || 'default';
    try {
      const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');
      const progressData = loadJSON(PROGRESS_FILE);
      const readPages = new Set(Object.keys(progressData[userId] || {}));
      const bookmarks = loadJSON(BOOKMARKS_FILE);
      const bookmarkedPaths = new Set((bookmarks.bookmarks || []).map(b => b.path));
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const interestWords = {};
      for (const pagePath of [...readPages, ...bookmarkedPaths]) {
        if (!isValidFilePath(pagePath)) continue;
        try {
          const content = fs.readFileSync(path.join(PROJECT_ROOT, pagePath), 'utf-8');
          const words = content.replace(/^---[\s\S]*?---/, '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !RECOMMEND_STOP_WORDS.has(w));
          for (const w of words) interestWords[w] = (interestWords[w] || 0) + 1;
        } catch {}
      }
      const topInterests = new Set(Object.entries(interestWords).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w));
      const candidates = [];
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          const rel = path.relative(PROJECT_ROOT, fp);
          if (readPages.has(rel)) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            const words = content.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4);
            let score = 0;
            for (const w of words) { if (topInterests.has(w)) score++; }
            if (score > 3) {
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              candidates.push({path: rel, title, relevanceScore: score});
            }
          } catch {}
        }
      }
      scan(contentDir);
      candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
      return json(res, 200, {recommendations: candidates.slice(0, 10), basedOn: {pagesRead: readPages.size, bookmarks: bookmarkedPaths.size}});
    } catch {
      return json(res, 500, {error: 'Recommendation failed'});
    }
  }

  // ── Reference field completeness ──
  if (req.method === 'GET' && pathname === '/api/references/completeness') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const FIELDS = ['title', 'author', 'year', 'venue', 'doi', 'url'];
      const results = [];
      // Per-field present-count, accumulated once during the entry loop below so
      // fieldCoverage no longer rescans every reference twice for each field.
      const fieldPresent = {};
      for (const f of FIELDS) fieldPresent[f] = 0;
      let totalComplete = 0;
      for (const [key, entry] of Object.entries(refs)) {
        const missing = FIELDS.filter(f => !entry[f] || (Array.isArray(entry[f]) && entry[f].length === 0));
        const present = FIELDS.filter(f => entry[f] && (!Array.isArray(entry[f]) || entry[f].length > 0));
        for (const f of present) fieldPresent[f]++;
        const completeness = Math.round((present.length / FIELDS.length) * 100);
        if (completeness === 100) totalComplete++;
        results.push({key, title: entry.title || key, completeness, missing, presentCount: present.length});
      }
      results.sort((a, b) => a.completeness - b.completeness);
      const avgCompleteness = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.completeness, 0) / results.length) : 0;
      const coverageDenom = Math.max(results.length, 1);
      return json(res, 200, {
        averageCompleteness: avgCompleteness,
        totalReferences: results.length,
        fullyComplete: totalComplete,
        incomplete: results.filter(r => r.completeness < 100).slice(0, 30),
        fieldCoverage: FIELDS.map(f => ({field: f, count: fieldPresent[f], percentage: Math.round(fieldPresent[f] / coverageDenom * 100)})),
      });
    } catch {
      return json(res, 500, {error: 'Completeness check failed'});
    }
  }

  // ── Content semantic similarity (TF-IDF-like) ──
  if (req.method === 'GET' && pathname === '/api/content-similar') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const limit = numericParam(url.searchParams.get('limit'), 5, 20);
    try {
      function getKeywords(text) {
        return text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ')
          .toLowerCase().split(/\s+/).filter(w => w.length > 4 && !SIMILAR_STOP_WORDS.has(w));
      }
      const sourceContent = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const sourceWords = getKeywords(sourceContent);
      const sourceFreq = {};
      for (const w of sourceWords) sourceFreq[w] = (sourceFreq[w] || 0) + 1;
      const sourceTopWords = new Set(Object.entries(sourceFreq).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w]) => w));
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const candidates = [];
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          const rel = path.relative(PROJECT_ROOT, fp);
          if (rel === filePath) continue;
          try {
            const c = fs.readFileSync(fp, 'utf-8');
            const words = getKeywords(c);
            const targetSet = new Set(words);
            let overlap = 0;
            for (const w of sourceTopWords) { if (targetSet.has(w)) overlap++; }
            if (overlap > 2) {
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = c.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              candidates.push({path: rel, title, similarity: Math.round((overlap / sourceTopWords.size) * 100) / 100});
            }
          } catch {}
        }
      }
      scan(contentDir);
      candidates.sort((a, b) => b.similarity - a.similarity);
      return json(res, 200, {similar: candidates.slice(0, limit), total: candidates.length});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Trending references (recent + highly cited) ──
  if (req.method === 'GET' && pathname === '/api/references/trending') {
    try {
      const trending = cached('ref-trending', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+)/g;
        const citeCounts = {};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const c = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              let m;
              while ((m = CITE_RE.exec(c)) !== null) citeCounts[m[1]] = (citeCounts[m[1]] || 0) + 1;
            } catch {}
          }
        }
        scan(contentDir);
        const currentYear = new Date().getFullYear();
        const recentPapers = [];
        for (const [key, entry] of Object.entries(refs)) {
          if (entry.year && entry.year >= currentYear - 2) {
            const citations = citeCounts[key] || 0;
            if (citations > 0) {
              recentPapers.push({key, title: entry.title, year: entry.year, venue: entry.venue, citations});
            }
          }
        }
        return recentPapers.sort((a, b) => b.citations - a.citations).slice(0, 20);
      });
      return json(res, 200, {trending, total: trending.length});
    } catch {
      return json(res, 500, {error: 'Trending analysis failed'});
    }
  }

  // ── Content complexity analysis ──
  if (req.method === 'GET' && pathname === '/api/file/complexity') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const words = content.split(/\s+/).filter(Boolean);
      const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
      const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 3);
      const avgSentenceLength = sentences.length > 0 ? Math.round(words.length / sentences.length * 10) / 10 : 0;
      const headings = (content.match(/^#{1,6}\s+/gm) || []).length;
      const maxHeadingDepth = Math.max(0, ...(content.match(/^#{1,6}/gm) || []).map(h => h.length));
      const codeBlocks = (content.match(/```/g) || []).length / 2;
      const mathBlocks = (content.match(/\$\$/g) || []).length / 2 + (content.match(/\\\[/g) || []).length;
      const citations = (content.match(/\[@/g) || []).length;
      const links = (content.match(/\[\[/g) || []).length + (content.match(/\]\(/g) || []).length;
      const lists = (content.match(/^[-*+]\s/gm) || []).length + (content.match(/^\d+\.\s/gm) || []).length;
      const vocabularyRichness = words.length > 0 ? Math.round((uniqueWords / words.length) * 100) / 100 : 0;
      const complexityScore = Math.min(100, Math.round(
        (avgSentenceLength > 20 ? 15 : avgSentenceLength * 0.75) +
        Math.min(20, headings * 3) +
        Math.min(15, codeBlocks * 5) +
        Math.min(15, mathBlocks * 5) +
        Math.min(10, citations * 2) +
        Math.min(10, links * 2) +
        (vocabularyRichness > 0.6 ? 15 : vocabularyRichness * 25)
      ));
      return json(res, 200, {
        path: filePath, complexityScore,
        metrics: {wordCount: words.length, uniqueWords, vocabularyRichness, avgSentenceLength, headings, maxHeadingDepth, codeBlocks: Math.floor(codeBlocks), mathBlocks: Math.floor(mathBlocks), citations, links, lists},
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

};

module.exports.numericParam = numericParam;
