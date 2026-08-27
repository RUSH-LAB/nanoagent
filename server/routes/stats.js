'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// Every /api/stats/* endpoint: corpus totals, per-file and per-directory
// aggregates, and the readability, reading-time and word-frequency measures.
// They were previously spread across four modules that had been split by size
// rather than by domain.

const { loadReferencesCached } = require('./references');

// Common words excluded from the /api/stats/word-frequency ranking.
const WORD_FREQ_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other','also','than','very','just','such','only']);

module.exports = async function stats_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  if (req.method === 'GET' && pathname === '/api/stats/overview') {
    try {
      // Memoize the whole recursive content scan and assembled result for 30s,
      // mirroring the sibling cached('content-stats'), cached('link-density'),
      // and cached('kb-outline') handlers in this file. The aggregate is
      // deterministic for a given content state, so serving a 30s snapshot is
      // behavior preserving while skipping the readdirSync/readFileSync walk on
      // repeat requests. The try/catch stays outside the closure so a failed
      // scan returns a 500 that is never cached.
      const overview = cached('stats-overview', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        let files = 0, words = 0, headings = 0, citations = 0, links = 0;
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              files++;
              try {
                const c = fs.readFileSync(fp, 'utf-8');
                words += c.split(/\s+/).filter(Boolean).length;
                headings += (c.match(/^#{1,6}\s+/gm) || []).length;
                citations += (c.match(/\[@/g) || []).length;
                links += (c.match(/\[\[/g) || []).length + (c.match(/\]\(/g) || []).length;
              } catch {}
            }
          }
        }
        scan(contentDir);
        let refs = 0;
        try { refs = Object.keys(loadReferencesCached(fs, path, PROJECT_ROOT)).length; } catch {}
        return {
          files, words, headings, citations, links, references: refs,
          avgWordsPerFile: files > 0 ? Math.round(words / files) : 0,
          avgHeadingsPerFile: files > 0 ? Math.round(headings / files * 10) / 10 : 0,
          avgCitationsPerFile: files > 0 ? Math.round(citations / files * 10) / 10 : 0,
          readingTimeHours: Math.round(words / 200 / 60 * 10) / 10,
        };
      });
      return json(res, 200, overview);
    } catch {
      return json(res, 500, {error: 'Overview failed'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/stats/link-density') {
    try {
      const density = cached('link-density', 60000, () => {
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
              const words = content.split(/\s+/).filter(Boolean).length;
              const wikiLinks = (content.match(/\[\[/g) || []).length;
              const mdLinks = (content.match(/\]\(/g) || []).length;
              const citations = (content.match(/\[@/g) || []).length;
              const totalLinks = wikiLinks + mdLinks + citations;
              const density = words > 0 ? Math.round((totalLinks / words) * 1000 * 10) / 10 : 0;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, words, totalLinks, wikiLinks, mdLinks, citations, linksPerKWords: density});
            } catch {}
          }
        }
        scan(contentDir);
        pages.sort((a, b) => b.linksPerKWords - a.linksPerKWords);
        return pages;
      });
      const avgDensity = density.length > 0 ? Math.round(density.reduce((s, p) => s + p.linksPerKWords, 0) / density.length * 10) / 10 : 0;
      return json(res, 200, {
        avgLinksPerKWords: avgDensity,
        mostLinked: density.slice(0, 10),
        leastLinked: density.filter(p => p.totalLinks === 0).slice(0, 10),
        total: density.length,
      });
    } catch {
      return json(res, 500, {error: 'Link density analysis failed'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/stats/word-frequency') {
    const dir = url.searchParams.get('dir');
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory'});
    try {
      // Memoize the recursive directory scan and assembled frequency table for 60s,
      // mirroring the sibling cached('stats-overview'), cached('content-summary'),
      // and cached('citations-per-page') handlers in this file. Unlike those, this
      // handler reads a `dir` query parameter, so the key carries `dir`: every
      // validated directory gets its own cache entry and the table is deterministic
      // for that directory's content state. Serving a 60s snapshot skips the
      // readdirSync/readFileSync walk on repeat requests while leaving the payload
      // byte identical. The isValidDir 400 guard stays above this try, and the
      // try/catch stays outside the closure, so an invalid directory never scans and
      // a failed scan returns a 500 that is never cached.
      const result = cached('word-frequency:' + dir, 60000, () => {
        const fullDir = path.join(PROJECT_ROOT, dir);
        const freq = {};
        function scan(d) {
          for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(d, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                let text = fs.readFileSync(fp, 'utf-8');
                text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
                text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !WORD_FREQ_STOP_WORDS.has(w)).forEach(w => { freq[w] = (freq[w] || 0) + 1; });
              } catch {}
            }
          }
        }
        scan(fullDir);
        const words = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([word, count]) => ({word, count}));
        return {directory: dir, words, totalUniqueWords: Object.keys(freq).length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Word frequency failed'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/stats/citations-per-page') {
    try {
      // Memoize the recursive content scan, sort, and assembled ranking for 60s,
      // mirroring the sibling cached('stats-overview'), cached('link-density'), and
      // cached('kb-outline') handlers in this file. The handler takes no query
      // parameters, so a single static key serves every request, and the ranking is
      // deterministic for a given content state: serving a 60s snapshot skips the
      // readdirSync/readFileSync walk on repeat requests while leaving the payload
      // byte identical. The try/catch stays outside the closure so a failed scan
      // returns a 500 that is never cached.
      const result = cached('citations-per-page', 60000, () => {
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
              const citations = (content.match(/\[@/g) || []).length;
              const words = content.split(/\s+/).filter(Boolean).length;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, citations, words, citationsPerKWords: words > 0 ? Math.round((citations / words) * 1000 * 10) / 10 : 0});
            } catch {}
          }
        }
        scan(contentDir);
        pages.sort((a, b) => b.citations - a.citations);
        return {pages: pages.slice(0, 20), total: pages.length, avgCitations: Math.round(pages.reduce((s, p) => s + p.citations, 0) / Math.max(pages.length, 1) * 10) / 10};
      });
      return json(res, 200, result);
    } catch { return json(res, 500, {error: 'Citation density failed'}); }
  }

  if (req.method === 'GET' && pathname === '/api/stats/compare') {
    const dir1 = url.searchParams.get('dir1');
    const dir2 = url.searchParams.get('dir2');
    if (!isValidDir(dir1) || !isValidDir(dir2)) return json(res, 400, {error: 'Invalid directories'});
    try {
      // Memoize the two-directory recursive scan and the assembled comparison for
      // 30s, mirroring the sibling cached('similarity:' + path1 + ':' + path2) and
      // cached('word-frequency:' + dir) caches in this file. The payload is a pure
      // function of the files under dir1 and dir2 plus the two query params — no
      // Date, randomness, network, mutable-store read, or wall-clock stamp (unlike
      // the productivity-report's generatedAt) — so the key carries both directories:
      // each (dir1, dir2) pair gets its own entry and a 30s snapshot stays byte
      // identical while skipping the repeat readdirSync/readFileSync word and heading
      // scan. The two isValidDir 400 guards stay above this try, and the try/catch
      // stays outside the closure, so invalid input never scans and a failed scan
      // returns a 500 that is never cached (the cached helper stores nothing when fn
      // throws).
      const result = cached('statscompare:' + dir1 + ':' + dir2, 30000, () => {
        function dirStats(dirPath) {
          const fullDir = path.join(PROJECT_ROOT, dirPath);
          let files = 0, words = 0, headings = 0;
          function scan(dir) {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
              if (entry.name.startsWith('.')) continue;
              const fp = path.join(dir, entry.name);
              if (entry.isDirectory()) { scan(fp); continue; }
              if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
                files++;
                try {
                  const c = fs.readFileSync(fp, 'utf-8');
                  words += c.split(/\s+/).filter(Boolean).length;
                  headings += (c.match(/^#{1,6}\s+/gm) || []).length;
                } catch {}
              }
            }
          }
          scan(fullDir);
          return {directory: dirPath, files, words, headings, avgWordsPerFile: files > 0 ? Math.round(words / files) : 0};
        }
        const stats1 = dirStats(dir1);
        const stats2 = dirStats(dir2);
        return {dir1: stats1, dir2: stats2, comparison: {
          fileDiff: stats1.files - stats2.files,
          wordDiff: stats1.words - stats2.words,
          avgWordsDiff: stats1.avgWordsPerFile - stats2.avgWordsPerFile,
        }};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Comparison failed'});
    }
  }

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

  if (req.method === 'GET' && pathname === '/api/stats/readability') {
    try {
      const stats = cached('readability-trends', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byDir = {};
        let totalGrade = 0, totalFiles = 0;
        function scan(dir, dirName) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp, dirName || entry.name); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              let text = fs.readFileSync(fp, 'utf-8');
              text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
              const words = text.split(/\s+/).filter(w => w.length > 0);
              const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
              if (words.length < 10) continue;
              const syllables = words.reduce((sum, w) => {
                const clean = w.toLowerCase().replace(/[^a-z]/g, '');
                if (!clean) return sum;
                let s = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
                return sum + Math.max(1, s ? s.length : 1);
              }, 0);
              const grade = Math.round((0.39 * (words.length / Math.max(sentences.length, 1)) + 11.8 * (syllables / words.length) - 15.59) * 10) / 10;
              const dn = dirName || 'root';
              if (!byDir[dn]) byDir[dn] = {grades: [], count: 0};
              byDir[dn].grades.push(grade);
              byDir[dn].count++;
              totalGrade += grade;
              totalFiles++;
            } catch {}
          }
        }
        scan(contentDir, null);
        const directories = Object.entries(byDir).map(([name, info]) => ({
          directory: name,
          avgGrade: Math.round(info.grades.reduce((s, g) => s + g, 0) / info.count * 10) / 10,
          fileCount: info.count,
          minGrade: Math.round(Math.min(...info.grades) * 10) / 10,
          maxGrade: Math.round(Math.max(...info.grades) * 10) / 10,
        })).sort((a, b) => a.avgGrade - b.avgGrade);
        return {
          overallAvgGrade: totalFiles > 0 ? Math.round(totalGrade / totalFiles * 10) / 10 : 0,
          totalFiles,
          directories,
        };
      });
      return json(res, 200, stats);
    } catch {
      return json(res, 500, {error: 'Readability trends failed'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/stats/directory') {
    const dir = url.searchParams.get('dir');
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory'});
    try {
      // Cache the recursive directory walk on a 30s window, keyed by the requested
      // `dir`, mirroring the sibling cached scans in this file (content-status,
      // backlink-ranking, health-summary, ...). Repeated requests for the same dir
      // skip the readdirSync/readFileSync walk and return the memoized result. The
      // isValidDir 400 guard and the try/catch 404 path stay OUTSIDE the cache: the
      // walk runs inside the closure, so a non-existent directory still throws and
      // propagates to the outer catch as a 404, and only a successful scan is ever
      // cached. The key carries `dir`, so each directory is a distinct cache entry.
      const result = cached('statsdir:' + dir, 30000, () => {
        const fullDir = path.join(PROJECT_ROOT, dir);
        let files = 0, words = 0, drafts = 0;
        function count(d) {
          for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(d, entry.name);
            if (entry.isDirectory()) { count(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              files++;
              try {
                const content = fs.readFileSync(fp, 'utf-8');
                words += content.split(/\s+/).filter(Boolean).length;
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (fmMatch && /^draft:\s*true/m.test(fmMatch[1])) drafts++;
              } catch {}
            }
          }
        }
        count(fullDir);
        return {directory: dir, files, words, drafts, avgWordsPerFile: files > 0 ? Math.round(words / files) : 0};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'Directory not found'});
    }
  }

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
};

// /api/stats/overview reads the bibliography through the shared memo, so the
// suites need the same reset hook the other readers expose.
module.exports._clearReferencesCache = require('./references')._resetReferencesCache;
