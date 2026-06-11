'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.
module.exports = async function references_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── References: format all in a given style ──
  if (req.method === 'GET' && pathname === '/api/references/format-all') {
    const style = url.searchParams.get('style') || 'apa';
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const formatted = [];
      for (const [key, entry] of Object.entries(refs)) {
        const authors = entry.author || [];
        const year = entry.year || 'n.d.';
        const title = entry.title || '';
        const venue = entry.venue || '';
        let citation;
        if (style === 'apa') {
          const authorStr = authors.length === 0 ? 'Unknown' :
            authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ') :
            authors.slice(0, -1).map(a => a.split(' ').pop() + ', ' + a.split(' ').slice(0, -1).map(n => n[0] + '.').join(' ')).join(', ') + ', & ' + authors[authors.length - 1].split(' ').pop() + ', ' + authors[authors.length - 1].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ');
          citation = `${authorStr} (${year}). ${title}. ${venue ? venue + '.' : ''}`;
        } else if (style === 'mla') {
          const authorStr = authors.length === 0 ? 'Unknown' :
            authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') :
            authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') + ', et al.';
          citation = `${authorStr}. "${title}." ${venue ? venue + ', ' : ''}${year}.`;
        } else {
          citation = `${(authors.join(', ') || 'Unknown')}. "${title}." ${venue || ''} (${year}).`;
        }
        formatted.push({key, citation});
      }
      formatted.sort((a, b) => a.citation.localeCompare(b.citation));
      return json(res, 200, {style, references: formatted, total: formatted.length});
    } catch {
      return json(res, 500, {error: 'Format failed'});
    }
  }

  // ── References: group by venue ──
  if (req.method === 'GET' && pathname === '/api/references/by-venue') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const byVenue = {};
      for (const [key, entry] of Object.entries(refs)) {
        const venue = entry.venue || 'Unknown';
        if (!byVenue[venue]) byVenue[venue] = [];
        byVenue[venue].push({key, title: entry.title, year: entry.year, authors: entry.author});
      }
      const venues = Object.entries(byVenue)
        .map(([venue, papers]) => ({venue, count: papers.length, papers: papers.sort((a, b) => (b.year || 0) - (a.year || 0))}))
        .sort((a, b) => b.count - a.count);
      return json(res, 200, {venues, totalVenues: venues.length});
    } catch {
      return json(res, 500, {error: 'Failed to group references by venue: references.yaml may be missing or contain invalid YAML syntax'});
    }
  }

  // ── References: group by author ──
  if (req.method === 'GET' && pathname === '/api/references/by-author') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const byAuthor = {};
      for (const [key, entry] of Object.entries(refs)) {
        for (const author of (entry.author || ['Unknown'])) {
          if (!byAuthor[author]) byAuthor[author] = [];
          byAuthor[author].push({key, title: entry.title, year: entry.year, venue: entry.venue});
        }
      }
      const authors = Object.entries(byAuthor)
        .map(([author, papers]) => ({author, count: papers.length, papers: papers.sort((a, b) => (b.year || 0) - (a.year || 0))}))
        .sort((a, b) => b.count - a.count);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      return json(res, 200, {authors: authors.slice(0, limit), totalAuthors: authors.length});
    } catch {
      return json(res, 500, {error: 'Failed to group references by author: references.yaml may be missing or contain invalid YAML syntax'});
    }
  }

  // ── References: year distribution ──
  if (req.method === 'GET' && pathname === '/api/references/year-distribution') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const byYear = {};
      const byVenue = {};
      for (const entry of Object.values(refs)) {
        const year = entry.year || 'unknown';
        byYear[year] = (byYear[year] || 0) + 1;
        if (entry.venue) {
          byVenue[entry.venue] = (byVenue[entry.venue] || 0) + 1;
        }
      }
      const years = Object.entries(byYear)
        .filter(([y]) => y !== 'unknown')
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([year, count]) => ({year: Number(year), count}));
      const topVenues = Object.entries(byVenue)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([venue, count]) => ({venue, count}));
      return json(res, 200, {
        years,
        topVenues,
        totalReferences: Object.keys(refs).length,
        unknownYear: byYear['unknown'] || 0,
      });
    } catch {
      return json(res, 500, {error: 'Year distribution failed'});
    }
  }

  // ── References: similar papers based on shared co-citations and venue ──
  if (req.method === 'GET' && pathname === '/api/references/similar') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const target = refs[key];
      if (!target) return json(res, 404, {error: 'Reference not found'});
      const targetAuthors = new Set((target.author || []).map(a => a.toLowerCase()));
      const targetVenue = (target.venue || '').toLowerCase();
      const targetYear = target.year || 0;
      const candidates = [];
      for (const [k, entry] of Object.entries(refs)) {
        if (k === key) continue;
        let score = 0;
        const entryAuthors = new Set((entry.author || []).map(a => a.toLowerCase()));
        for (const a of targetAuthors) { if (entryAuthors.has(a)) score += 3; }
        if (targetVenue && (entry.venue || '').toLowerCase() === targetVenue) score += 2;
        if (entry.year && Math.abs((entry.year || 0) - targetYear) <= 2) score += 1;
        const targetWords = new Set((target.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const entryWords = (entry.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
        for (const w of entryWords) { if (targetWords.has(w)) score += 0.5; }
        if (score > 1) {
          candidates.push({key: k, title: entry.title, year: entry.year, venue: entry.venue, authors: entry.author, score: Math.round(score * 10) / 10});
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return json(res, 200, {key, similar: candidates.slice(0, 15)});
    } catch {
      return json(res, 500, {error: 'Similar papers search failed'});
    }
  }

  // ── References: format citation in APA/MLA/Chicago style ──
  if (req.method === 'GET' && pathname === '/api/references/format') {
    const key = url.searchParams.get('key');
    const style = url.searchParams.get('style') || 'apa';
    if (!key) return json(res, 400, {error: 'Missing key'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});
      const authors = entry.author || [];
      const year = entry.year || 'n.d.';
      const title = entry.title || '';
      const venue = entry.venue || '';
      let formatted;
      if (style === 'apa') {
        const authorStr = authors.length === 0 ? 'Unknown' :
          authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ') :
          authors.slice(0, -1).map(a => a.split(' ').pop() + ', ' + a.split(' ').slice(0, -1).map(n => n[0] + '.').join(' ')).join(', ') + ', & ' + authors[authors.length - 1].split(' ').pop() + ', ' + authors[authors.length - 1].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ');
        formatted = `${authorStr} (${year}). ${title}. ${venue ? venue + '.' : ''}`;
      } else if (style === 'mla') {
        const authorStr = authors.length === 0 ? 'Unknown' :
          authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') :
          authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') + ', et al.';
        formatted = `${authorStr}. "${title}." ${venue ? venue + ', ' : ''}${year}.`;
      } else {
        const authorStr = authors.join(', ') || 'Unknown';
        formatted = `${authorStr}. "${title}." ${venue || ''} (${year}).`;
      }
      return json(res, 200, {key, style, formatted, entry});
    } catch {
      return json(res, 500, {error: 'Format failed'});
    }
  }

  // ── References: search with filtering ──
  if (req.method === 'GET' && pathname === '/api/references/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
      const results = [];
      for (const [key, entry] of Object.entries(refs)) {
        const searchable = [
          key, entry.title || '', (entry.author || []).join(' '),
          entry.venue || '', String(entry.year || ''),
        ].join(' ').toLowerCase();
        if (searchable.includes(query)) {
          results.push({key, ...entry});
          if (results.length >= limit) break;
        }
      }
      return json(res, 200, {results, total: results.length});
    } catch {
      return json(res, 500, {error: 'Search failed'});
    }
  }

  // ── References: add entry ──
  if (req.method === 'POST' && pathname === '/api/references') {
    if (!rateLimit(`add-ref:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {key, entry} = body;
      if (!key || !entry) return json(res, 400, {error: 'Missing key or entry'});
      if (typeof key !== 'string' || key.length > 200) return json(res, 400, {error: 'Invalid key'});
      if (typeof entry !== 'object') return json(res, 400, {error: 'Invalid entry'});
      // Sanitize string fields within the entry object
      const sanitizedEntry = {};
      for (const [field, value] of Object.entries(entry)) {
        if (typeof value === 'string') sanitizedEntry[field] = sanitizeText(value).slice(0, 5000);
        else if (Array.isArray(value)) sanitizedEntry[field] = value.slice(0, 50).map(v => typeof v === 'string' ? sanitizeText(v).slice(0, 500) : v);
        else sanitizedEntry[field] = value;
      }
      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      if (refs[key]) return json(res, 409, {error: 'Key already exists'});
      refs[key] = sanitizedEntry;
      fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      invalidateCache('stats');
      return json(res, 201, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Draft toggle ──
  if (req.method === 'POST' && pathname === '/api/file/draft') {
    if (!rateLimit(`file-draft:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, draft} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (typeof draft !== 'boolean') return json(res, 400, {error: 'draft must be a boolean'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      let content = fs.readFileSync(fullPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
      if (fmMatch) {
        let fm = fmMatch[1];
        if (/^draft:\s*.*/m.test(fm)) {
          fm = fm.replace(/^draft:\s*.*/m, `draft: ${draft}`);
        } else {
          fm += `\ndraft: ${draft}`;
        }
        content = `---\n${fm}\n---\n` + content.slice(fmMatch[0].length);
      } else {
        content = `---\ndraft: ${draft}\n---\n` + content;
      }
      fs.writeFileSync(fullPath, content, 'utf-8');
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── AI writing assistant (v2 – /api/ai/complete) ──
  if (req.method === 'POST' && pathname === '/api/ai/complete') {
    if (!rateLimit(`ai-complete:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {prompt, context, type} = body;
      if (!prompt || typeof prompt !== 'string') return json(res, 400, {error: 'Missing or invalid prompt'});
      if (prompt.length > 50000) return json(res, 400, {error: 'Prompt must be 50000 characters or fewer'});
      if (context !== undefined && typeof context !== 'string') return json(res, 400, {error: 'context must be a string'});
      if (context && context.length > 50000) return json(res, 400, {error: 'Context must be 50000 characters or fewer'});
      if (type !== undefined && typeof type !== 'string') return json(res, 400, {error: 'type must be a string'});
      if (type && type.length > 50) return json(res, 400, {error: 'Type must be 50 characters or fewer'});
      const validTypes = ['continue', 'improve', 'explain', 'summarize'];
      if (type && !validTypes.includes(type)) {
        return json(res, 400, {error: `Invalid type. Must be one of: ${validTypes.join(', ')}`});
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return json(res, 500, {error: 'ANTHROPIC_API_KEY is not set. Please set it in your environment: export ANTHROPIC_API_KEY=sk-ant-...'});
      }

      const systemPrompts = {
        continue: 'You are a writing assistant. Continue the text naturally, matching the style and tone. Output only the continuation, no preamble.',
        improve: 'You are an editing assistant. Improve the text for clarity, flow, and correctness while preserving the original meaning and tone. Output only the improved text, no preamble.',
        explain: 'You are a teaching assistant. Explain the given text in simple, clear terms. Be concise but thorough.',
        summarize: 'You are a summarization assistant. Provide a concise summary of the given text in 2-3 sentences.',
      };

      let userContent = sanitizeText(prompt);
      if (context) {
        userContent = `Context:\n${sanitizeText(context)}\n\nText:\n${sanitizeText(prompt)}`;
      }

      const messages = [{role: 'user', content: userContent}];
      const requestBody = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages,
      };
      if (type && systemPrompts[type]) {
        requestBody.system = systemPrompts[type];
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let aiResponse;
      try {
        aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const aiData = await aiResponse.json();
      if (!aiResponse.ok) {
        return json(res, 502, {error: 'AI service returned an error. Please try again.'});
      }

      const text = aiData.content?.[0]?.text || 'No response generated';
      return json(res, 200, {text});
    } catch (err) {
      if (err.name === 'AbortError') return json(res, 504, {error: 'AI request timed out. Please try again.'});
      return json(res, 500, {error: 'AI request failed. Please try again later.'});
    }
  }

  // ── Multi-source metadata aggregation ──
  if (req.method === 'GET' && pathname === '/api/metadata/search') {
    const query = url.searchParams.get('q');
    if (!query) return json(res, 400, {error: 'Missing query'});

    const https = require('https');

    function fetchJSON(fetchUrl) {
      return new Promise((resolve) => {
        const req = https.get(fetchUrl, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
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

    try {
      const [s2, crossref] = await Promise.all([
        fetchJSON(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=title,authors,year,venue,externalIds,url`),
        fetchJSON(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=5`),
      ]);

      const results = [];

      if (s2?.data) {
        for (const p of s2.data) {
          results.push({
            source: 'semanticscholar',
            title: p.title,
            authors: (p.authors || []).map(a => a.name),
            year: p.year,
            venue: p.venue,
            doi: p.externalIds?.DOI,
            arxivId: p.externalIds?.ArXiv,
            url: p.url,
          });
        }
      }

      if (crossref?.message?.items) {
        for (const item of crossref.message.items) {
          results.push({
            source: 'crossref',
            title: item.title?.[0],
            authors: (item.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()),
            year: item.published?.['date-parts']?.[0]?.[0],
            venue: item['container-title']?.[0],
            doi: item.DOI,
            url: item.URL,
          });
        }
      }

      return json(res, 200, {results});
    } catch {
      return json(res, 500, {error: 'Metadata search failed'});
    }
  }

  // ── References: enrich (GET - fetch metadata from multiple sources) ──
  if (req.method === 'GET' && pathname === '/api/references/enrich') {
    const citationKey = url.searchParams.get('key');
    if (!citationKey) return json(res, 400, {error: 'Missing key param'});

    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
      const entry = refs[citationKey];
      if (!entry) return json(res, 404, {error: `Reference "${citationKey}" not found`});

      const title = entry.title;
      if (!title) return json(res, 400, {error: 'Reference has no title to search for'});

      function curlJSON(curlUrl) {
        try {
          const out = execFileSync('curl', [
            '-sSL', '--max-time', '15',
            '-A', 'MochiLab/1.0 (bibliography enrichment)',
            curlUrl,
          ], {encoding: 'utf-8', timeout: 20000});
          return JSON.parse(out);
        } catch {
          return null;
        }
      }

      const encodedTitle = encodeURIComponent(title);

      const s2Data = curlJSON(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedTitle}&limit=1&fields=title,authors,year,venue,externalIds,citationCount,referenceCount,tldr`);
      const crossrefData = curlJSON(`https://api.crossref.org/works?query=${encodedTitle}&rows=1`);
      const dblpData = curlJSON(`https://dblp.org/search/publ/api?q=${encodedTitle}&format=json&h=1`);

      // Parse Semantic Scholar result
      const s2Result = {};
      if (s2Data?.data?.[0]) {
        const p = s2Data.data[0];
        s2Result.title = p.title;
        s2Result.authors = (p.authors || []).map(a => a.name);
        s2Result.year = p.year;
        s2Result.venue = p.venue;
        s2Result.doi = p.externalIds?.DOI || null;
        s2Result.arxivId = p.externalIds?.ArXiv || null;
        s2Result.citationCount = p.citationCount;
        s2Result.referenceCount = p.referenceCount;
        s2Result.tldr = p.tldr?.text || null;
      }

      // Parse CrossRef result
      const crossrefResult = {};
      if (crossrefData?.message?.items?.[0]) {
        const item = crossrefData.message.items[0];
        crossrefResult.title = item.title?.[0];
        crossrefResult.authors = (item.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim());
        crossrefResult.year = item.published?.['date-parts']?.[0]?.[0];
        crossrefResult.venue = item['container-title']?.[0];
        crossrefResult.doi = item.DOI;
        crossrefResult.url = item.URL;
        crossrefResult.publisher = item.publisher;
        crossrefResult.type = item.type;
        crossrefResult.volume = item.volume;
        crossrefResult.issue = item.issue;
        crossrefResult.pages = item.page;
        crossrefResult.issn = item.ISSN?.[0];
      }

      // Parse DBLP result
      const dblpResult = {};
      if (dblpData?.result?.hits?.hit?.[0]?.info) {
        const info = dblpData.result.hits.hit[0].info;
        dblpResult.title = info.title;
        dblpResult.authors = Array.isArray(info.authors?.author)
          ? info.authors.author.map(a => typeof a === 'string' ? a : a.text)
          : info.authors?.author ? [typeof info.authors.author === 'string' ? info.authors.author : info.authors.author.text] : [];
        dblpResult.year = info.year ? parseInt(info.year, 10) : null;
        dblpResult.venue = info.venue;
        dblpResult.doi = info.doi;
        dblpResult.url = info.ee;
        dblpResult.type = info.type;
        dblpResult.pages = info.pages;
        dblpResult.volume = info.volume;
      }

      const {mergeMetadataSources} = require('../server-utils');
      const sources = {
        semanticScholar: Object.keys(s2Result).length > 0 ? s2Result : null,
        crossref: Object.keys(crossrefResult).length > 0 ? crossrefResult : null,
        dblp: Object.keys(dblpResult).length > 0 ? dblpResult : null,
      };

      return json(res, 200, {
        key: citationKey,
        current: entry,
        sources,
        merged: mergeMetadataSources(sources),
      });
    } catch (err) {
      return json(res, 500, {error: 'Enrichment failed. Please try again later.'});
    }
  }

  // ── References: enrich (POST - apply enriched data to references.yaml) ──
  if (req.method === 'POST' && pathname === '/api/references/enrich') {
    if (!rateLimit(`enrich-ref:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {key: citationKey, fields} = body;
      if (!citationKey || typeof citationKey !== 'string') return json(res, 400, {error: 'Missing or invalid key'});
      if (citationKey.length > 200) return json(res, 400, {error: 'Key too long'});
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return json(res, 400, {error: 'Missing fields object'});

      const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      if (!refs[citationKey]) return json(res, 404, {error: `Reference "${citationKey}" not found`});

      // Merge the selected fields into the existing reference
      const allowedFields = ['title', 'author', 'year', 'venue', 'doi', 'arxivId', 'url', 'volume', 'issue', 'pages', 'publisher', 'type', 'citationCount', 'referenceCount', 'tldr'];
      for (const [field, value] of Object.entries(fields)) {
        if (allowedFields.includes(field) && value != null) {
          if (typeof value === 'string') refs[citationKey][field] = sanitizeText(value).slice(0, 5000);
          else if (Array.isArray(value)) refs[citationKey][field] = value.slice(0, 50).map(v => typeof v === 'string' ? sanitizeText(v).slice(0, 500) : v);
          else refs[citationKey][field] = value;
        }
      }

      fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      return json(res, 200, {success: true, entry: refs[citationKey]});
    } catch (err) {
      return json(res, 400, {error: 'Invalid request: ' + err.message});
    }
  }

};
