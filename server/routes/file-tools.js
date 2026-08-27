'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

const { numericParam } = require('../server-utils');

// Stop words dropped before the GET /api/file/related handler measures word
// overlap between two files. This set is identical on every request, so it is
// built once at module load rather than rebuilt per request. The other
// file-tools handlers (suggest-tags, keywords) keep their own separate stop
// lists, which intentionally differ from this one.
const RELATED_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not']);

// Stop-word sets for the keyword filtering in GET /api/file/suggest-tags and
// GET /api/file/keywords, built once at module load instead of rebuilt on every
// request. Each set is read only (`.has` membership tests inside a `.filter`),
// so hoisting leaves the suggested tags and extracted keywords identical. The
// two lists intentionally differ in length, so they stay as two distinct
// constants, mirroring the SIMILARITY_STOP_WORDS / RECOMMEND_STOP_WORDS /
// WORD_FREQ_STOP_WORDS hoist in server/routes/content-analysis-a.js.
const SUGGEST_TAGS_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other','very','just','than','too','own','same']);
const KEYWORDS_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','and','but','or','nor','for','yet','so','in','on','at','to','by','of','with','from','up','about','into','through','during','before','after','above','below','between','out','off','over','under','again','further','then','once','here','there','when','where','why','how','all','each','every','both','few','more','most','other','some','such','no','not','only','own','same','than','too','very','just','because','as','until','while','this','that','these','those','it','its','he','she','they','them','their','we','our','you','your','i','me','my','what','which','who','whom','if']);

// Link-extraction patterns for GET /api/file/dependencies, compiled once at
// module load instead of on every request. Each is a global (/g) regex whose
// `lastIndex` advances as it scans, so every exec loop below resets `lastIndex`
// to 0 before reusing the pattern, keeping back-to-back requests independent.
// This mirrors the convention in the sibling content-analysis route files.
const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
const MD_LINK_RE = /\[([^\]]*)\]\(\/([^)#?]+)\)/g;

// Per-word syllable patterns for GET /api/file/readability, compiled once at
// module load instead of four RegExp allocations per word of every request.
// Each is applied only through String.prototype.replace / String.prototype.match,
// which reset lastIndex on every call, so the shared /g instances stay
// request-independent and the syllable counts, grade, and reading level are
// byte-identical to the per-word build.
const READ_NONALPHA_RE = /[^a-z]/g;
const READ_SYLLABLE_TRIM_RE = /(?:[^laeiouy]es|ed|[^laeiouy]e)$/;
const READ_LEADING_Y_RE = /^y/;
const READ_VOWEL_GROUP_RE = /[aeiouy]{1,2}/g;

// Markdown-stripping patterns for GET /api/file/keywords, compiled once at module
// load instead of rebuilt on every request. Seven run through String.prototype.replace
// and KEYWORDS_SPLIT_RE through String.prototype.split; both reset or ignore lastIndex
// and run to completion each call, so the shared /g instances stay request-independent
// and the extracted keywords and totalWords are byte-identical to the per-request build.
// Six of them (FRONTMATTER, FENCE, INLINE_CODE, LINK, HEADING, HTML) are now shared by
// the GET /api/file/readability handler too, which previously rebuilt byte-identical
// copies per request; its punct, sentence-split, and word-split patterns genuinely
// differ from KEYWORDS_PUNCT_RE / KEYWORDS_SPLIT_RE, so they stay inline there. The
// /summary, /related, and /suggest-tags handlers keep their own inline patterns.
// Mirrors the WIKI_RE / READ_* hoists above.
const KEYWORDS_FRONTMATTER_RE = /^---[\s\S]*?---/;
const KEYWORDS_FENCE_RE = /```[\s\S]*?```/g;
const KEYWORDS_INLINE_CODE_RE = /`[^`]*`/g;
const KEYWORDS_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
const KEYWORDS_HEADING_RE = /#{1,6}\s*/g;
const KEYWORDS_PUNCT_RE = /[*_~`>|\\[\]()-]/g;
const KEYWORDS_HTML_RE = /<[^>]+>/g;
const KEYWORDS_SPLIT_RE = /[^a-z]+/;

module.exports = async function file_tools_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── File versioning: manual named versions ──
  if (req.method === 'POST' && pathname === '/api/file/version') {
    if (!rateLimit(`file-version:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, label} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (label !== undefined && typeof label === 'string' && label.length > 500) return json(res, 400, {error: 'Label must be 500 characters or fewer'});
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
      const versions = loadJSON(VERSIONS_FILE);
      if (!versions[filePath]) versions[filePath] = [];
      const version = {
        id: `ver_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        label: sanitizeText(label || 'Untitled version'),
        content,
        createdAt: new Date().toISOString(),
        wordCount: content.split(/\s+/).filter(Boolean).length,
      };
      versions[filePath].push(version);
      if (versions[filePath].length > 50) versions[filePath] = versions[filePath].slice(-50);
      saveJSON(VERSIONS_FILE, versions);
      return json(res, 200, {success: true, version: {id: version.id, label: version.label, createdAt: version.createdAt, wordCount: version.wordCount}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/file/versions') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
    const versions = loadJSON(VERSIONS_FILE);
    const fileVersions = (versions[filePath] || []).map(v => ({id: v.id, label: v.label, createdAt: v.createdAt, wordCount: v.wordCount}));
    return json(res, 200, {versions: fileVersions.reverse(), total: fileVersions.length});
  }

  if (req.method === 'GET' && pathname === '/api/file/version') {
    const filePath = url.searchParams.get('path');
    const versionId = url.searchParams.get('id');
    if (!isValidFilePath(filePath) || !versionId) return json(res, 400, {error: 'Invalid params'});
    const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
    const versions = loadJSON(VERSIONS_FILE);
    const v = (versions[filePath] || []).find(v => v.id === versionId);
    if (!v) return json(res, 404, {error: 'Version not found'});
    return json(res, 200, {version: v});
  }

  // ── Global search across all data types ──
  if (req.method === 'GET' && pathname === '/api/search/global') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    const limit = Math.max(numericParam(url.searchParams.get('limit'), 30, 100), 0);
    try {
      const results = [];
      const contentDir = path.join(PROJECT_ROOT, 'content');
      function searchContent(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { searchContent(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            if (content.toLowerCase().includes(query)) {
              const relPath = path.relative(PROJECT_ROOT, fp);
              results.push({type: 'content', path: relPath, name: entry.name});
            }
          } catch {}
        }
      }
      searchContent(contentDir);
      const {loadReferencesCached} = require('./references');
      try {
        const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
        for (const [key, entry] of Object.entries(refs)) {
          const searchable = [key, entry.title || '', (entry.author || []).join(' ')].join(' ').toLowerCase();
          if (searchable.includes(query)) {
            results.push({type: 'reference', key, title: entry.title});
          }
        }
      } catch {}
      const comments = loadJSON(COMMENTS_FILE);
      for (const [page, pageComments] of Object.entries(comments)) {
        if (Array.isArray(pageComments)) {
          for (const c of pageComments) {
            if ((c.text || '').toLowerCase().includes(query)) {
              results.push({type: 'comment', page, text: c.text.slice(0, 100), author: c.author});
            }
          }
        }
      }
      const discData = loadJSON(DISCUSSIONS_FILE);
      for (const [channelId, msgs] of Object.entries(discData.messages || {})) {
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            if ((m.text || '').toLowerCase().includes(query)) {
              results.push({type: 'message', channel: channelId, text: m.text.slice(0, 100), author: m.author});
            }
          }
        }
      }
      return json(res, 200, {results: results.slice(0, limit), total: results.length, query});
    } catch {
      return json(res, 500, {error: 'Global search failed'});
    }
  }

  // ── File dependencies: outgoing + incoming links ──
  if (req.method === 'GET' && pathname === '/api/file/dependencies') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-path dependencies result so repeated requests for the same
      // file skip the recursive scanIncoming walk over content/. The readFileSync
      // for the source file stays inside the closure, so a missing file still
      // throws here and propagates to the outer catch (the 404 is never cached).
      const result = cached('filedeps:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const outgoing = [];
        let m;
        WIKI_RE.lastIndex = 0;
        while ((m = WIKI_RE.exec(content)) !== null) outgoing.push({type: 'wiki', target: m[1].trim()});
        CITE_RE.lastIndex = 0;
        while ((m = CITE_RE.exec(content)) !== null) {
          const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
          for (const key of keys) outgoing.push({type: 'citation', target: key});
        }
        MD_LINK_RE.lastIndex = 0;
        while ((m = MD_LINK_RE.exec(content)) !== null) outgoing.push({type: 'link', target: m[2].trim()});
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const baseName = path.basename(filePath, path.extname(filePath));
        // baseName is a const derived from the validated filePath, so the
        // incoming-link suffix '/' + baseName is invariant across the whole
        // scanIncoming walk. Build it once here instead of re-concatenating it
        // on every WIKI_RE match below.
        const baseSuffix = '/' + baseName;
        const incoming = [];
        function scanIncoming(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanIncoming(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            if (rel === filePath) continue;
            try {
              const c = fs.readFileSync(fp, 'utf-8');
              WIKI_RE.lastIndex = 0;
              while ((m = WIKI_RE.exec(c)) !== null) {
                const target = m[1].trim();
                if (target === baseName || target.endsWith(baseSuffix)) {
                  incoming.push({type: 'wiki', source: rel});
                  break;
                }
              }
            } catch {}
          }
        }
        scanIncoming(contentDir);
        return {
          path: filePath,
          outgoing,
          incoming,
          outgoingCount: outgoing.length,
          incomingCount: incoming.length,
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File summary: extract brief summary ──
  if (req.method === 'GET' && pathname === '/api/file/summary') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-path summary so repeated requests for the same file skip the
      // frontmatter/code/HTML stripping and heading scan. The readFileSync stays
      // inside the closure, so a missing file still throws here and propagates to the
      // outer catch (the 404 is never cached). Mirrors the /api/file/dependencies and
      // /api/file/related caches in this module.
      const result = cached('filesummary:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        let body = content;
        const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n?/);
        let title = path.basename(filePath, path.extname(filePath));
        if (fmMatch) {
          const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (tm) title = tm[1];
          body = body.slice(fmMatch[0].length);
        }
        body = body.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '').replace(/import\s+.*$/gm, '');
        const paragraphs = body.split(/\n\n+/).map(p => p.replace(/^#+\s*/gm, '').trim()).filter(p => p.length > 20 && !p.startsWith('import'));
        const summary = paragraphs.slice(0, 2).join(' ').slice(0, 300);
        const headings = [];
        for (const line of content.split('\n')) {
          const m = line.match(/^(#{1,3})\s+(.+)$/);
          if (m) headings.push(m[2].trim());
        }
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        return {title, summary, headings: headings.slice(0, 10), wordCount, readingTime: Math.ceil(wordCount / 200)};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Batch file info ──
  if (req.method === 'POST' && pathname === '/api/files/info') {
    if (!rateLimit(`files-info:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {paths} = body;
      if (!Array.isArray(paths)) return json(res, 400, {error: 'paths must be an array'});
      const results = [];
      for (const filePath of paths.slice(0, 50)) {
        if (!isValidFilePath(filePath)) { results.push({path: filePath, error: 'Invalid path'}); continue; }
        try {
          const fullPath = path.join(PROJECT_ROOT, filePath);
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf-8');
          const wordCount = content.split(/\s+/).filter(Boolean).length;
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          let title = path.basename(filePath, path.extname(filePath));
          let draft = false;
          if (fmMatch) {
            const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (tm) title = tm[1];
            if (/^draft:\s*true/m.test(fmMatch[1])) draft = true;
          }
          results.push({path: filePath, title, size: stat.size, wordCount, draft, mtime: stat.mtime.toISOString()});
        } catch {
          results.push({path: filePath, error: 'File not found'});
        }
      }
      return json(res, 200, {results, count: results.length});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── File outline: heading structure ──
  if (req.method === 'GET' && pathname === '/api/file/outline') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-path outline so repeated requests for the same file skip the
      // line-by-line code-fence walk. The readFileSync stays inside the closure, so a
      // missing file still throws here and propagates to the outer catch (the 404 is
      // never cached). Mirrors the /api/file/dependencies and /api/file/related caches in this module.
      const result = cached('fileoutline:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const headings = [];
        const lines = content.split('\n');
        let inCode = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('```')) { inCode = !inCode; continue; }
          if (inCode) continue;
          const match = line.match(/^(#{1,6})\s+(.+)$/);
          if (match) {
            headings.push({level: match[1].length, text: match[2].trim(), line: i + 1});
          }
        }
        return {headings, count: headings.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Suggest tags for a file based on content ──
  if (req.method === 'GET' && pathname === '/api/file/suggest-tags') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-path suggestion payload so repeated requests for the same file
      // skip the source read, the frequency-map build, and the suggestion fold over the
      // corpus tag set. The source readFileSync stays inside the closure, so a missing
      // file still throws here and propagates to the outer catch (the 404 is never
      // cached). The inner all-tags-set cache is preserved, so the whole payload carries
      // the same 30s staleness that corpus cache already has. Mirrors the
      // /api/file/dependencies, /summary, /outline, and /lint caches in this module.
      const result = cached('suggesttags:' + filePath, 30000, () => {
        let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s-]/g, ' ');
        const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !SUGGEST_TAGS_STOP_WORDS.has(w));
        const freq = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
        const existingTags = cached('all-tags-set', 30000, () => {
          const contentDir = path.join(PROJECT_ROOT, 'content');
          const tagSet = new Set();
          function scan(dir) {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
              if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
              const fp = path.join(dir, entry.name);
              if (entry.isDirectory()) { scan(fp); continue; }
              if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
                try {
                  const c = fs.readFileSync(fp, 'utf-8');
                  const fm = c.match(/^---\n([\s\S]*?)\n---/);
                  if (fm) {
                    const tgm = fm[1].match(/^tags:\s*\[([^\]]*)\]/m);
                    if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => tagSet.add(t));
                  }
                } catch {}
              }
            }
          }
          scan(contentDir);
          return tagSet;
        });
        const suggestions = [];
        for (const tag of existingTags) {
          const tagLower = tag.toLowerCase();
          const tagFreq = freq[tagLower];
          if (tagFreq && tagFreq >= 2) {
            suggestions.push({tag, confidence: Math.min(tagFreq / 5, 1)});
          }
          const hyphenated = tagLower.replace(/-/g, ' ').split(' ');
          if (hyphenated.length > 1 && hyphenated.every(w => freq[w] && freq[w] >= 1)) {
            suggestions.push({tag, confidence: 0.7});
          }
        }
        const topKeywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word]) => word);
        const uniqueSuggestions = [...new Map(suggestions.map(s => [s.tag, s])).values()]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 10);
        return {suggestions: uniqueSuggestions, topKeywords};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File markdown lint ──
  if (req.method === 'GET' && pathname === '/api/file/lint') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-path lint result so repeated requests for the same file skip the
      // frontmatter check and line-by-line issue scan. The readFileSync stays inside
      // the closure, so a missing file still throws here and propagates to the outer
      // catch (the 404 is never cached). Mirrors the /api/file/dependencies and
      // /api/file/related caches in this module.
      const result = cached('filelint:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const issues = [];
        const lines = content.split('\n');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) {
          issues.push({line: 1, severity: 'warning', message: 'Missing frontmatter'});
        } else {
          if (!/^title:/m.test(fmMatch[1])) {
            issues.push({line: 1, severity: 'warning', message: 'Missing title in frontmatter'});
          }
        }
        let inCodeBlock = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
          if (inCodeBlock) continue;
          if (line.length > 500) {
            issues.push({line: i + 1, severity: 'info', message: `Very long line (${line.length} chars)`});
          }
          if (/^#{1,6}\s*$/.test(line)) {
            issues.push({line: i + 1, severity: 'warning', message: 'Empty heading'});
          }
          const openBrackets = (line.match(/\[/g) || []).length;
          const closeBrackets = (line.match(/\]/g) || []).length;
          if (openBrackets !== closeBrackets && !line.includes('[[') && !line.includes(']]')) {
            issues.push({line: i + 1, severity: 'info', message: 'Potentially unclosed brackets'});
          }
          if (/^\s+#/.test(line) && !/^\s+#.*code/i.test(line)) {
            issues.push({line: i + 1, severity: 'info', message: 'Heading has leading whitespace'});
          }
        }
        if (inCodeBlock) {
          issues.push({line: lines.length, severity: 'error', message: 'Unclosed code block'});
        }
        return {issues, issueCount: issues.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File readability score ──
  if (req.method === 'GET' && pathname === '/api/file/readability') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      text = text.replace(KEYWORDS_FRONTMATTER_RE, '');
      text = text.replace(KEYWORDS_FENCE_RE, '').replace(KEYWORDS_INLINE_CODE_RE, '');
      text = text.replace(KEYWORDS_LINK_RE, '$1');
      text = text.replace(KEYWORDS_HEADING_RE, '').replace(KEYWORDS_HTML_RE, '');
      text = text.replace(/[*_~>|\\[\]]/g, '');
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
      const words = text.split(/\s+/).filter(w => w.length > 0);
      const syllableCount = words.reduce((sum, w) => {
        const clean = w.toLowerCase().replace(READ_NONALPHA_RE, '');
        if (!clean) return sum;
        let syllables = clean.replace(READ_SYLLABLE_TRIM_RE, '').replace(READ_LEADING_Y_RE, '').match(READ_VOWEL_GROUP_RE);
        return sum + Math.max(1, syllables ? syllables.length : 1);
      }, 0);
      const wordCount = words.length;
      const sentenceCount = Math.max(sentences.length, 1);
      const avgWordsPerSentence = Math.round((wordCount / sentenceCount) * 10) / 10;
      const avgSyllablesPerWord = Math.round((syllableCount / Math.max(wordCount, 1)) * 10) / 10;
      const fleschKincaid = Math.round((0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59) * 10) / 10;
      const readingTimeMin = Math.ceil(wordCount / 200);
      let level = 'Advanced';
      if (fleschKincaid <= 6) level = 'Easy';
      else if (fleschKincaid <= 10) level = 'Intermediate';
      else if (fleschKincaid <= 14) level = 'Advanced';
      else level = 'Expert';
      return json(res, 200, {
        wordCount, sentenceCount, avgWordsPerSentence, avgSyllablesPerWord,
        fleschKincaidGrade: fleschKincaid, readingLevel: level,
        readingTimeMinutes: readingTimeMin,
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Related pages: suggest pages related to a given file ──
  if (req.method === 'GET' && pathname === '/api/file/related') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-path related result so repeated requests for the same file
      // skip the recursive scanRelated walk that reads and word-compares every
      // content file. The source-file readFileSync stays inside the closure, so a
      // missing source file still throws here and propagates to the outer catch
      // (the 404 is never cached). Mirrors the /api/file/dependencies cache above.
      const result = cached('related:' + filePath, 30000, () => {
        const fullPath = path.join(PROJECT_ROOT, filePath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const sourceTags = new Set();
        if (fmMatch) {
          const tagsMatch = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
          if (tagsMatch) {
            tagsMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => sourceTags.add(t));
          }
        }
        let plainText = content.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
        const sourceWords = new Set(plainText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !RELATED_STOP_WORDS.has(w)));
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const candidates = [];
        function scanRelated(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanRelated(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            if (rel === filePath) continue;
            try {
              const c = fs.readFileSync(fp, 'utf-8');
              const fm = c.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const tags = new Set();
              if (fm) {
                const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
                const tgm = fm[1].match(/^tags:\s*\[([^\]]*)\]/m);
                if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => tags.add(t));
              }
              let score = 0;
              for (const t of tags) { if (sourceTags.has(t)) score += 5; }
              let pt = c.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
              const ws = pt.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !RELATED_STOP_WORDS.has(w));
              let shared = 0;
              for (const w of ws) { if (sourceWords.has(w)) shared++; }
              score += Math.min(shared / Math.max(ws.length, 1) * 10, 5);
              if (score > 0.5) candidates.push({path: rel, title, score: Math.round(score * 100) / 100});
            } catch {}
          }
        }
        scanRelated(contentDir);
        candidates.sort((a, b) => b.score - a.score);
        return {related: candidates.slice(0, 10)};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File keywords: extract top keywords from a file ──
  if (req.method === 'GET' && pathname === '/api/file/keywords') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      text = text.replace(KEYWORDS_FRONTMATTER_RE, '').replace(KEYWORDS_FENCE_RE, '').replace(KEYWORDS_INLINE_CODE_RE, '');
      text = text.replace(KEYWORDS_LINK_RE, '$1').replace(KEYWORDS_HEADING_RE, '');
      text = text.replace(KEYWORDS_PUNCT_RE, ' ').replace(KEYWORDS_HTML_RE, '');
      const freq = {};
      const words = text.toLowerCase().split(KEYWORDS_SPLIT_RE).filter(w => w.length > 2 && !KEYWORDS_STOP_WORDS.has(w));
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
      const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({word, count}));
      return json(res, 200, {keywords, totalWords: words.length});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Word-level diff between current content and a git version ──
  if (req.method === 'GET' && pathname === '/api/file/word-diff') {
    const filePath = url.searchParams.get('path');
    const hash = url.searchParams.get('hash');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    if (!hash || !/^[a-f0-9]{4,40}$/i.test(hash)) return json(res, 400, {error: 'Invalid hash'});
    try {
      const diff = execFileSync('git', [
        'diff', '--word-diff=plain', `${hash}..HEAD`, '--', filePath,
      ], {cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000});
      const added = (diff.match(/\{\+/g) || []).length;
      const removed = (diff.match(/\[-/g) || []).length;
      return json(res, 200, {diff, wordsAdded: added, wordsRemoved: removed});
    } catch {
      return json(res, 200, {diff: '', wordsAdded: 0, wordsRemoved: 0});
    }
  }

  // ── File compare: get content at two commits ──
  if (req.method === 'GET' && pathname === '/api/file/compare') {
    const filePath = url.searchParams.get('path');
    const hash1 = url.searchParams.get('hash1');
    const hash2 = url.searchParams.get('hash2');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    if (!hash1 || !/^[a-f0-9]{4,40}$/i.test(hash1)) return json(res, 400, {error: 'Invalid hash1'});
    if (!hash2 || (hash2 !== 'current' && !/^[a-f0-9]{4,40}$/i.test(hash2))) {
      return json(res, 400, {error: 'Invalid hash2'});
    }
    try {
      const content1 = execFileSync('git', ['show', `${hash1}:${filePath}`], {
        cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
      });
      const date1 = execFileSync('git', ['log', '-1', '--format=%ai', hash1], {
        cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
      }).trim();

      let content2, date2, resolvedHash2;
      if (hash2 === 'current') {
        const fullPath = path.join(PROJECT_ROOT, filePath);
        if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
        content2 = fs.readFileSync(fullPath, 'utf-8');
        date2 = new Date().toISOString();
        resolvedHash2 = 'current';
      } else {
        content2 = execFileSync('git', ['show', `${hash2}:${filePath}`], {
          cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
        });
        date2 = execFileSync('git', ['log', '-1', '--format=%ai', hash2], {
          cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
        }).trim();
        resolvedHash2 = hash2;
      }

      return json(res, 200, {
        version1: {hash: hash1, content: content1, date: date1},
        version2: {hash: resolvedHash2, content: content2, date: date2},
      });
    } catch {
      return json(res, 500, {error: 'Failed to retrieve file versions'});
    }
  }

};

module.exports.numericParam = numericParam;
// Exported for tests: the markdown-stripping regexes shared by the GET
// /api/file/keywords handler, so the suite can assert each one's source and flags
// and prove a single shared instance backs every request.
module.exports.KEYWORDS_FRONTMATTER_RE = KEYWORDS_FRONTMATTER_RE;
module.exports.KEYWORDS_FENCE_RE = KEYWORDS_FENCE_RE;
module.exports.KEYWORDS_INLINE_CODE_RE = KEYWORDS_INLINE_CODE_RE;
module.exports.KEYWORDS_LINK_RE = KEYWORDS_LINK_RE;
module.exports.KEYWORDS_HEADING_RE = KEYWORDS_HEADING_RE;
module.exports.KEYWORDS_PUNCT_RE = KEYWORDS_PUNCT_RE;
module.exports.KEYWORDS_HTML_RE = KEYWORDS_HTML_RE;
module.exports.KEYWORDS_SPLIT_RE = KEYWORDS_SPLIT_RE;
