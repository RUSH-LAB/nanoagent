'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.
module.exports = async function research_tools_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Preprint tracking: check single reference ──
  if (req.method === 'GET' && pathname === '/api/references/track') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key param'});
    try {
      const yaml = require('js-yaml');
      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});

      // Extract arXiv ID from URL or explicit field
      const arxivId = entry.arxivId || (entry.url && entry.url.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1]) || null;
      if (!arxivId) return json(res, 200, {published: false, error: 'No arXiv ID found for this reference'});

      const https = require('https');
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await new Promise((resolve) => {
        const req = https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
          if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch { resolve(null); }
          });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
      });

      if (!data) return json(res, 502, {error: 'Failed to reach Semantic Scholar API'});

      const venue = data.venue || '';
      const isArxiv = !venue || venue === 'ArXiv' || venue === 'arXiv';
      const published = !isArxiv;
      const result = {
        published,
        venue: published ? venue : null,
        doi: data.externalIds?.DOI || null,
        journal: data.journal || null,
        year: data.year || null,
        currentVenue: entry.venue || null,
        tracked: entry.tracked || false,
        publishedVenue: entry.publishedVenue || null,
      };
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, {error: 'Track check failed. Please try again later.'});
    }
  }

  // ── Preprint tracking: update single reference ──
  if (req.method === 'POST' && pathname === '/api/references/track') {
    if (!rateLimit(`track-ref:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {key} = body;
      if (!key || typeof key !== 'string') return json(res, 400, {error: 'Missing or invalid key'});

      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});

      const arxivId = entry.arxivId || (entry.url && entry.url.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1]) || null;
      if (!arxivId) return json(res, 400, {error: 'No arXiv ID found for this reference'});

      const https = require('https');
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await new Promise((resolve) => {
        const req = https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
          if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch { resolve(null); }
          });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
      });

      if (!data) return json(res, 502, {error: 'Failed to reach Semantic Scholar API'});

      const venue = data.venue || '';
      const isArxiv = !venue || venue === 'ArXiv' || venue === 'arXiv';

      entry.tracked = true;
      if (!isArxiv) {
        entry.publishedVenue = venue;
        if (data.externalIds?.DOI && !entry.doi) {
          entry.doi = data.externalIds.DOI;
        }
        if (data.journal) {
          entry.journal = data.journal;
        }
      }

      fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      return json(res, 200, {
        success: true,
        published: !isArxiv,
        venue: !isArxiv ? venue : null,
        tracked: true,
        publishedVenue: entry.publishedVenue || null,
      });
    } catch (err) {
      return json(res, 500, {error: 'Track update failed. Please try again later.'});
    }
  }

  // ── Preprint tracking: batch check all ──
  if (req.method === 'POST' && pathname === '/api/references/track-all') {
    if (!rateLimit(`track-all:${req.socket.remoteAddress}`, 2)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const https = require('https');
      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      function fetchS2(arxivId) {
        return new Promise((resolve) => {
          const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
          const req = https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
            if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.on('error', () => resolve(null));
        });
      }

      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      // Find all entries with arXiv IDs that don't have publishedVenue yet
      const toCheck = [];
      for (const [key, entry] of Object.entries(refs)) {
        const arxivId = entry.arxivId || (entry.url && entry.url.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1]) || null;
        if (arxivId && !entry.publishedVenue) {
          toCheck.push({key, entry, arxivId});
        }
      }

      const results = [];
      let updatedCount = 0;

      for (let i = 0; i < toCheck.length; i++) {
        const {key, entry, arxivId} = toCheck[i];
        const data = await fetchS2(arxivId);

        if (data) {
          const venue = data.venue || '';
          const isArxiv = !venue || venue === 'ArXiv' || venue === 'arXiv';
          const published = !isArxiv;

          entry.tracked = true;
          if (published) {
            entry.publishedVenue = venue;
            if (data.externalIds?.DOI && !entry.doi) {
              entry.doi = data.externalIds.DOI;
            }
            if (data.journal) {
              entry.journal = data.journal;
            }
            updatedCount++;
          }

          results.push({key, published, venue: published ? venue : null});
        } else {
          results.push({key, published: false, venue: null, error: 'API request failed'});
        }

        // Rate limiting: 1 request per second
        if (i < toCheck.length - 1) {
          await sleep(1000);
        }
      }

      // Save updated references
      if (updatedCount > 0) {
        fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      }

      return json(res, 200, {checked: toCheck.length, updated: updatedCount, results});
    } catch (err) {
      return json(res, 500, {error: 'Batch track failed. Please try again later.'});
    }
  }

  // ── Recommendations: get paper recommendations based on bibliography ──
  if (req.method === 'GET' && pathname === '/api/recommendations') {
    if (!rateLimit(`recommendations:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const https = require('https');
      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      function extractRecPaperId(entry) {
        if (entry.paperId) return entry.paperId;
        if (entry.url) {
          const arxivMatch = entry.url.match(/arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/);
          if (arxivMatch) return `ArXiv:${arxivMatch[1]}`;
          const doiMatch = entry.url.match(/doi\.org\/(10\.\d{4,}\/[^\s]+)/);
          if (doiMatch) return doiMatch[1];
        }
        if (entry.arxivId) return `ArXiv:${entry.arxivId}`;
        if (entry.doi) return entry.doi;
        return null;
      }

      const papersWithIds = [];
      for (const [key, entry] of Object.entries(refs)) {
        const paperId = extractRecPaperId(entry);
        if (paperId) papersWithIds.push({ key, entry, paperId });
      }

      if (papersWithIds.length === 0) {
        return json(res, 200, { recommendations: [] });
      }

      const recTopVenues = new Set([
        'NeurIPS', 'ICML', 'ICLR', 'CVPR', 'ICCV', 'ECCV', 'ACL', 'EMNLP',
        'NAACL', 'AAAI', 'IJCAI', 'Nature', 'Science', 'JMLR',
      ]);
      papersWithIds.sort((a, b) => {
        const aScore = (recTopVenues.has(a.entry.venue) ? 10 : 0) + ((a.entry.year || 2000) - 2000);
        const bScore = (recTopVenues.has(b.entry.venue) ? 10 : 0) + ((b.entry.year || 2000) - 2000);
        return bScore - aScore;
      });
      const seeds = papersWithIds.slice(0, 5);

      function fetchS2Recs(fetchUrl) {
        return new Promise((resolve) => {
          const req = https.get(fetchUrl, { headers: { 'User-Agent': 'MochiLab/1.0' }, timeout: 10000 }, (r) => {
            if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.on('error', () => resolve(null));
        });
      }

      const existingTitles = new Set(
        Object.values(refs).map(r => (r.title || '').toLowerCase().trim())
      );
      const recMap = new Map();

      for (const seed of seeds) {
        const s2Url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(seed.paperId)}/references?fields=title,authors,year,venue,externalIds&limit=5`;
        const data = await fetchS2Recs(s2Url);
        if (!data || !data.data) continue;

        for (const ref of data.data) {
          const cited = ref.citedPaper;
          if (!cited || !cited.title) continue;
          const titleLower = cited.title.toLowerCase().trim();
          if (existingTitles.has(titleLower)) continue;

          if (recMap.has(titleLower)) {
            const existing = recMap.get(titleLower);
            existing.score += 1;
            if (!existing.recommendedBy.includes(seed.entry.title)) {
              existing.recommendedBy.push(seed.entry.title);
            }
          } else {
            recMap.set(titleLower, {
              title: cited.title,
              authors: (cited.authors || []).map(a => a.name || a),
              year: cited.year,
              venue: cited.venue || '',
              arxivId: cited.externalIds?.ArXiv || null,
              score: 1,
              recommendedBy: [seed.entry.title],
            });
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }

      const recommendations = [...recMap.values()]
        .sort((a, b) => b.score - a.score || (b.year || 0) - (a.year || 0))
        .slice(0, 20);

      return json(res, 200, { recommendations });
    } catch (err) {
      return json(res, 500, { error: 'Failed to fetch recommendations. Please try again later.' });
    }
  }

  // ── Recommendations: add a recommended paper to bibliography ──
  if (req.method === 'POST' && pathname === '/api/recommendations/add') {
    if (!rateLimit(`add-rec:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const { title, authors, year, venue, url: paperUrl, arxivId } = body;
      if (!title || typeof title !== 'string') return json(res, 400, { error: 'Missing or invalid title' });
      if (title.length > 500) return json(res, 400, { error: 'Title must be 500 characters or fewer' });
      if (authors !== undefined && !Array.isArray(authors)) return json(res, 400, { error: 'authors must be an array' });
      if (Array.isArray(authors) && authors.length > 50) return json(res, 400, { error: 'authors exceeds maximum length of 50' });
      if (year !== undefined && typeof year !== 'number' && typeof year !== 'string') return json(res, 400, { error: 'year must be a number or string' });
      if (venue !== undefined && typeof venue !== 'string') return json(res, 400, { error: 'venue must be a string' });
      if (venue && venue.length > 500) return json(res, 400, { error: 'Venue must be 500 characters or fewer' });
      if (paperUrl !== undefined && typeof paperUrl !== 'string') return json(res, 400, { error: 'url must be a string' });
      if (paperUrl && paperUrl.length > 2000) return json(res, 400, { error: 'URL must be 2000 characters or fewer' });
      if (arxivId !== undefined && typeof arxivId !== 'string') return json(res, 400, { error: 'arxivId must be a string' });
      if (arxivId && arxivId.length > 200) return json(res, 400, { error: 'arxivId must be 200 characters or fewer' });

      const authorList = authors || [];
      const firstAuthor = authorList[0] || 'unknown';
      const lastName = firstAuthor.split(' ').pop().toLowerCase().replace(/[^a-z]/g, '');
      const yearStr = year || 'unknown';
      const baseKey = `${lastName}${yearStr}`;

      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      let finalKey = baseKey;
      let suffix = 1;
      while (refs[finalKey]) {
        const titleSlug = (title || '').split(/\s+/).slice(0, 1).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
        finalKey = `${baseKey}${titleSlug || suffix}`;
        suffix++;
        if (refs[finalKey]) finalKey = `${baseKey}${suffix}`;
      }

      const entry = {
        type: 'article',
        title: sanitizeText(title),
        author: authorList.slice(0, 50).map(a => sanitizeText(String(a))),
        year: year || null,
        venue: venue ? sanitizeText(venue) : '',
      };
      if (paperUrl) entry.url = sanitizeText(paperUrl);
      else if (arxivId) entry.url = `https://arxiv.org/abs/${sanitizeText(arxivId)}`;
      if (arxivId) entry.arxivId = sanitizeText(arxivId);

      refs[finalKey] = entry;
      fs.writeFileSync(bibPath, yaml.dump(refs, { lineWidth: -1 }), 'utf-8');

      return json(res, 201, { key: finalKey, success: true });
    } catch (err) {
      return json(res, 400, { error: 'Invalid request: ' + err.message });
    }
  }

  // ── References: import BibTeX ──
  if (req.method === 'POST' && pathname === '/api/references/import-bibtex') {
    if (!rateLimit(`import-bibtex:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {bibtex} = body;
      if (!bibtex || typeof bibtex !== 'string') return json(res, 400, {error: 'Missing bibtex string'});
      if (bibtex.length > 500000) return json(res, 400, {error: 'BibTeX input too large (max 500KB)'});

      const parsed = parseBibtex(bibtex);
      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      let refs;
      try {
        refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      } catch {
        refs = {};
      }

      let added = 0;
      let skipped = 0;
      const errors = [];

      for (const {entryType, citationKey, fields} of parsed) {
        try {
          if (refs[citationKey]) {
            skipped++;
            continue;
          }

          const entry = {
            type: mapBibtexEntryType(entryType),
            title: sanitizeText(fields.title || ''),
            author: parseBibtexAuthors(fields.author),
            year: fields.year ? parseInt(fields.year, 10) || null : null,
          };

          // Venue: journal for articles, booktitle for proceedings
          const venue = fields.journal || fields.booktitle || '';
          if (venue) entry.venue = sanitizeText(venue);

          if (fields.url) entry.url = fields.url;
          if (fields.doi) entry.doi = fields.doi;
          if (fields.pages) entry.pages = fields.pages;
          if (fields.volume) entry.volume = fields.volume;

          refs[citationKey] = entry;
          added++;
        } catch (err) {
          errors.push({key: citationKey, error: err.message});
        }
      }

      if (added > 0) {
        fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
        invalidateCache('stats');
      }

      return json(res, 200, {added, skipped, errors});
    } catch (err) {
      return json(res, 400, {error: 'BibTeX import failed: ' + err.message});
    }
  }

  // ── Templates: list available templates ──
  if (req.method === 'GET' && pathname === '/api/templates') {
    const templateDir = path.join(PROJECT_ROOT, 'template');
    try {
      const templates = [
        {id: 'blank', name: 'Blank Page', content: '---\ntitle: "Untitled"\ndate: {{date}}\n---\n\n# Untitled\n\n'},
        {id: 'blog', name: 'Blog Post', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zy]\ntags: []\n---\n\n# {{title}}\n\n## Introduction\n\n## Main Content\n\n## Conclusion\n'},
        {id: 'research', name: 'Research Paper Summary', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zy]\ntags: [research]\n---\n\n# {{title}}\n\n## Summary\n\n## Key Contributions\n\n## Method\n\n## Results\n\n## Discussion\n\n## References\n'},
        {id: 'math', name: 'Math Chapter', content: '---\ntitle: "{{title}}"\n---\n\nimport {Theorem, Definition, Proof, Remark} from \'@site/src/components/Math\';\n\n# {{title}}\n\n<Definition id="def-1" name="Definition Name">\nDefinition content.\n</Definition>\n\n<Theorem id="thm-1" name="Theorem Name">\nTheorem statement.\n</Theorem>\n\n<Proof>\nProof content.\n</Proof>\n'},
        {id: 'tutorial', name: 'Tutorial', content: '---\ntitle: "{{title}}"\nsidebar_position: 1\n---\n\n# {{title}}\n\n## Prerequisites\n\n## Step 1\n\n## Step 2\n\n## Step 3\n\n## Summary\n'},
      ];
      const body = JSON.stringify({templates});
      const etag = '"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 16) + '"';
      const hdrs = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-API-Version': '1.0',
        'X-Powered-By': 'Mochi Lab',
        'ETag': etag,
        'Cache-Control': 'public, max-age=3600',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, hdrs);
        return res.end();
      }
      res.writeHead(200, hdrs);
      return res.end(body);
    } catch {
      return json(res, 500, {error: 'Failed to load templates'});
    }
  }

  // ── Full-text search across all content files ──
  if (req.method === 'GET' && pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      const searchIndex = cached('search:index', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const index = [];
        function indexDir(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              indexDir(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lower = content.toLowerCase();
                const words = new Set(lower.split(/[^a-z0-9À-ɏ一-鿿]+/).filter(w => w.length > 0));
                const firstLines = content.slice(0, 500);
                index.push({
                  path: path.relative(PROJECT_ROOT, fullPath),
                  name: entry.name,
                  words,
                  firstLines,
                  _content: content,
                  _lower: lower,
                });
              } catch {}
            }
          }
        }
        indexDir(contentDir);
        return index;
      });
      const queryWords = query.split(/\s+/).filter(w => w.length > 0);
      const results = [];
      for (const file of searchIndex) {
        // Fast path: check if all query words exist in the word set
        const allWordsMatch = queryWords.every(qw => {
          for (const w of file.words) {
            if (w.includes(qw)) return true;
          }
          return false;
        });
        if (!allWordsMatch) continue;
        // Confirmed match — find snippet position from the full text
        const idx = file._lower.indexOf(query);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(file._content.length, idx + query.length + 50);
          const snippet = file._content.slice(start, end).replace(/\n/g, ' ');
          results.push({
            path: file.path,
            name: file.name,
            snippet: (start > 0 ? '...' : '') + snippet + (end < file._content.length ? '...' : ''),
          });
        } else {
          // Words matched individually but not as exact phrase — show first lines as snippet
          const snippet = file.firstLines.replace(/\n/g, ' ').slice(0, 100);
          results.push({
            path: file.path,
            name: file.name,
            snippet: snippet + (file.firstLines.length > 100 ? '...' : ''),
          });
        }
        if (results.length >= 50) break;
      }
      return json(res, 200, {results});
    } catch {
      return json(res, 500, {error: 'Search failed'});
    }
  }

  // ── Multi-file search and replace ──
  if (req.method === 'POST' && pathname === '/api/search/replace') {
    if (!rateLimit(`search-replace:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {search, replace, dryRun} = body;
      if (!search || typeof search !== 'string') return json(res, 400, {error: 'Missing search string'});
      if (search.length > MAX_TEXT_LENGTH) return json(res, 400, {error: 'Search string too long'});
      if (typeof replace !== 'string') return json(res, 400, {error: 'Missing replace string'});
      if (replace.length > MAX_TEXT_LENGTH) return json(res, 400, {error: 'Replace string too long'});
      if (dryRun !== undefined && typeof dryRun !== 'boolean') return json(res, 400, {error: 'dryRun must be a boolean'});
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const changes = [];
      function scanReplace(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanReplace(fullPath); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const occurrences = content.split(search).length - 1;
            if (occurrences > 0) {
              const relPath = path.relative(PROJECT_ROOT, fullPath);
              if (!dryRun) {
                const newContent = content.split(search).join(replace);
                fs.writeFileSync(fullPath, newContent, 'utf-8');
              }
              changes.push({path: relPath, occurrences});
            }
          } catch {}
        }
      }
      scanReplace(contentDir);
      invalidateCache('search');
      const totalOccurrences = changes.reduce((s, c) => s + c.occurrences, 0);
      return json(res, 200, {
        dryRun: !!dryRun,
        filesChanged: changes.length,
        totalOccurrences,
        changes,
      });
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Export all references as BibTeX ──
  if (req.method === 'GET' && pathname === '/api/references/export') {
    try {
      const yaml = require('js-yaml');
      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      const bibliography = require('../../plugins/docusaurus-plugin-bibliography');
      const lines = [];
      for (const [key, entry] of Object.entries(refs)) {
        const authors = (entry.author || []).join(' and ');
        const type = entry.type || 'misc';
        let bibtexType = type;
        if (type === 'article') bibtexType = 'article';
        else if (type === 'inproceedings') bibtexType = 'inproceedings';
        else if (type === 'book') bibtexType = 'book';
        const fields = [];
        fields.push(`  title = {${entry.title || ''}}`);
        if (authors) fields.push(`  author = {${authors}}`);
        if (entry.year) fields.push(`  year = {${entry.year}}`);
        if (entry.venue) {
          if (bibtexType === 'inproceedings') fields.push(`  booktitle = {${entry.venue}}`);
          else if (bibtexType === 'article') fields.push(`  journal = {${entry.venue}}`);
          else fields.push(`  howpublished = {${entry.venue}}`);
        }
        if (entry.url) fields.push(`  url = {${entry.url}}`);
        if (entry.doi) fields.push(`  doi = {${entry.doi}}`);
        if (entry.volume) fields.push(`  volume = {${entry.volume}}`);
        if (entry.pages) fields.push(`  pages = {${entry.pages}}`);
        lines.push(`@${bibtexType}{${key},\n${fields.join(',\n')}\n}`);
      }
      const bibtex = lines.join('\n\n') + '\n';
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="references.bib"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      return res.end(bibtex);
    } catch (err) {
      return json(res, 500, {error: 'Export failed: ' + err.message});
    }
  }

  // ── Notification counts ──
  if (req.method === 'GET' && pathname === '/api/notifications/counts') {
    const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';

    // Count comments created after `since` across all pages
    const comments = loadJSON(COMMENTS_FILE);
    let commentCount = 0;
    for (const page of Object.keys(comments)) {
      const pageComments = comments[page];
      if (Array.isArray(pageComments)) {
        for (const c of pageComments) {
          if (c.createdAt && c.createdAt > since) commentCount++;
        }
      }
    }

    // Count discussion messages created after `since` across all channels
    const discData = loadJSON(DISCUSSIONS_FILE);
    let discussionCount = 0;
    const messages = discData.messages || {};
    for (const channelId of Object.keys(messages)) {
      const channelMessages = messages[channelId];
      if (Array.isArray(channelMessages)) {
        for (const m of channelMessages) {
          if (m.createdAt && m.createdAt > since) discussionCount++;
        }
      }
    }

    return json(res, 200, {comments: commentCount, discussions: discussionCount});
  }

};
