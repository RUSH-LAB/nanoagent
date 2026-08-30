'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

// ── /api/graph wiki-link regex (module scope, reused per request) ──
// Consumed only through WIKI_LINK_RE.exec(...) in a loop that runs to
// exhaustion, and collectGraphFiles resets WIKI_LINK_RE.lastIndex = 0 before
// each file's loop, so one shared instance is behavior-preserving across files
// and back-to-back requests.
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// ── Export/bundle front-matter + title regexes (module scope, reused per request) ──
// Both are consumed only through String.prototype.match (no /g flag, no lastIndex
// state), so one shared instance each is behavior-preserving and rebuilt 0 times per
// request. The trailing "\n?" and the /m flag are preserved exactly, distinct from the
// no-suffix front-matter pattern used by the /api/graph handler.
const EXPORT_FM_RE = /^---\n([\s\S]*?)\n---\n?/;
const EXPORT_TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;

module.exports = async function graph_trash_files_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Graph: wiki link connections between all pages ──
  if (req.method === 'GET' && pathname === '/api/graph') {
    try {
      // Param-free, deterministic scan (the exact sibling of the already-cached
      // GET /api/graph/export): memoize the whole {nodes, edges} computation under
      // one static key for the TTL while the json() write runs on every request.
      const result = cached('graph-data', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const nodes = [];
        const edges = [];
        const nodeMap = {};

        // Collect all markdown/mdx files
        function collectGraphFiles(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              collectGraphFiles(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              const relPath = path.relative(path.join(PROJECT_ROOT, 'content'), fullPath);
              // Build a route-like id: strip extension, strip trailing /index
              let id = relPath.replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
              if (id.endsWith('/index')) id = id.slice(0, -6);

              // Extract title from frontmatter or first heading
              const content = fs.readFileSync(fullPath, 'utf-8');
              // Strip the extension once; the title seed and the equality guard below reuse it.
              const strippedName = entry.name.replace(/\.(mdx?|md)$/, '');
              let title = strippedName;
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (fmMatch) {
                const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (titleMatch) title = titleMatch[1];
              }
              if (title === strippedName) {
                const headingMatch = content.match(/^#\s+(.+)$/m);
                if (headingMatch) title = headingMatch[1];
              }

              // Determine directory category
              const parts = relPath.split(path.sep);
              let category = parts.length > 1 ? parts[0] : '';
              // For books/X and posts/X, use X as the category
              if ((category === 'books' || category === 'posts') && parts.length > 2) {
                category = parts[1];
              }

              const node = {id, path: relPath, title, category};
              nodes.push(node);
              nodeMap[id] = node;

              // Extract wiki links
              WIKI_LINK_RE.lastIndex = 0;
              let match;
              while ((match = WIKI_LINK_RE.exec(content)) !== null) {
                const target = match[1].trim();
                edges.push({source: id, target});
              }
            }
          }
        }
        collectGraphFiles(contentDir);

        // Resolve edge targets: wiki links use route paths
        // Keep only edges where target matches a known node id (own key of nodeMap)
        const resolvedEdges = [];
        for (const edge of edges) {
          let targetId = edge.target;
          if (Object.prototype.hasOwnProperty.call(nodeMap, targetId)) {
            resolvedEdges.push({source: edge.source, target: targetId});
          } else {
            // Try matching against the last segment(s)
            const slashTarget = '/' + targetId;
            const found = nodes.find(n => n.id.endsWith(targetId) || n.id.endsWith(slashTarget));
            if (found) {
              resolvedEdges.push({source: edge.source, target: found.id});
            }
          }
        }

        return {nodes, edges: resolvedEdges};
      });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, {error: 'Graph generation failed: ' + err.message});
    }
  }

  // ── Trash: permanently empty trash ──
  if (req.method === 'DELETE' && pathname === '/api/trash/empty') {
    if (!rateLimit(`trash-empty:${req.socket.remoteAddress}`, 2)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      if (!fs.existsSync(TRASH_DIR)) return json(res, 200, {success: true, deleted: 0});
      let deleted = 0;
      function countFiles(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
          else deleted++;
        }
      }
      countFiles(TRASH_DIR);
      fs.rmSync(TRASH_DIR, {recursive: true, force: true});
      return json(res, 200, {success: true, deleted});
    } catch {
      return json(res, 500, {error: 'Failed to empty trash'});
    }
  }

  // ── Backlinks: find pages that link to a given page ──
  if (req.method === 'GET' && pathname === '/api/backlinks') {
    const targetPath = url.searchParams.get('path');
    if (!targetPath) return json(res, 400, {error: 'Missing path param'});
    try {
      const backlinks = cached(`backlinks:${targetPath}`, 60000, () => {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const result = [];

      // Derive possible link targets from the file path
      // e.g. "content/docs/math/algebra.md" => match [[algebra]], [[math/algebra]], etc.
      const baseName = path.basename(targetPath, path.extname(targetPath));
      const relFromContent = path.relative('content', targetPath).replace(/\\/g, '/');
      const withoutExt = relFromContent.replace(/\.(md|mdx)$/, '');
      const withoutExtNoDocs = withoutExt.replace(/^docs\//, '');

      // Regex patterns
      const wikiLinkRe = /\[\[([^\]]+)\]\]/g;
      const citationRe = /\[@([^\]]+)\]/g;

      function extractTitle(content) {
        // Try frontmatter title first
        const fmMatch = content.match(/^---\n[\s\S]*?\ntitle:\s*["']?(.+?)["']?\s*\n[\s\S]*?\n---/);
        if (fmMatch) return fmMatch[1];
        // Fall back to first heading
        const headingMatch = content.match(/^#\s+(.+)$/m);
        if (headingMatch) return headingMatch[1];
        return null;
      }

      function scanDir(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            const sourcePath = path.relative(PROJECT_ROOT, fullPath);
            // Don't report self-links
            if (sourcePath === targetPath) continue;
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const sourceTitle = extractTitle(content) || entry.name;

              // Check wiki links [[page]]
              let match;
              wikiLinkRe.lastIndex = 0;
              while ((match = wikiLinkRe.exec(content)) !== null) {
                const linkTarget = match[1].split('|')[0].trim(); // handle [[page|alias]]
                // Match if the link target equals the basename, or the full path without extension
                if (linkTarget === baseName || linkTarget === withoutExt ||
                    linkTarget === withoutExtNoDocs) {
                  result.push({sourcePath, sourceTitle, linkType: 'wikilink'});
                  break;
                }
              }

              citationRe.lastIndex = 0;
              while ((match = citationRe.exec(content)) !== null) {
                const citedKey = match[1].trim();
                if (citedKey === baseName || citedKey === withoutExt) {
                  result.push({sourcePath, sourceTitle, linkType: 'citation'});
                  break;
                }
              }
            } catch {}
          }
        }
      }

      scanDir(contentDir);
      return result;
      });
      return json(res, 200, {backlinks});
    } catch {
      return json(res, 500, {error: 'Backlinks scan failed'});
    }
  }

  // ── Folder: create ──
  if (req.method === 'POST' && pathname === '/api/folder') {
    if (!rateLimit(`create-folder:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: dirPath} = body;
      if (!isValidDir(dirPath)) return json(res, 400, {error: 'Invalid path. Must start with content/'});
      const fullPath = path.join(PROJECT_ROOT, dirPath);
      if (fs.existsSync(fullPath)) return json(res, 409, {error: 'Directory already exists'});
      fs.mkdirSync(fullPath, {recursive: true});
      return json(res, 201, {success: true, path: dirPath});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Folder: delete (empty only) ──
  if (req.method === 'DELETE' && pathname === '/api/folder') {
    if (!rateLimit(`del-folder:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: dirPath} = body;
      if (!isValidDir(dirPath)) return json(res, 400, {error: 'Invalid path. Must start with content/'});
      const normalized = path.normalize(dirPath);
      if (normalized === 'content') return json(res, 400, {error: 'Cannot delete the root content directory'});
      const fullPath = path.join(PROJECT_ROOT, normalized);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'Directory not found'});
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) return json(res, 400, {error: 'Path is not a directory'});
      const entries = fs.readdirSync(fullPath);
      if (entries.length > 0) return json(res, 400, {error: 'Directory is not empty'});
      fs.rmdirSync(fullPath);
      return json(res, 200, {success: true});
    } catch (err) {
      if (err.message === 'Invalid JSON') return json(res, 400, {error: 'Invalid request'});
      return json(res, 500, {error: 'Delete failed'});
    }
  }

  // ── File: move to a different directory ──
  if (req.method === 'POST' && pathname === '/api/file/move') {
    if (!rateLimit(`file-move:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {filePath, targetDir} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid file path'});
      if (!isValidDir(targetDir)) return json(res, 400, {error: 'Invalid target directory. Must start with content/'});
      const fullSource = path.join(PROJECT_ROOT, filePath);
      if (!fs.existsSync(fullSource)) return json(res, 404, {error: 'Source file not found'});
      const baseName = path.basename(filePath);
      const newPath = path.join(targetDir, baseName);
      if (!isValidFilePath(newPath)) return json(res, 400, {error: 'Resulting path is invalid'});
      const fullTarget = path.join(PROJECT_ROOT, newPath);
      if (fs.existsSync(fullTarget)) return json(res, 409, {error: 'A file already exists at the target location'});
      const fullTargetDir = path.join(PROJECT_ROOT, targetDir);
      fs.mkdirSync(fullTargetDir, {recursive: true});
      fs.renameSync(fullSource, fullTarget);
      // A move changes only a file's path, not the file count, so drop the cached
      // flat search list; the content stats stay valid (mirrors files.js rename).
      invalidateCache('search');
      return json(res, 200, {success: true, newPath});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Bundle export: combine multiple files into one document ──
  if (req.method === 'POST' && pathname === '/api/export/bundle') {
    if (!rateLimit(`export-bundle:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {paths, format} = body;
      if (!Array.isArray(paths) || paths.length === 0) return json(res, 400, {error: 'Missing paths array'});
      if (paths.length > 50) return json(res, 400, {error: 'paths exceeds maximum length of 50'});
      if (!paths.every(p => typeof p === 'string')) return json(res, 400, {error: 'All paths must be strings'});
      if (format !== undefined && typeof format !== 'string') return json(res, 400, {error: 'format must be a string'});
      const outputFormat = format || 'md';
      if (!['md', 'html'].includes(outputFormat)) return json(res, 400, {error: 'format must be md or html'});
      const sections = [];
      for (const filePath of paths.slice(0, 20)) {
        if (!isValidFilePath(filePath)) continue;
        try {
          let content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
          let title = path.basename(filePath, path.extname(filePath));
          const fmMatch = content.match(EXPORT_FM_RE);
          if (fmMatch) {
            const tm = fmMatch[1].match(EXPORT_TITLE_RE);
            if (tm) title = tm[1];
            content = content.slice(fmMatch[0].length);
          }
          sections.push({title, content: content.trim(), path: filePath});
        } catch {}
      }
      if (outputFormat === 'md') {
        const md = sections.map(s => `# ${s.title}\n\n${s.content}`).join('\n\n---\n\n');
        res.writeHead(200, {'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="bundle.md"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
        return res.end(md);
      }
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bundle Export</title><style>body{max-width:800px;margin:0 auto;padding:2rem;font-family:sans-serif;line-height:1.6}h1{border-bottom:2px solid #333;padding-bottom:8px}hr{margin:3rem 0}</style></head><body>${sections.map(s => `<h1>${s.title.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</h1>\n${s.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('<hr>')}</body></html>`;
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="bundle.html"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(html);
    } catch {
      return json(res, 400, {error: 'Bundle export failed'});
    }
  }

};

