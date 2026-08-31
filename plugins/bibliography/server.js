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
 * `provides` is the other half of the contract. Core handlers answer questions
 * about the bibliography and need to read references.yaml to do it. Rather than
 * each one reaching into this directory with a relative require, the server
 * hangs what this publishes onto ctx, so those modules ask ctx for bibliography
 * data and degrade honestly when no plugin is providing any.
 */
const {numericParam} = require('#plugin-api');
const {BIB_FILE, loadReferences, readReferencesText, buildCitation, cleanBibtexValue} = require('./lib/references');
const {parseBibtex, parseBibtexAuthors, mapBibtexEntryType, mergeMetadataSources} = require('./lib/bibtex');

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

module.exports = async function bibliography_routes(req, res, url, pathname, api) {
  const {
    respond, stream, readBody, rateLimit, cache,
    // Granted by "content:write" in plugin.json: references.yaml is a content
    // file, and this plugin is the only thing that writes it.
    content,
    // Granted by "network": the enrichment and metadata endpoints ask three
    // public catalogues about a paper. This used to be require('https') and a
    // shelled-out curl.
    fetch: fetchExternal,
    sanitize,
  } = api;

  // ── References: add entry ──
  if (req.method === 'POST' && pathname === '/api/references') {
    if (!rateLimit(`add-ref:${req.socket.remoteAddress}`, 20)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody();
      const {key, entry} = body;
      if (!key || !entry) return respond(res, 400, {error: 'Missing key or entry'});
      if (typeof key !== 'string' || key.length > 200) return respond(res, 400, {error: 'Invalid key'});
      if (typeof entry !== 'object') return respond(res, 400, {error: 'Invalid entry'});
      // Sanitize string fields within the entry object
      const sanitizedEntry = {};
      for (const [field, value] of Object.entries(entry)) {
        if (typeof value === 'string') sanitizedEntry[field] = sanitize(value).slice(0, 5000);
        else if (Array.isArray(value)) sanitizedEntry[field] = value.slice(0, 50).map(v => typeof v === 'string' ? sanitize(v).slice(0, 500) : v);
        else sanitizedEntry[field] = value;
      }
      const refs = yaml.load(readReferencesText(content)) || {};
      if (refs[key]) return respond(res, 409, {error: 'Key already exists'});
      refs[key] = sanitizedEntry;
      content.write(BIB_FILE, yaml.dump(refs, {lineWidth: -1}));
      return respond(res, 201, {success: true});
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

      return respond(res, 200, {results, merged});
    } catch {
      return respond(res, 500, {error: 'Metadata search failed'});
    }
  }

  // ── References: enrich (GET - fetch metadata from multiple sources) ──
  if (req.method === 'GET' && pathname === '/api/references/enrich') {
    const citationKey = url.searchParams.get('key');
    if (!citationKey) return respond(res, 400, {error: 'Missing key param'});

    try {
      const refs = loadReferences(content);
      // The memo answers a missing or broken bibliography with {}, which reads
      // as "no such reference" when it means "no bibliography". Re-read only in
      // that case, so the 500 survives and the populated path never re-parses.
      if (Object.keys(refs).length === 0) readReferencesText(content);
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
    if (!rateLimit(`enrich-ref:${req.socket.remoteAddress}`, 10)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody();
      const {key: citationKey, fields} = body;
      if (!citationKey || typeof citationKey !== 'string') return respond(res, 400, {error: 'Missing or invalid key'});
      if (citationKey.length > 200) return respond(res, 400, {error: 'Key too long'});
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return respond(res, 400, {error: 'Missing fields object'});

      const refs = yaml.load(readReferencesText(content)) || {};
      if (!refs[citationKey]) return respond(res, 404, {error: `Reference "${citationKey}" not found`});

      // Merge the selected fields into the existing reference
      const allowedFields = ['title', 'author', 'year', 'venue', 'doi', 'arxivId', 'url', 'volume', 'issue', 'pages', 'publisher', 'type', 'citationCount', 'referenceCount', 'tldr'];
      for (const [field, value] of Object.entries(fields)) {
        if (allowedFields.includes(field) && value != null) {
          if (typeof value === 'string') refs[citationKey][field] = sanitize(value).slice(0, 5000);
          else if (Array.isArray(value)) refs[citationKey][field] = value.slice(0, 50).map(v => typeof v === 'string' ? sanitize(v).slice(0, 500) : v);
          else refs[citationKey][field] = value;
        }
      }

      content.write(BIB_FILE, yaml.dump(refs, {lineWidth: -1}));
      return respond(res, 200, {success: true, entry: refs[citationKey]});
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
      const refs = loadReferences(content);
      return respond(res, 200, {references: refs});
    } catch {
      return respond(res, 200, {references: {}});
    }
  }

  // ── from server/routes/analysis-admin.js ──
  if (req.method === 'GET' && pathname === '/api/references/network') {
    try {
      const network = cache('citation-network', 60000, () => {
        // Serve the parsed bibliography from the shared, mtime plus size aware memo
        // instead of re-reading and re-parsing references.yaml on every request.
        // loadReferences swallows a missing or unparseable bibliography and
        // returns {}; reproduce the original parse only when the memo is empty so a
        // genuinely broken or missing file still throws to the catch (500), while a
        // legitimately empty file falls through with refs = {} exactly as before.
        const refs = loadReferences(content);
        if (Object.keys(refs).length === 0) {
          const yaml = require('js-yaml');
          yaml.load(readReferencesText(content));
        }
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
        const citedIn = {};
        const coCitations = {};

        // content.walk already skips dotfiles and underscore drafts and returns
        // content-relative paths, so the recursion, the extension filter and the
        // path arithmetic this used to do are all the capability's job now.
        function scanCitations() {
          for (const pagePath of content.walk('.', {extensions: ['.md', '.mdx']})) {
            try {
              const text = content.read(pagePath);
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
        scanCitations();

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
    } catch {
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
      const refs = loadReferences(content);
      // loadReferences swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty; the populated happy path
      // is served entirely from the memo and never re-reads or re-parses.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(readReferencesText(content));
      }
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
    if (!rateLimit(`track-ref:${req.socket.remoteAddress}`, 10)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody();
      const {key} = body;
      if (!key || typeof key !== 'string') return respond(res, 400, {error: 'Missing or invalid key'});

      const refs = yaml.load(readReferencesText(content)) || {};
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

      content.write(BIB_FILE, yaml.dump(refs, {lineWidth: -1}));
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
    if (!rateLimit(`track-all:${req.socket.remoteAddress}`, 2)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(readReferencesText(content)) || {};

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
        content.write(BIB_FILE, yaml.dump(refs, {lineWidth: -1}));
      }

      return respond(res, 200, {checked: toCheck.length, updated: updatedCount, results});
    } catch (err) {
      return respond(res, 500, {error: 'Batch track failed. Please try again later.'});
    }
  }

  if (req.method === 'POST' && pathname === '/api/references/import-bibtex') {
    if (!rateLimit(`import-bibtex:${req.socket.remoteAddress}`, 5)) return respond(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody();
      const {bibtex} = body;
      if (!bibtex || typeof bibtex !== 'string') return respond(res, 400, {error: 'Missing bibtex string'});
      if (bibtex.length > 500000) return respond(res, 400, {error: 'BibTeX input too large (max 500KB)'});

      const parsed = parseBibtex(bibtex);
      let refs;
      try {
        refs = yaml.load(readReferencesText(content)) || {};
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
            title: sanitize(fields.title || ''),
            author: parseBibtexAuthors(fields.author),
            year: fields.year ? parseInt(fields.year, 10) || null : null,
          };

          // Venue: journal for articles, booktitle for proceedings
          const venue = fields.journal || fields.booktitle || '';
          if (venue) entry.venue = sanitize(venue);

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
        content.write(BIB_FILE, yaml.dump(refs, {lineWidth: -1}));
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
      const refs = loadReferences(content);
      // loadReferences swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty; the populated happy path
      // is served entirely from the memo and never re-reads or re-parses.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(readReferencesText(content));
      }
      const lines = [];
      for (const [key, entry] of Object.entries(refs)) {
        const authors = (entry.author || []).join(' and ');
        // The BibTeX entry type is the reference type verbatim; recognized types
        // (article, inproceedings, book) and unknown ones alike pass through, and
        // a missing type defaults to 'misc'.
        const bibtexType = entry.type || 'misc';
        const fields = [];
        fields.push(`  title = {${cleanBibtexValue(entry.title || '')}}`);
        if (authors) fields.push(`  author = {${cleanBibtexValue(authors)}}`);
        if (entry.year) fields.push(`  year = {${cleanBibtexValue(entry.year)}}`);
        if (entry.venue) {
          if (bibtexType === 'inproceedings') fields.push(`  booktitle = {${cleanBibtexValue(entry.venue)}}`);
          else if (bibtexType === 'article') fields.push(`  journal = {${cleanBibtexValue(entry.venue)}}`);
          else fields.push(`  howpublished = {${cleanBibtexValue(entry.venue)}}`);
        }
        if (entry.url) fields.push(`  url = {${cleanBibtexValue(entry.url)}}`);
        if (entry.doi) fields.push(`  doi = {${cleanBibtexValue(entry.doi)}}`);
        if (entry.volume) fields.push(`  volume = {${cleanBibtexValue(entry.volume)}}`);
        if (entry.pages) fields.push(`  pages = {${cleanBibtexValue(entry.pages)}}`);
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
      return respond(res, 500, {error: 'Export failed: ' + err.message});
    }
  }
};

/**
 * What this plugin lends the rest of the server: the bibliography, parsed and
 * memoized. Reaches the core modules as ctx.references, where the server wraps
 * `load` with a reader built from fs so a core handler can keep calling it the
 * way it always has.
 */
module.exports.provides = {
  references: {load: loadReferences, buildCitation, cleanBibtexValue, FILE: BIB_FILE},
};

module.exports.numericParam = numericParam;
module.exports.UNKNOWN_AUTHORS = UNKNOWN_AUTHORS;
module.exports.READING_ORDER_CITE_RE = READING_ORDER_CITE_RE;
