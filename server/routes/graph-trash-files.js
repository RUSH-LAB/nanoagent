'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

// ── /api/file/info content-analysis regexes (module scope, reused per request) ──
// The four g-flag regexes are consumed only through String.prototype.match, which
// resets lastIndex, and the two .test() regexes carry no g flag, so one shared
// instance per pattern is behavior-preserving and needs no lastIndex reset.
const FILE_INFO_CJK_RE = /[一-鿿㐀-䶿豈-﫿]/g;
const FILE_INFO_LATIN_RE = /[a-zA-Z]/g;
const FILE_INFO_CODE_BLOCK_RE = /```/;
const FILE_INFO_MATH_RE = /\$\$|\$[^$\n]+\$/;
const FILE_INFO_CITATION_RE = /\[@[^\]]+\]/g;
const FILE_INFO_IMAGE_RE = /!\[[^\]]*\]/g;

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
// no-suffix front-matter pattern used by the /api/graph and /api/file/info handlers.
const EXPORT_FM_RE = /^---\n([\s\S]*?)\n---\n?/;
const EXPORT_TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;

// ── /api/file/export markdown render regexes (module scope, reused per request) ──
// The pdf, html, latex, and slides branches each rebuilt this chain of markdown
// render regexes inline on every request. Each one carries the /g or /gm flag and
// is consumed ONLY through String.prototype.replace, which sets lastIndex back to 0
// at the start of every global replace, so a single shared instance per pattern is
// behavior-preserving across formats and across back-to-back requests. The pdf,
// html, and latex branches share these patterns (only the replacement strings or
// callbacks differ), so one const per pattern serves all of them.
//
// Two deliberate non-merges:
//   • SLIDES_H2_RE is the NON-global /^## (.+)$/m used by the slides branch (a
//     single replacement per slide). It must stay separate from the global
//     RENDER_H2_RE; merging them would turn one replacement into a global one and
//     change the rendered output.
//   • RENDER_LIST_ITEM_RE (the per-line /^- (.+)$/gm used by slides and latex) is a
//     different pattern from the consecutive-block RENDER_LIST_RE (used by pdf and
//     html); they are not interchangeable.
const RENDER_CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;
const RENDER_H1_RE = /^# (.+)$/gm;
const RENDER_H2_RE = /^## (.+)$/gm;
const RENDER_H3_RE = /^### (.+)$/gm;
const RENDER_BOLD_RE = /\*\*(.+?)\*\*/g;
const RENDER_ITALIC_RE = /\*(.+?)\*/g;
const RENDER_INLINE_CODE_RE = /`([^`]+)`/g;
const RENDER_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const RENDER_LIST_RE = /(^- .+$(\n- .+$)*)/gm;
const RENDER_LIST_ITEM_RE = /^- (.+)$/gm;
const RENDER_PARA_RE = /^(?!<[a-z/])((?!\s*$).+)$/gm;
const RENDER_BLANK_LINES_RE = /\n{3,}/g;
const SLIDES_H2_RE = /^## (.+)$/m;

// ── /api/trash trashed-name parsing regexes (module scope, reused per request) ──
// A trashed file stores its delete timestamp in the name as
// `YYYY-MM-DDTHH-MM-SS-sssZ_originalname.ext`. All three patterns below are
// NON-global and NON-sticky and are consumed only through String.prototype.match
// / String.prototype.replace, so none carries lastIndex state and one shared
// module-scope instance per pattern is byte-identical to the former per-request
// literals. TRASH_NAME_RE is shared by BOTH the GET /api/trash directory walk
// (once per trashed file) and the POST /api/trash/restore handler, deduping the
// one identical literal that previously appeared at both call sites.
const TRASH_NAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/;
const TRASH_TIME_TAIL_RE = /(\d{2})-(\d{2})-(\d{3})Z$/;
const TRASH_TIME_MID_RE = /T(\d{2})-(\d{2})/;

module.exports = async function graph_trash_files_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
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

  // ── Trash: list trashed files ──
  if (req.method === 'GET' && pathname === '/api/trash') {
    try {
      if (!fs.existsSync(TRASH_DIR)) return json(res, 200, {files: []});
      const files = [];
      function walkTrash(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkTrash(fullPath);
          } else {
            const trashRelPath = path.relative(PROJECT_ROOT, fullPath);
            // Extract timestamp and original filename from the trashed name
            // Format: YYYY-MM-DDTHH-MM-SS-sssZ_originalname.md
            const match = entry.name.match(TRASH_NAME_RE);
            if (!match) continue;
            const deletedAt = match[1].replace(TRASH_TIME_TAIL_RE, '$1:$2:$3Z').replace(TRASH_TIME_MID_RE, 'T$1:$2');
            const originalName = match[2];
            // Reconstruct original path: strip .trash/ prefix, use directory structure + original name
            const trashSubDir = path.relative(TRASH_DIR, dir);
            const originalPath = path.join(trashSubDir, originalName);
            files.push({
              trashPath: trashRelPath,
              originalPath,
              originalName,
              deletedAt,
            });
          }
        }
      }
      walkTrash(TRASH_DIR);
      // Sort newest first
      files.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      return json(res, 200, {files});
    } catch {
      return json(res, 500, {error: 'Failed to list trash'});
    }
  }

  // ── Trash: restore a trashed file ──
  if (req.method === 'POST' && pathname === '/api/trash/restore') {
    if (!rateLimit(`trash-restore:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {trashPath} = body;
      if (!trashPath || typeof trashPath !== 'string') return json(res, 400, {error: 'Missing trashPath'});
      const normalized = path.normalize(trashPath);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) return json(res, 400, {error: 'Invalid path'});
      if (!normalized.startsWith('.trash/') && !normalized.startsWith('.trash' + path.sep)) return json(res, 400, {error: 'Path must be within .trash/'});
      const fullTrashPath = path.join(PROJECT_ROOT, normalized);
      if (!fs.existsSync(fullTrashPath)) return json(res, 404, {error: 'Trashed file not found'});
      // Extract original path from trash structure
      const trashedName = path.basename(normalized);
      const match = trashedName.match(TRASH_NAME_RE);
      if (!match) return json(res, 400, {error: 'Invalid trash file format'});
      const originalName = match[2];
      const trashSubDir = path.relative(TRASH_DIR, path.dirname(fullTrashPath));
      const originalPath = path.join(trashSubDir, originalName);
      if (!isValidFilePath(originalPath)) return json(res, 400, {error: 'Cannot restore: original path is invalid'});
      const fullOriginalPath = path.join(PROJECT_ROOT, originalPath);
      if (fs.existsSync(fullOriginalPath)) return json(res, 409, {error: 'A file already exists at the original path. Rename or delete it first.'});
      const dir = path.dirname(fullOriginalPath);
      fs.mkdirSync(dir, {recursive: true});
      fs.renameSync(fullTrashPath, fullOriginalPath);
      // A restored file reappears in the content tree and bumps the file count, the
      // inverse of a delete, so clear both the cached search list and content stats.
      invalidateCache('search');
      invalidateCache('stats');
      return json(res, 200, {success: true, restoredPath: originalPath});
    } catch (err) {
      if (err.message === 'Invalid JSON') return json(res, 400, {error: 'Invalid request'});
      return json(res, 500, {error: 'Restore failed'});
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

  // ── File: info / metadata ──
  if (req.method === 'GET' && pathname === '/api/file/info') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    try {
      // Every returned field is a pure function of the file's on-disk state (its
      // size, stored mtime, and content), so a short TTL snapshot stays byte
      // identical while skipping the repeat stat and read. The isValidFilePath
      // guard and this try/catch stay OUTSIDE the closure, so a missing file
      // still returns 404 and the cached helper stores nothing when fn throws.
      const result = cached('fileinfo:' + filePath, 30000, () => {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const hasFrontmatter = !!fmMatch;
        let draft = false;
        if (fmMatch) {
          const draftMatch = fmMatch[1].match(/^draft:\s*(.+)$/m);
          if (draftMatch) draft = draftMatch[1].trim() === 'true';
        }
        // ── Content language detection ──
        // Count CJK characters (Chinese/Japanese/Korean unified ideographs + extensions)
        const cjkCount = (content.match(FILE_INFO_CJK_RE) || []).length;
        // Count Latin letter characters
        const latinCount = (content.match(FILE_INFO_LATIN_RE) || []).length;
        const totalLetters = cjkCount + latinCount;
        let detectedLanguage = 'mixed';
        if (totalLetters > 0) {
          const cjkRatio = cjkCount / totalLetters;
          const latinRatio = latinCount / totalLetters;
          if (cjkRatio > 0.3) detectedLanguage = 'chinese';
          else if (latinRatio > 0.7) detectedLanguage = 'english';
        }

        // ── Content feature detection ──
        const hasCodeBlocks = FILE_INFO_CODE_BLOCK_RE.test(content);
        const hasMath = FILE_INFO_MATH_RE.test(content);
        const citationCount = (content.match(FILE_INFO_CITATION_RE) || []).length;
        const imageCount = (content.match(FILE_INFO_IMAGE_RE) || []).length;

        return {
          path: filePath,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          wordCount,
          hasFrontmatter,
          draft,
          detectedLanguage,
          hasCodeBlocks,
          hasMath,
          citationCount,
          imageCount,
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
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

  // ── Export file as markdown or HTML ──
  if (req.method === 'GET' && pathname === '/api/file/export') {
    const filePath = url.searchParams.get('path');
    const format = url.searchParams.get('format');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    if (!['md', 'html', 'pdf', 'latex', 'slides'].includes(format)) return json(res, 400, {error: 'Invalid format. Must be md, html, pdf, latex, or slides'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const baseName = path.basename(filePath, path.extname(filePath));

      if (format === 'md') {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${baseName}.md"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(content);
      }

      // format === 'slides' — HTML slide deck
      if (format === 'slides') {
        let markdown = content;
        let title = baseName;
        const fmMatch = markdown.match(EXPORT_FM_RE);
        if (fmMatch) {
          const fm = fmMatch[1];
          const tm = fm.match(EXPORT_TITLE_RE);
          if (tm) title = tm[1];
          markdown = markdown.slice(fmMatch[0].length);
        }
        const slides = markdown.split(/\n(?=## )/).filter(s => s.trim());
        const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const slideHtml = slides.map((s, i) => {
          let html = s.replace(SLIDES_H2_RE, '<h2>$1</h2>').replace(RENDER_H3_RE, '<h3>$1</h3>');
          html = html.replace(RENDER_BOLD_RE, '<strong>$1</strong>').replace(RENDER_ITALIC_RE, '<em>$1</em>');
          html = html.replace(RENDER_INLINE_CODE_RE, '<code>$1</code>');
          html = html.replace(RENDER_LIST_ITEM_RE, '<li>$1</li>');
          html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
          html = html.replace(RENDER_PARA_RE, '<p>$1</p>');
          return `<section class="slide" id="slide-${i}">\n${html.trim()}\n</section>`;
        }).join('\n');
        const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee}
.slide{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:4rem 8rem;border-bottom:1px solid #333}
h2{font-size:2.5rem;margin-bottom:1.5rem;color:#e94560}h3{font-size:1.5rem;margin:1rem 0;color:#0f3460}
p{font-size:1.2rem;line-height:1.8;margin:0.5rem 0}ul{margin:1rem 0 1rem 2rem}li{font-size:1.1rem;margin:0.3rem 0}
code{background:#16213e;padding:2px 6px;border-radius:3px;font-size:0.95em}
strong{color:#e94560}em{color:#0f3460}
nav{position:fixed;bottom:20px;right:20px;display:flex;gap:8px}
nav button{background:#16213e;color:#eee;border:1px solid #333;padding:8px 16px;cursor:pointer;border-radius:4px;font-size:0.9rem}
</style></head><body>
<section class="slide" id="slide-title" style="text-align:center"><h1 style="font-size:3rem;color:#e94560">${safeTitle}</h1><p style="font-size:1.3rem;color:#888">${slides.length} slides</p></section>
${slideHtml}
<nav><button onclick="prev()">Prev</button><button onclick="next()">Next</button></nav>
<script>
let cur=0;const slides=document.querySelectorAll('.slide');
function show(i){slides.forEach((s,j)=>s.style.display=j===i?'flex':'none');cur=i}
function next(){show(Math.min(cur+1,slides.length-1))}function prev(){show(Math.max(cur-1,0))}
show(0);document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')next();if(e.key==='ArrowLeft')prev()});
</script></body></html>`;
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${baseName}-slides.html"`, 'Access-Control-Allow-Origin': '*'});
        return res.end(fullHtml);
      }

      // format === 'latex' — convert to LaTeX
      if (format === 'latex') {
        let markdown = content;
        let title = baseName;
        let authors = '';
        const fmMatch = markdown.match(EXPORT_FM_RE);
        if (fmMatch) {
          const fm = fmMatch[1];
          const tm = fm.match(EXPORT_TITLE_RE);
          if (tm) title = tm[1];
          const am = fm.match(/^authors?:\s*\[([^\]]*)\]/m);
          if (am) authors = am[1].split(',').map(a => a.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).join(' \\and ');
          markdown = markdown.slice(fmMatch[0].length);
        }
        let latex = markdown;
        latex = latex.replace(RENDER_H1_RE, '\\section{$1}');
        latex = latex.replace(RENDER_H2_RE, '\\subsection{$1}');
        latex = latex.replace(RENDER_H3_RE, '\\subsubsection{$1}');
        latex = latex.replace(RENDER_BOLD_RE, '\\textbf{$1}');
        latex = latex.replace(RENDER_ITALIC_RE, '\\textit{$1}');
        latex = latex.replace(RENDER_INLINE_CODE_RE, '\\texttt{$1}');
        latex = latex.replace(RENDER_CODE_BLOCK_RE, (_, lang, code) => `\\begin{verbatim}\n${code}\\end{verbatim}`);
        latex = latex.replace(RENDER_LINK_RE, '\\href{$2}{$1}');
        latex = latex.replace(RENDER_LIST_ITEM_RE, '\\item $1');
        const safeTitle = title.replace(/[&%$#_{}~^\\]/g, s => '\\' + s);
        const fullLatex = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{hyperref}
\\title{${safeTitle}}
${authors ? `\\author{${authors}}` : ''}
\\date{\\today}
\\begin{document}
\\maketitle
${latex.trim()}
\\end{document}
`;
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${baseName}.tex"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(fullLatex);
      }

      // format === 'pdf' — print-optimized HTML with embedded styles
      if (format === 'pdf') {
        let markdown = content;
        let title = baseName;
        const fmMatch = markdown.match(EXPORT_FM_RE);
        if (fmMatch) {
          const fm = fmMatch[1];
          const titleMatch = fm.match(EXPORT_TITLE_RE);
          if (titleMatch) title = titleMatch[1];
          markdown = markdown.slice(fmMatch[0].length);
        }
        let html = markdown;
        html = html.replace(RENDER_CODE_BLOCK_RE, (_, lang, code) => {
          const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<pre><code>${escaped}</code></pre>`;
        });
        html = html.replace(RENDER_H3_RE, '<h3>$1</h3>');
        html = html.replace(RENDER_H2_RE, '<h2>$1</h2>');
        html = html.replace(RENDER_H1_RE, '<h1>$1</h1>');
        html = html.replace(RENDER_BOLD_RE, '<strong>$1</strong>');
        html = html.replace(RENDER_ITALIC_RE, '<em>$1</em>');
        html = html.replace(RENDER_INLINE_CODE_RE, '<code>$1</code>');
        html = html.replace(RENDER_LINK_RE, '<a href="$2">$1</a>');
        html = html.replace(RENDER_LIST_RE, (match) => {
          const items = match.split('\n').map(line => `<li>${line.slice(2)}</li>`).join('\n');
          return `<ul>\n${items}\n</ul>`;
        });
        html = html.replace(RENDER_PARA_RE, '<p>$1</p>');
        html = html.replace(RENDER_BLANK_LINES_RE, '\n\n');
        const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
@page { size: A4; margin: 2cm; }
body { max-width: 700px; margin: 0 auto; padding: 2rem 1rem; font-family: "Times New Roman", Georgia, serif; font-size: 12pt; line-height: 1.8; color: #111; }
h1 { font-size: 20pt; margin-top: 0; border-bottom: 2px solid #333; padding-bottom: 8px; }
h2 { font-size: 16pt; margin-top: 1.5em; }
h3 { font-size: 13pt; margin-top: 1.2em; }
pre { background: #f5f5f5; padding: 12px; overflow-x: auto; border: 1px solid #ddd; font-size: 10pt; }
code { background: #f0f0f0; padding: 1px 4px; border-radius: 2px; font-size: 10pt; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1rem; color: #555; }
a { color: #1a0dab; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
@media print {
  body { max-width: none; padding: 0; }
  a { color: inherit; text-decoration: none; }
  pre { border: 1px solid #ccc; }
}
</style>
</head>
<body>
${html.trim()}
<footer style="margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ccc; font-size: 9pt; color: #888;">
Generated from Mochi Lab &mdash; ${new Date().toLocaleDateString()}
</footer>
</body>
</html>`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${baseName}-print.html"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(fullHtml);
      }

      // format === 'html'
      // Strip frontmatter
      let markdown = content;
      let title = baseName;
      const fmMatch = markdown.match(EXPORT_FM_RE);
      if (fmMatch) {
        const fm = fmMatch[1];
        const titleMatch = fm.match(EXPORT_TITLE_RE);
        if (titleMatch) title = titleMatch[1];
        markdown = markdown.slice(fmMatch[0].length);
      }

      // Convert markdown to basic HTML
      let html = markdown;

      // Code blocks (``` ... ```) — must come before inline code
      html = html.replace(RENDER_CODE_BLOCK_RE, (_, lang, code) => {
        const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`;
      });

      // Headings
      html = html.replace(RENDER_H3_RE, '<h3>$1</h3>');
      html = html.replace(RENDER_H2_RE, '<h2>$1</h2>');
      html = html.replace(RENDER_H1_RE, '<h1>$1</h1>');

      // Bold and italic
      html = html.replace(RENDER_BOLD_RE, '<strong>$1</strong>');
      html = html.replace(RENDER_ITALIC_RE, '<em>$1</em>');

      // Inline code
      html = html.replace(RENDER_INLINE_CODE_RE, '<code>$1</code>');

      // Links
      html = html.replace(RENDER_LINK_RE, '<a href="$2">$1</a>');

      // Unordered lists: collect consecutive lines starting with "- "
      html = html.replace(RENDER_LIST_RE, (match) => {
        const items = match.split('\n').map(line => `<li>${line.slice(2)}</li>`).join('\n');
        return `<ul>\n${items}\n</ul>`;
      });

      // Paragraphs: wrap remaining non-empty, non-tag lines
      html = html.replace(RENDER_PARA_RE, '<p>$1</p>');

      // Clean up multiple blank lines
      html = html.replace(RENDER_BLANK_LINES_RE, '\n\n');

      const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
<style>
body { max-width: 800px; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; }
pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 4px; }
code { background: #f0f0f0; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 1rem; color: #666; }
a { color: #2563eb; }
</style>
</head>
<body>
${html.trim()}
</body>
</html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${baseName}.html"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(fullHtml);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

};

// ── File-export render regexes: exported for the render-regex-hoist regression
// test, which pins each .source/.flags (including that SLIDES_H2_RE stays
// non-global) and drives GET /api/file/export per format to prove the rendered
// payloads are byte-for-byte unchanged. Not part of the route contract.
module.exports.RENDER_CODE_BLOCK_RE = RENDER_CODE_BLOCK_RE;
module.exports.RENDER_H1_RE = RENDER_H1_RE;
module.exports.RENDER_H2_RE = RENDER_H2_RE;
module.exports.RENDER_H3_RE = RENDER_H3_RE;
module.exports.RENDER_BOLD_RE = RENDER_BOLD_RE;
module.exports.RENDER_ITALIC_RE = RENDER_ITALIC_RE;
module.exports.RENDER_INLINE_CODE_RE = RENDER_INLINE_CODE_RE;
module.exports.RENDER_LINK_RE = RENDER_LINK_RE;
module.exports.RENDER_LIST_RE = RENDER_LIST_RE;
module.exports.RENDER_LIST_ITEM_RE = RENDER_LIST_ITEM_RE;
module.exports.RENDER_PARA_RE = RENDER_PARA_RE;
module.exports.RENDER_BLANK_LINES_RE = RENDER_BLANK_LINES_RE;
module.exports.SLIDES_H2_RE = SLIDES_H2_RE;

// ── Trash name-parsing regexes: exported for the trashname-re-hoist regression
// test, which pins each .source/.flags and drives GET /api/trash + POST
// /api/trash/restore to prove the parsed originalName / deletedAt are unchanged
// and that one shared TRASH_NAME_RE instance backs both call sites. Not part of
// the route contract.
module.exports.TRASH_NAME_RE = TRASH_NAME_RE;
module.exports.TRASH_TIME_TAIL_RE = TRASH_TIME_TAIL_RE;
module.exports.TRASH_TIME_MID_RE = TRASH_TIME_MID_RE;
