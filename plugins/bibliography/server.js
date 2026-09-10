'use strict';
/**
 * The bibliography's API, owned by the bibliography.
 *
 * Loaded by the server's plugin loader rather than listed in server/index.js:
 * see src/server/plugins.js. The shape matches a core route module's, and the
 * last argument does not: this gets the narrow API in src/server/plugin-api.js,
 * built from the capabilities plugin.json asks for. Nothing here can read a
 * file outside content/, run a process, or see the server's internals.
 *
 * `provides` is the other half of the contract. Core handlers consume the
 * bibliography through this boundary without reaching into plugin files.
 */
const {numericParam} = require('#plugin-api');
const crypto = require('crypto');
const {buildCitation, cleanBibtexValue} = require('./lib/references');
const {parseBibtex, parseBibtexAuthors, mapBibtexEntryType, mergeMetadataSources} = require('./lib/bibtex');
const {
  normalizePaper,
  paperForStorage,
  validatePaper,
  citationKeyFor,
  paperToBibtex,
} = require('./lib/protocol');

// Single frozen fallback for author-less entries in GET /api/references/by-author.
// The array is only iterated (never mutated or retained), so one shared instance
// keeps the byAuthor grouping — including the synthesized 'Unknown' group and its
// sort position — identical while avoiding a fresh allocation per author-less entry.
const UNKNOWN_AUTHORS = Object.freeze(['Unknown']);

/**
 * Ask a public catalogue for JSON, and treat every way it can let us down as
 * "no answer": down, slow, non-200, or answering something that is not JSON.
 * Four handlers enrich from Semantic Scholar, Crossref and DBLP, and none of
 * them should fail because one of the three is having a bad afternoon.
 */
async function askCatalogue(fetchExternal, target) {
  try {
    const reply = await fetchExternal(target, {headers: {'User-Agent': 'MochiLab/1.0'}});
    return reply.ok ? await reply.json() : null;
  } catch {
    return null;
  }
}

function sanitizePaperInput(entry, sanitize) {
  const clean = {};
  const strings = ['schema', 'type', 'title', 'venue', 'doi', 'arxivId', 'officialUrl', 'pdfUrl', 'volume', 'issue', 'pages', 'publisher'];
  for (const field of strings) {
    if (typeof entry[field] === 'string') clean[field] = sanitize(entry[field]).slice(0, 5000);
    else if (entry[field] != null) clean[field] = entry[field];
  }
  if (entry.year != null) clean.year = entry.year;
  const authors = entry.authors ?? entry.author;
  clean.authors = Array.isArray(authors)
    ? authors.slice(0, 50).map(value => sanitize(String(value)).slice(0, 500))
    : authors;
  clean.tags = Array.isArray(entry.tags)
    ? entry.tags.slice(0, 50).map(value => sanitize(String(value)).slice(0, 80))
    : [];
  if (entry.source && typeof entry.source === 'object' && !Array.isArray(entry.source)) {
    clean.source = {};
    for (const field of ['type', 'id', 'url', 'provider']) {
      if (typeof entry.source[field] === 'string') clean.source[field] = sanitize(entry.source[field]).slice(0, 2000);
    }
  }
  return clean;
}

// Multi-citation regex for the GET /api/references/reading-order topological
// scan, compiled once at module load instead of rebuilt on every request. Like
// GRAPH_WIKI_RE this shared /g regex is module state, so the handler resets
// `lastIndex` before each file's exec loop, which keeps the reading order
// identical across back-to-back requests. It captures a whole citation group
// such as `[@a; @b]` (the repeated trailing alternative absorbs each extra
// `; @key`), and is named distinctly from the simpler single-key CITE_RE locals
// in /api/content-xref-matrix, /api/content-coverage, and
// /api/references/trending.
const READING_ORDER_CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;

// The arXiv id inside a reference's `url`, for the three tracking endpoints that
// ask Semantic Scholar whether a preprint has since been published. Capture
// group 1 is the id. Non-global and only ever used with String.prototype.match,
// so it carries no lastIndex state and one shared instance is safe across
// handlers. Core has its own copy in routes/research-tools.js for the same job
// on a different input; a plugin owns its patterns rather than borrowing them.
const ARXIV_ABS_RE = /arxiv\.org\/abs\/([\d.]+)/;
function openPaperRecords(collection, scope) {
  const source = collection('plugin:bibliography:papers');
  return Object.freeze({
    entries: () => source.entries(scope),
    get: key => source.get(scope, key),
    has: key => source.has(scope, key),
    put: (key, value) => source.put(scope, key, value),
    remove: key => source.remove(scope, key),
  });
}

module.exports = async function bibliography_routes(req, res, url, pathname, api) {
  const {
    respond, stream, readBody, readBytes, rateLimit, cache,
    // Granted by "network": the enrichment and metadata endpoints ask three
    // public catalogues about a paper. This used to be require('https') and a
    // shelled-out curl.
    fetch: fetchExternal,
    sanitize,
    records,
    blobs,
    content,
    caller,
  } = api;

  const paperRecords = records.collection('papers');
  const annotationRecords = records.collection('annotations');
  const fileRecords = records.collection('files');
  const canManagePapers = ['owner', 'editor'].includes(caller.role);
  const canDeletePapers = caller.role === 'owner';

  async function readPapers() {
    return paperRecords.entries();
  }

  // ── References: add entry ──
  if (req.method === 'POST' && pathname === '/api/references') {
    if (!canManagePapers) return respond(res, 403, {error: 'You do not have permission to add papers'});
    if (!rateLimit(`add-ref:${req.socket.remoteAddress}`, 20)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody();
      const {key: requestedKey, entry} = body || {};
      if (!entry) return respond(res, 400, {error: 'Missing entry'});
      if (requestedKey != null && (typeof requestedKey !== 'string' || requestedKey.length > 200)) return respond(res, 400, {error: 'Invalid key'});
      if (typeof entry !== 'object') return respond(res, 400, {error: 'Invalid entry'});
      const sanitizedEntry = sanitizePaperInput(entry, sanitize);
      const {paper, errors} = validatePaper(sanitizedEntry);
      if (errors.length) return respond(res, 400, {error: errors.join('; ')});
      const refs = await readPapers();
      const key = requestedKey || citationKeyFor(paper, Object.keys(refs));
      if (!/^[\w.-]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        return respond(res, 400, {error: 'Invalid key'});
      }
      if (Object.prototype.hasOwnProperty.call(refs, key)) return respond(res, 409, {error: 'Key already exists'});
      const stored = paperForStorage(paper);
      await paperRecords.put(key, stored);
      return respond(res, 201, {success: true, key, entry: normalizePaper(key, stored)});
    } catch {
      return respond(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Multi-source metadata aggregation ──
  if (req.method === 'GET' && pathname === '/api/metadata/search') {
    const query = url.searchParams.get('q');
    if (!query) return respond(res, 400, {error: 'Missing query'});

    const fetchJSON = target => askCatalogue(fetchExternal, target);

    // Normalize one DBLP publ-search hit into the per-source record shape used
    // by the merge. DBLP returns `authors.author` as a single object/string for
    // a one-author paper and an array otherwise; each author is either a plain
    // string or an object carrying the name under `text`.
    function parseDblpHit(hit) {
      const info = hit?.info;
      if (!info) return null;
      const authorField = info.authors?.author;
      const authorArr = Array.isArray(authorField) ? authorField : authorField ? [authorField] : [];
      const authors = authorArr
        .map(a => (typeof a === 'string' ? a : a?.text))
        .filter(a => typeof a === 'string' && a.trim());
      return {
        source: 'dblp',
        title: info.title,
        authors,
        year: info.year ? parseInt(info.year, 10) : null,
        venue: info.venue,
        doi: info.doi,
        url: info.ee,
        type: info.type,
        pages: info.pages,
        volume: info.volume,
      };
    }

    try {
      const [s2, crossref, dblp] = await Promise.all([
        fetchJSON(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=title,authors,year,venue,externalIds,url`),
        fetchJSON(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=5`),
        fetchJSON(`https://dblp.org/search/publ/api?q=${encodeURIComponent(query)}&format=json&h=5`),
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

      const dblpHits = Array.isArray(dblp?.result?.hits?.hit) ? dblp.result.hits.hit : [];
      for (const hit of dblpHits) {
        const rec = parseDblpHit(hit);
        if (rec) results.push(rec);
      }

      // Build one merged best-value record from the top hit of each source,
      // reusing the shared mergeMetadataSources helper (which deduplicates
      // authors across name formats and guards against prototype-polluting
      // keys). Strip the `source` discriminator so it never leaks into the
      // merge input.
      const topRecord = (sourceName) => {
        const hit = results.find(r => r.source === sourceName);
        if (!hit) return null;
        const {source, ...record} = hit;
        return record;
      };
      const merged = mergeMetadataSources({
        semanticScholar: topRecord('semanticscholar'),
        crossref: topRecord('crossref'),
        dblp: topRecord('dblp'),
      });

      const sourceHit = results.find(result => result.source === 'crossref' && result.doi)
        || results.find(result => result.doi)
        || results.find(result => result.arxivId)
        || results[0]
        || {};
      const paper = normalizePaper(null, {
        ...merged,
        type: merged.type || 'article',
        author: merged.authors,
        source: {
          type: merged.doi ? 'doi' : merged.arxivId ? 'arxiv' : sourceHit.url ? 'url' : 'manual',
          id: merged.doi || merged.arxivId || sourceHit.url || null,
          url: merged.doi ? `https://doi.org/${merged.doi}` : merged.arxivId ? `https://arxiv.org/abs/${merged.arxivId}` : sourceHit.url,
          provider: sourceHit.source || null,
        },
        officialUrl: merged.doi ? `https://doi.org/${merged.doi}` : merged.arxivId ? `https://arxiv.org/abs/${merged.arxivId}` : sourceHit.url,
      });

      return respond(res, 200, {results, merged, paper});
    } catch {
      return respond(res, 500, {error: 'Metadata search failed'});
    }
  }

  // ── References: enrich (GET - fetch metadata from multiple sources) ──
  if (req.method === 'GET' && pathname === '/api/references/enrich') {
    const citationKey = url.searchParams.get('key');
    if (!citationKey) return respond(res, 400, {error: 'Missing key param'});

    try {
      const refs = await readPapers();
      const entry = refs[citationKey];
      if (!entry) return respond(res, 404, {error: `Reference "${citationKey}" not found`});

      const title = entry.title;
      if (!title) return respond(res, 400, {error: 'Reference has no title to search for'});

      // Three public catalogues, asked in parallel. A source that is down, slow,
      // or answering something other than JSON contributes nothing rather than
      // failing the request: enrichment is a best effort by definition.
      const askJSON = async (target) => {
        try {
          const reply = await fetchExternal(target, {
            headers: {'User-Agent': 'MochiLab/1.0 (bibliography enrichment)'},
            timeoutMs: 15_000,
          });
          return reply.ok ? await reply.json() : null;
        } catch {
          return null;
        }
      };

      const encodedTitle = encodeURIComponent(title);
      const [s2Data, crossrefData, dblpData] = await Promise.all([
        askJSON(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedTitle}&limit=1&fields=title,authors,year,venue,externalIds,citationCount,referenceCount,tldr`),
        askJSON(`https://api.crossref.org/works?query=${encodedTitle}&rows=1`),
        askJSON(`https://dblp.org/search/publ/api?q=${encodedTitle}&format=json&h=1`),
      ]);

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

      const sources = {
        semanticScholar: Object.keys(s2Result).length > 0 ? s2Result : null,
        crossref: Object.keys(crossrefResult).length > 0 ? crossrefResult : null,
        dblp: Object.keys(dblpResult).length > 0 ? dblpResult : null,
      };

      return respond(res, 200, {
        key: citationKey,
        current: entry,
        sources,
        merged: mergeMetadataSources(sources),
      });
    } catch (err) {
      return respond(res, 500, {error: 'Enrichment failed. Please try again later.'});
    }
  }

  // ── References: enrich (POST - apply enriched data to references.yaml) ──
  if (req.method === 'POST' && pathname === '/api/references/enrich') {
    if (!canManagePapers) return respond(res, 403, {error: 'You do not have permission to edit papers'});
    if (!rateLimit(`enrich-ref:${req.socket.remoteAddress}`, 10)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody();
      const {key: citationKey, fields} = body;
      if (!citationKey || typeof citationKey !== 'string') return respond(res, 400, {error: 'Missing or invalid key'});
      if (citationKey.length > 200) return respond(res, 400, {error: 'Key too long'});
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return respond(res, 400, {error: 'Missing fields object'});

      const refs = await readPapers();
      if (!refs[citationKey]) return respond(res, 404, {error: `Reference "${citationKey}" not found`});

      // Merge the selected fields into the existing reference
      const allowedFields = ['title', 'authors', 'author', 'year', 'venue', 'doi', 'arxivId', 'url', 'volume', 'issue', 'pages', 'publisher', 'type', 'citationCount', 'referenceCount', 'tldr'];
      for (const [field, value] of Object.entries(fields)) {
        if (allowedFields.includes(field) && value != null) {
          const targetField = field === 'author' ? 'authors' : field;
          if (typeof value === 'string') refs[citationKey][targetField] = sanitize(value).slice(0, 5000);
          else if (Array.isArray(value)) refs[citationKey][targetField] = value.slice(0, 50).map(v => typeof v === 'string' ? sanitize(v).slice(0, 500) : v);
          else refs[citationKey][targetField] = value;
        }
      }

      const stored = paperForStorage(refs[citationKey]);
      await paperRecords.put(citationKey, stored);
      return respond(res, 200, {success: true, entry: normalizePaper(citationKey, stored)});
    } catch (err) {
      return respond(res, 400, {error: 'Invalid request: ' + err.message});
    }
  }

  // ── from server/routes/feeds.js ──
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
      const refs = await readPapers();
      const papers = Object.fromEntries(
        Object.entries(refs).map(([key, entry]) => [key, normalizePaper(key, entry)]),
      );

      if (url.searchParams.get('summary') === '1') {
        const byType = {};
        const byYear = {};
        for (const paper of Object.values(papers)) {
          const type = paper.type || 'misc';
          byType[type] = (byType[type] || 0) + 1;
          if (paper.year) byYear[paper.year] = (byYear[paper.year] || 0) + 1;
        }
        return respond(res, 200, {total: Object.keys(papers).length, byType, byYear});
      }

      // The library page asks for a bounded window. Sending and rendering the
      // entire organization library made a 740-paper collection pay for almost
      // 400 KB of JSON and hundreds of React trees before the first useful
      // row appeared. Keep the no-query response intact for existing API
      // consumers, while the UI gets a small, searchable page.
      if (url.searchParams.has('limit')) {
        const limit = Math.max(1, numericParam(url.searchParams.get('limit'), 40, 100));
        const offset = Math.max(0, numericParam(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER));
        const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
        const tag = url.searchParams.get('tag') || '';
        const all = Object.entries(papers);
        const tags = [...new Set(all.flatMap(([, paper]) => paper.tags || []))]
          .sort((a, b) => a.localeCompare(b));
        const matches = all
          .filter(([, paper]) => !tag || (paper.tags || []).includes(tag))
          .filter(([key, paper]) => !query || [
            key,
            paper.title,
            paper.venue,
            ...(paper.authors || paper.author || []),
            ...(paper.tags || []),
          ].some(value => String(value || '').toLocaleLowerCase().includes(query)))
          .sort(([, a], [, b]) =>
            (b.year || 0) - (a.year || 0)
            || String(a.title || '').localeCompare(String(b.title || '')),
          );
        const page = matches.slice(offset, offset + limit);
        return respond(res, 200, {
          references: Object.fromEntries(page),
          tags,
          total: matches.length,
          libraryTotal: all.length,
          offset,
          limit,
          hasMore: offset + page.length < matches.length,
        });
      }
      return respond(res, 200, {references: papers});
    } catch {
      return respond(res, 200, {references: {}});
    }
  }

  const paperPath = /^\/api\/references\/([^/]+)$/.exec(pathname);
  const paperItemPath = /^\/api\/references\/item\/([^/]+)$/.exec(pathname);
  const pdfPath = /^\/api\/references\/([^/]+)\/pdf$/.exec(pathname);
  const annotationsPath = /^\/api\/references\/([^/]+)\/annotations$/.exec(pathname);
  const annotationPath = /^\/api\/reference-annotations\/([^/]+)$/.exec(pathname);
  const decodeKey = encoded => {
    try { return decodeURIComponent(encoded); } catch { return ''; }
  };

  // A paper detail page needs one row, not the entire organization library.
  if (req.method === 'GET' && paperItemPath) {
    const citationKey = decodeKey(paperItemPath[1]);
    const paper = citationKey ? paperRecords.get(citationKey) : null;
    if (!paper) return respond(res, 404, {error: 'Reference not found'});
    return respond(res, 200, {entry: normalizePaper(citationKey, paper)});
  }

  // ── References: remove one paper and its organization-visible annotations ──
  if (req.method === 'DELETE' && paperPath) {
    if (!canDeletePapers) return respond(res, 403, {error: 'Only a workspace owner may delete papers'});
    const citationKey = decodeKey(paperPath[1]);
    if (!citationKey || !await paperRecords.has(citationKey)) return respond(res, 404, {error: 'Reference not found'});
    for (const item of await annotationRecords.list()) {
      if (item.value?.paperKey === citationKey) await annotationRecords.remove(item.key);
    }
    const file = await fileRecords.get(citationKey);
    if (file?.blobKey) await blobs.remove(file.blobKey);
    await fileRecords.remove(citationKey);
    await paperRecords.remove(citationKey);
    return respond(res, 200, {success: true});
  }

  // ── PDFs: upload and serve the managed file for a paper ──
  if (req.method === 'POST' && pdfPath) {
    if (!canManagePapers) return respond(res, 403, {error: 'You do not have permission to upload PDFs'});
    const citationKey = decodeKey(pdfPath[1]);
    if (!citationKey || !await paperRecords.has(citationKey)) return respond(res, 404, {error: 'Reference not found'});
    try {
      const bytes = await readBytes();
      if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.subarray(0, 5).toString() !== '%PDF-') {
        return respond(res, 400, {error: 'The uploaded file is not a PDF'});
      }
      const saved = await blobs.put(bytes, '.pdf');
      const file = {
        id: crypto.randomUUID(),
        paperKey: citationKey,
        blobKey: saved.key,
        sha256: saved.sha256,
        byteSize: saved.size,
        mimeType: 'application/pdf',
        originalName: sanitize(req.headers['x-file-name'] || 'paper.pdf').slice(0, 255),
        createdBy: caller.userId,
        createdAt: new Date().toISOString(),
      };
      await fileRecords.put(citationKey, file);
      const paper = await paperRecords.get(citationKey);
      await paperRecords.put(citationKey, paperForStorage({
        ...paper,
        pdfUrl: `/api/references/${encodeURIComponent(citationKey)}/pdf`,
      }));
      return respond(res, 201, {success: true, file, pdfUrl: `/api/references/${encodeURIComponent(citationKey)}/pdf`});
    } catch (err) {
      return respond(res, err.status || 400, {error: err.message || 'PDF upload failed'});
    }
  }

  if (req.method === 'GET' && pdfPath) {
    const citationKey = decodeKey(pdfPath[1]);
    const file = citationKey ? await fileRecords.get(citationKey) : null;
    if (!file) return respond(res, 404, {error: 'PDF not found'});
    const bytes = await blobs.read(file.blobKey);
    if (!bytes) return respond(res, 404, {error: 'PDF file is missing'});
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const requestedEnd = range[2] ? Number(range[2]) : bytes.length - 1;
      const end = Math.min(requestedEnd, bytes.length - 1);
      if (!Number.isInteger(start) || start < 0 || start > end) {
        return stream(res, {status: 416, headers: {'Content-Range': `bytes */${bytes.length}`}, body: Buffer.alloc(0)});
      }
      const body = bytes.subarray(start, end + 1);
      return stream(res, {
        status: 206,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(body.length),
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `inline; filename="${file.originalName || 'paper.pdf'}"`,
        },
        body,
      });
    }
    return stream(res, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.length),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${file.originalName || 'paper.pdf'}"`,
      },
      body: bytes,
    });
  }

  // ── Shared PDF annotations ──
  if (req.method === 'GET' && annotationsPath) {
    const citationKey = decodeKey(annotationsPath[1]);
    if (!citationKey || !await paperRecords.has(citationKey)) return respond(res, 404, {error: 'Reference not found'});
    const annotations = (await annotationRecords.values())
      .filter(annotation => annotation.paperKey === citationKey)
      .sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt));
    return respond(res, 200, {annotations});
  }

  if (req.method === 'POST' && annotationsPath) {
    const citationKey = decodeKey(annotationsPath[1]);
    if (!citationKey || !await paperRecords.has(citationKey)) return respond(res, 404, {error: 'Reference not found'});
    try {
      const body = await readBody();
      const page = Number.parseInt(body?.page, 10);
      const note = sanitize(body?.body || '').slice(0, 20_000);
      const quote = sanitize(body?.quote || '').slice(0, 5_000);
      if (!Number.isInteger(page) || page < 1 || page > 100_000) return respond(res, 400, {error: 'A valid PDF page is required'});
      if (!note && !quote) return respond(res, 400, {error: 'An annotation needs a note or quoted text'});
      const id = crypto.randomUUID();
      const annotation = {
        id,
        paperKey: citationKey,
        fileId: (await fileRecords.get(citationKey))?.id || null,
        authorId: caller.userId,
        visibility: 'org',
        page,
        quote,
        body: note,
        color: /^#[0-9a-f]{6}$/i.test(body?.color || '') ? body.color : '#f5c542',
        rects: Array.isArray(body?.rects) ? body.rects.slice(0, 100) : [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await annotationRecords.put(id, annotation);
      return respond(res, 201, {annotation});
    } catch (err) {
      return respond(res, 400, {error: err.message || 'Invalid annotation'});
    }
  }

  if ((req.method === 'PATCH' || req.method === 'DELETE') && annotationPath) {
    const id = decodeKey(annotationPath[1]);
    const annotation = id ? await annotationRecords.get(id) : null;
    if (!annotation) return respond(res, 404, {error: 'Annotation not found'});
    const mayEdit = annotation.authorId === caller.userId || caller.role === 'owner';
    if (!mayEdit) return respond(res, 403, {error: 'Only the annotation author or a workspace owner may change it'});
    if (req.method === 'DELETE') {
      await annotationRecords.remove(id);
      return respond(res, 200, {success: true});
    }
    try {
      const body = await readBody();
      const page = body?.page == null ? annotation.page : Number.parseInt(body.page, 10);
      if (!Number.isInteger(page) || page < 1 || page > 100_000) return respond(res, 400, {error: 'A valid PDF page is required'});
      const next = {
        ...annotation,
        page,
        quote: body?.quote == null ? annotation.quote : sanitize(body.quote).slice(0, 5_000),
        body: body?.body == null ? annotation.body : sanitize(body.body).slice(0, 20_000),
        color: /^#[0-9a-f]{6}$/i.test(body?.color || '') ? body.color : annotation.color,
        updatedAt: new Date().toISOString(),
      };
      if (!next.quote && !next.body) return respond(res, 400, {error: 'An annotation needs a note or quoted text'});
      await annotationRecords.put(id, next);
      return respond(res, 200, {annotation: next});
    } catch (err) {
      return respond(res, 400, {error: err.message || 'Invalid annotation'});
    }
  }

  // ── References: update one protocol record ──
  if (req.method === 'PATCH' && paperPath) {
    if (!canManagePapers) return respond(res, 403, {error: 'You do not have permission to edit papers'});
    if (!rateLimit(`update-ref:${req.socket.remoteAddress}`, 30)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    const encodedKey = paperPath[1];
    let citationKey;
    try {
      citationKey = decodeURIComponent(encodedKey);
    } catch {
      return respond(res, 400, {error: 'Invalid citation key'});
    }
    if (!citationKey || citationKey.includes('/') || citationKey.length > 200) {
      return respond(res, 400, {error: 'Invalid citation key'});
    }
    try {
      const body = await readBody();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, {error: 'Invalid paper'});
      const refs = await readPapers();
      if (!Object.prototype.hasOwnProperty.call(refs, citationKey)) return respond(res, 404, {error: 'Reference not found'});
      const patch = body.authors == null && body.author != null ? {...body, authors: body.author} : body;
      const sanitized = sanitizePaperInput({...refs[citationKey], ...patch}, sanitize);
      const {paper, errors} = validatePaper(sanitized);
      if (errors.length) return respond(res, 400, {error: errors.join('; ')});
      const stored = paperForStorage(paper);
      await paperRecords.put(citationKey, stored);
      return respond(res, 200, {success: true, entry: normalizePaper(citationKey, stored)});
    } catch (err) {
      return respond(res, 400, {error: `Invalid request: ${err.message}`});
    }
  }

  // ── from server/routes/analysis-admin.js ──
  if (req.method === 'GET' && pathname === '/api/references/network') {
    try {
      const network = await cache('citation-network', 60000, async () => {
        // Serve the parsed bibliography from the shared, mtime plus size aware memo
        // instead of re-reading and re-parsing references.yaml on every request.
        // loadReferences swallows a missing or unparseable bibliography and
        // returns {}; reproduce the original parse only when the memo is empty so a
        // genuinely broken or missing file still throws to the catch (500), while a
        // legitimately empty file falls through with refs = {} exactly as before.
        const refs = await readPapers();
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
        const citedIn = {};
        const coCitations = {};

        // The capability reads database documents through the verified request
        // context; it never falls back to the legacy workspace filesystem.
        async function scanCitations() {
          for (const pagePath of await content.walk('.', {extensions: ['.md', '.mdx']})) {
            try {
              const text = await content.read(pagePath);
              if (text == null) continue;
              CITE_RE.lastIndex = 0;
              const pageCites = new Set();
              let m;
              while ((m = CITE_RE.exec(text)) !== null) {
                const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
                for (const key of keys) {
                  if (refs[key]) {
                    pageCites.add(key);
                    if (!citedIn[key]) citedIn[key] = [];
                    citedIn[key].push(pagePath);
                  }
                }
              }
              const citeArray = [...pageCites];
              for (let i = 0; i < citeArray.length; i++) {
                const ci = citeArray[i];
                for (let j = i + 1; j < citeArray.length; j++) {
                  const pair = [ci, citeArray[j]].sort().join('::');
                  coCitations[pair] = (coCitations[pair] || 0) + 1;
                }
              }
            } catch {}
          }
        }
        await scanCitations();

        const mostCited = Object.entries(citedIn)
          .map(([key, pages]) => ({key, title: refs[key]?.title || key, count: pages.length, pages}))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);

        const coCited = Object.entries(coCitations)
          .filter(([, count]) => count > 1)
          .map(([pair, count]) => {
            const [a, b] = pair.split('::');
            return {papers: [a, b], coOccurrences: count};
          })
          .sort((a, b) => b.coOccurrences - a.coOccurrences)
          .slice(0, 20);

        // refs and citedIn are fully built by scanCitations above and are not
        // mutated before this return, so each Object.keys(...).length is a
        // constant. Compute each once and reuse it for the three count fields
        // (uncited is just total minus cited). Named totalRefCount/citedRefCount
        // because refCount is already used by another handler in this file.
        const totalRefCount = Object.keys(refs).length;
        const citedRefCount = Object.keys(citedIn).length;
        return {
          totalReferences: totalRefCount,
          citedReferences: citedRefCount,
          uncitedReferences: totalRefCount - citedRefCount,
          mostCited,
          coCitations: coCited,
        };
      });
      return respond(res, 200, network);
    } catch (error) {
      console.error('[bibliography] citation network analysis failed:', error);
      return respond(res, 500, {error: 'Citation network analysis failed'});
    }
  }

  // ── from server/routes/research-tools.js ──
  if (req.method === 'GET' && pathname === '/api/references/track') {
    const key = url.searchParams.get('key');
    if (!key) return respond(res, 400, {error: 'Missing key param'});
    try {
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const refs = await readPapers();
      const entry = refs[key];
      if (!entry) return respond(res, 404, {error: 'Reference not found'});

      // Extract arXiv ID from URL or explicit field
      const arxivId = entry.arxivId || (entry.url && entry.url.match(ARXIV_ABS_RE)?.[1]) || null;
      if (!arxivId) return respond(res, 200, {published: false, error: 'No arXiv ID found for this reference'});

      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await askCatalogue(fetchExternal, s2Url);

      if (!data) return respond(res, 502, {error: 'Failed to reach Semantic Scholar API'});

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
      return respond(res, 200, result);
    } catch (err) {
      return respond(res, 500, {error: 'Track check failed. Please try again later.'});
    }
  }

  if (req.method === 'POST' && pathname === '/api/references/track') {
    if (!canManagePapers) return respond(res, 403, {error: 'You do not have permission to edit papers'});
    if (!rateLimit(`track-ref:${req.socket.remoteAddress}`, 10)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody();
      const {key} = body;
      if (!key || typeof key !== 'string') return respond(res, 400, {error: 'Missing or invalid key'});

      const refs = await readPapers();
      const entry = refs[key];
      if (!entry) return respond(res, 404, {error: 'Reference not found'});

      const arxivId = entry.arxivId || (entry.url && entry.url.match(ARXIV_ABS_RE)?.[1]) || null;
      if (!arxivId) return respond(res, 400, {error: 'No arXiv ID found for this reference'});

      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await askCatalogue(fetchExternal, s2Url);

      if (!data) return respond(res, 502, {error: 'Failed to reach Semantic Scholar API'});

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

      await paperRecords.put(key, paperForStorage(entry));
      return respond(res, 200, {
        success: true,
        published: !isArxiv,
        venue: !isArxiv ? venue : null,
        tracked: true,
        publishedVenue: entry.publishedVenue || null,
      });
    } catch (err) {
      return respond(res, 500, {error: 'Track update failed. Please try again later.'});
    }
  }

  if (req.method === 'POST' && pathname === '/api/references/track-all') {
    if (!canManagePapers) return respond(res, 403, {error: 'You do not have permission to edit papers'});
    if (!rateLimit(`track-all:${req.socket.remoteAddress}`, 2)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const refs = await readPapers();

      const fetchS2 = arxivId => askCatalogue(
        fetchExternal,
        `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`,
      );

      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      // Find all entries with arXiv IDs that don't have publishedVenue yet
      const toCheck = [];
      for (const [key, entry] of Object.entries(refs)) {
        const arxivId = entry.arxivId || (entry.url && entry.url.match(ARXIV_ABS_RE)?.[1]) || null;
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
        for (const {key} of toCheck) await paperRecords.put(key, paperForStorage(refs[key]));
      }

      return respond(res, 200, {checked: toCheck.length, updated: updatedCount, results});
    } catch (err) {
      return respond(res, 500, {error: 'Batch track failed. Please try again later.'});
    }
  }

  if (req.method === 'POST' && pathname === '/api/references/import-bibtex') {
    if (!canManagePapers) return respond(res, 403, {error: 'You do not have permission to import papers'});
    if (!rateLimit(`import-bibtex:${req.socket.remoteAddress}`, 5)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody();
      const {bibtex} = body;
      if (!bibtex || typeof bibtex !== 'string') return respond(res, 400, {error: 'Missing bibtex string'});
      if (bibtex.length > 500000) return respond(res, 400, {error: 'BibTeX input too large (max 500KB)'});

      const parsed = parseBibtex(bibtex);
      const refs = await readPapers();

      let added = 0;
      let skipped = 0;
      const errors = [];

      for (const {entryType, citationKey, fields} of parsed) {
        try {
          if (refs[citationKey]) {
            skipped++;
            continue;
          }

          const entry = paperForStorage({
            type: mapBibtexEntryType(entryType),
            title: sanitize(fields.title || ''),
            authors: parseBibtexAuthors(fields.author),
            year: fields.year ? parseInt(fields.year, 10) || null : null,
            venue: fields.journal || fields.booktitle || '',
            doi: fields.doi,
            officialUrl: fields.url,
            volume: fields.volume,
            pages: fields.pages,
            source: {type: 'bibtex', id: citationKey, provider: 'import'},
            tags: [],
          });

          refs[citationKey] = entry;
          await paperRecords.put(citationKey, entry);
          added++;
        } catch (err) {
          errors.push({key: citationKey, error: err.message});
        }
      }

      return respond(res, 200, {added, skipped, errors});
    } catch (err) {
      return respond(res, 400, {error: 'BibTeX import failed: ' + err.message});
    }
  }

  if (req.method === 'GET' && pathname === '/api/references/export') {
    try {
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const refs = await readPapers();
      const lines = Object.entries(refs).map(([key, entry]) => paperToBibtex(key, entry));
      const bibtex = lines.join('\n\n') + '\n';
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="references.bib"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      return res.end(bibtex);
    } catch (err) {
      return respond(res, 500, {error: 'Export failed: ' + err.message});
    }
  }
};

/**
 * What this plugin lends the rest of the server. Live paper data stays behind
 * the scoped records capability; the filesystem is not a runtime source.
 */
module.exports.provides = {
  references: {
    buildCitation,
    cleanBibtexValue,
    openPapers: openPaperRecords,
    paperForStorage,
  },
};

module.exports.numericParam = numericParam;
module.exports.UNKNOWN_AUTHORS = UNKNOWN_AUTHORS;
module.exports.READING_ORDER_CITE_RE = READING_ORDER_CITE_RE;
